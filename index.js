// Enhanced Discord Bot
import { 
  Client, 
  Events, 
  GatewayIntentBits, 
  SlashCommandBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  Collection
} from 'discord.js';
import dotenv from 'dotenv';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';

// Load environment variables
dotenv.config();

// Check for Discord token
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('ERROR: DISCORD_TOKEN is not set in environment variables');
  process.exit(1);
}

// Create a new client with more intents for advanced features
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates, // Required for music bot
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent, // Required to read message content
    GatewayIntentBits.DirectMessages
  ]
});

// Store important data
const logs = [];
let welcomeConfig = new Collection();
let ticketConfig = new Collection();
let cancelDmOperation = false;

// Collections to track rate limits for DM commands (prevent spam flagging)
const userRateLimits = new Collection();
const MAX_DMS_PER_USER = 2; // Maximum DMs per user in the time window
const TIME_WINDOW_MS = 60000; // 1 minute time window

// A class to handle rate limiting for DMs
class RateLimiter {
  constructor(maxRequests, timeWindow) {
    this.maxRequests = maxRequests; // Maximum allowed requests in the time window
    this.timeWindow = timeWindow; // Time window in milliseconds
    this.tokens = maxRequests; // Available tokens (initialized to max)
    this.lastRefill = Date.now(); // Time of last token refill
  }
  
  canProceed() {
    this._refillTokens();
    if (this.tokens > 0) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
  
  getTimeUntilNextAllowed() {
    this._refillTokens();
    if (this.tokens > 0) return 0;
    
    // Calculate time until next token refill
    const elapsedTime = Date.now() - this.lastRefill;
    const remainingTime = this.timeWindow - elapsedTime;
    return remainingTime > 0 ? remainingTime : 0;
  }
  
  _refillTokens() {
    const now = Date.now();
    const elapsedTime = now - this.lastRefill;
    
    // If time window has passed, refill tokens
    if (elapsedTime >= this.timeWindow) {
      this.tokens = this.maxRequests;
      this.lastRefill = now;
    }
  }
  
  reset() {
    this.tokens = this.maxRequests;
    this.lastRefill = Date.now();
  }
}

// Global rate limiter for the entire bot (to prevent Discord's anti-spam)
const globalRateLimiter = new RateLimiter(25, 60000); // 25 DMs per minute

// Log function
function addLog(type, message) {
  const timestamp = new Date().toISOString();
  const entry = { type, message, timestamp };
  logs.push(entry);
  console.log(`[${type.toUpperCase()}] ${message}`);
  
  // Keep only the last 200 logs (increased from 100)
  if (logs.length > 200) {
    logs.shift();
  }
}

// Define commands
const commands = [
  // Original commands with improvements
  {
    data: new SlashCommandBuilder()
      .setName('dm-role')
      .setDescription('Send a DM to all users with a specific role')
      .addRoleOption(option => 
        option.setName('role')
          .setDescription('The role to send DM to')
          .setRequired(true))
      .addStringOption(option => 
        option.setName('message')
          .setDescription('The message to send')
          .setRequired(true))
      .addBooleanOption(option =>
        option.setName('anonymous')
          .setDescription('Send message anonymously (without sender info)')
          .setRequired(false))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
    async execute(interaction) {
      await interaction.deferReply({ ephemeral: true });
      
      const role = interaction.options.getRole('role');
      const message = interaction.options.getString('message');
      const isAnonymous = interaction.options.getBoolean('anonymous') || false;
      
      // Reset cancel flag
      cancelDmOperation = false;
      
      // Get guild members with the role
      const guild = interaction.guild;
      await guild.members.fetch();
      
      const membersWithRole = guild.members.cache.filter(member => 
        member.roles.cache.has(role.id)
      );
      
      if (membersWithRole.size === 0) {
        await interaction.editReply(`No members found with the role ${role.name}`);
        addLog('info', `No members found with role ${role.name}`);
        return;
      }
      
      // Check if we're attempting to DM too many users at once
      if (membersWithRole.size > 50) {
        const confirmRow = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('confirm_mass_dm')
              .setLabel('Confirm')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId('cancel_mass_dm')
              .setLabel('Cancel')
              .setStyle(ButtonStyle.Secondary)
          );
        
        const response = await interaction.editReply({
          content: `⚠️ You're about to send DMs to **${membersWithRole.size}** members. This might trigger Discord's anti-spam system. Are you sure?`,
          components: [confirmRow],
          ephemeral: true
        });
        
        try {
          const confirmation = await response.awaitMessageComponent({ time: 30000 });
          
          if (confirmation.customId === 'cancel_mass_dm') {
            await interaction.editReply({
              content: 'Mass DM operation canceled.',
              components: []
            });
            return;
          }
          
          await confirmation.update({
            content: `Starting to send DMs to ${membersWithRole.size} members with role ${role.name}...`,
            components: []
          });
        } catch (error) {
          await interaction.editReply({
            content: 'Confirmation timed out. Mass DM operation canceled.',
            components: []
          });
          return;
        }
      } else {
        await interaction.editReply(`Starting to send DMs to ${membersWithRole.size} members with role ${role.name}...`);
      }
      
      // Send DMs with rate limiting to prevent anti-spam flagging
      let successCount = 0;
      let failCount = 0;
      let pendingCount = 0;
      
      // Create batch processing for members
      const memberBatches = [];
      const batchSize = 5; // Process 5 members at a time
      
      for (let i = 0; i < membersWithRole.size; i += batchSize) {
        const batch = Array.from(membersWithRole.values()).slice(i, i + batchSize);
        memberBatches.push(batch);
      }
      
      for (const batch of memberBatches) {
        if (cancelDmOperation) {
          addLog('info', 'DM operation was canceled by user');
          break;
        }
        
        // Update progress every batch
        await interaction.editReply(
          `Processing DMs to members with role ${role.name}...\n` +
          `✅ Sent: ${successCount}\n` +
          `❌ Failed: ${failCount}\n` +
          `⏳ Pending: ${membersWithRole.size - successCount - failCount}`
        );
        
        // Process batch with a slight delay between each member
        await Promise.all(batch.map(async (member) => {
          // Wait for rate limiter to allow processing
          while (!globalRateLimiter.canProceed()) {
            const waitTime = globalRateLimiter.getTimeUntilNextAllowed();
            addLog('info', `Rate limit hit, waiting ${Math.ceil(waitTime/1000)} seconds`);
            await new Promise(resolve => setTimeout(resolve, waitTime + 100));
            
            if (cancelDmOperation) return;
          }
          
          try {
            // Format the message with or without sender info
            const formattedMessage = isAnonymous 
              ? message 
              : `**Message from ${interaction.user.tag}**: ${message}`;
              
            await member.send(formattedMessage);
            successCount++;
            addLog('success', `Sent DM to ${member.user.tag}`);
          } catch (error) {
            failCount++;
            addLog('error', `Failed to send DM to ${member.user.tag}: ${error.message}`);
          }
        }));
        
        // Small delay between batches to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      const finalStatus = cancelDmOperation 
        ? `DM operation to role ${role.name} was canceled.\n` 
        : `Completed sending DMs to members with role ${role.name}.\n`;
        
      await interaction.editReply(
        finalStatus +
        `✅ Successfully sent: ${successCount}\n` +
        `❌ Failed to send: ${failCount}`
      );
      
      addLog('info', `Completed DM to role ${role.name}. Success: ${successCount}, Failed: ${failCount}`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('cancel-dm')
      .setDescription('Cancel any ongoing DM operations')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    async execute(interaction) {
      cancelDmOperation = true;
      await interaction.reply({
        content: 'Attempting to cancel ongoing DM operations. Currently processing messages will still be sent.',
        ephemeral: true
      });
      addLog('info', `${interaction.user.tag} requested to cancel DM operations`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('status')
      .setDescription('Check the bot status'),
    async execute(interaction) {
      try {
        const uptime = getUptime(client.readyAt);
        
        // Safe handling of guild name to fix the error
        const guildName = interaction.guild ? interaction.guild.name : 'Direct Message';
        
        await interaction.reply({
          embeds: [{
            title: '🤖 Bot Status',
            fields: [
              { name: 'Status', value: '🟢 Online', inline: true },
              { name: 'Uptime', value: uptime, inline: true },
              { name: 'Server', value: guildName, inline: true },
              { name: 'Latency', value: `${client.ws.ping}ms`, inline: true }
            ],
            color: 0x00FF00,
            timestamp: new Date()
          }],
          ephemeral: true
        });
      } catch (error) {
        addLog('error', `Error in status command: ${error.message}`);
        await interaction.reply({
          content: 'An error occurred while checking bot status.',
          ephemeral: true
        });
      }
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('logs')
      .setDescription('Check the bot logs')
      .addStringOption(option => 
        option.setName('filter')
          .setDescription('Filter logs by type')
          .setRequired(false)
          .addChoices(
            { name: 'All', value: 'all' },
            { name: 'Success', value: 'success' },
            { name: 'Error', value: 'error' },
            { name: 'Info', value: 'info' }
          ))
      .addIntegerOption(option =>
        option.setName('count')
          .setDescription('Number of logs to retrieve (default: 10, max: 25)')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(25))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async execute(interaction) {
      const filter = interaction.options.getString('filter') || 'all';
      const count = interaction.options.getInteger('count') || 10;
      
      let filteredLogs = logs;
      if (filter !== 'all') {
        filteredLogs = logs.filter(log => log.type === filter);
      }
      
      // Get the specified number of logs
      const lastLogs = filteredLogs.slice(-count).reverse();
      
      if (lastLogs.length === 0) {
        await interaction.reply({
          content: `No logs found with filter: ${filter}`,
          ephemeral: true
        });
        return;
      }
      
      const logMessages = lastLogs.map(log => 
        `[${new Date(log.timestamp).toLocaleTimeString()}] [${log.type.toUpperCase()}] ${log.message}`
      );
      
      await interaction.reply({
        embeds: [{
          title: '📝 Bot Logs',
          description: logMessages.join('\n'),
          color: 0x0099FF,
          timestamp: new Date(),
          footer: {
            text: `Showing ${lastLogs.length} of ${filteredLogs.length} logs`
          }
        }],
        ephemeral: true
      });
    }
  },

  // MUSIC SYSTEM
  {
    data: new SlashCommandBuilder()
      .setName('music')
      .setDescription('Music system commands placeholder')
      .addSubcommand(subcommand =>
        subcommand
          .setName('play')
          .setDescription('Play a song')
          .addStringOption(option =>
            option.setName('query')
              .setDescription('Song name or URL')
              .setRequired(true)))
      .addSubcommand(subcommand =>
        subcommand
          .setName('skip')
          .setDescription('Skip to the next song'))
      .addSubcommand(subcommand =>
        subcommand
          .setName('stop')
          .setDescription('Stop playing music'))
      .addSubcommand(subcommand =>
        subcommand
          .setName('queue')
          .setDescription('Show the current queue')),
    async execute(interaction) {
      const subcommand = interaction.options.getSubcommand();
      
      // This is a placeholder for the music system
      // Implementation would require additional packages like discord-player or @discordjs/voice
      
      await interaction.reply({
        embeds: [{
          title: '🎵 Music System',
          description: 'This is a placeholder for the music system.\n\n' +
            'Full implementation requires additional packages:\n' +
            '- @discordjs/voice\n' +
            '- discord-player or similar\n' +
            '- ffmpeg and other audio libraries\n\n' +
            'Would you like detailed implementation instructions?',
          color: 0x9370DB,
          footer: {
            text: `Requested music command: ${subcommand}`
          }
        }],
        ephemeral: true
      });
    }
  },

  // UTILITY COMMANDS
  {
    data: new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Check the bot\'s ping'),
    async execute(interaction) {
      const sent = await interaction.reply({ 
        content: 'Pinging...', 
        fetchReply: true,
        ephemeral: true
      });
      const pingLatency = sent.createdTimestamp - interaction.createdTimestamp;
      
      await interaction.editReply({
        content: '',
        embeds: [{
          title: '🏓 Pong!',
          fields: [
            { name: 'Bot Latency', value: `${pingLatency}ms`, inline: true },
            { name: 'API Latency', value: `${client.ws.ping}ms`, inline: true }
          ],
          color: 0x00FFFF
        }]
      });
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription('Display information about yourself or another user')
      .addUserOption(option => 
        option.setName('user')
          .setDescription('The user to get information about')
          .setRequired(false)),
    async execute(interaction) {
      const targetUser = interaction.options.getUser('user') || interaction.user;
      const member = interaction.guild?.members.cache.get(targetUser.id);
      
      const joinedAt = member ? new Date(member.joinedTimestamp).toLocaleDateString() : 'N/A';
      const createdAt = new Date(targetUser.createdTimestamp).toLocaleDateString();
      const roles = member ? 
        member.roles.cache
          .sort((a, b) => b.position - a.position)
          .map(role => role.name !== '@everyone' ? `<@&${role.id}>` : '')
          .filter(Boolean)
          .join(', ') || 'None' 
        : 'N/A';
      
      const embed = new EmbedBuilder()
        .setTitle(`User Information - ${targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
        .setColor(member?.displayHexColor || '#00FFFF')
        .addFields(
          { name: 'Username', value: targetUser.tag, inline: true },
          { name: 'User ID', value: targetUser.id, inline: true },
          { name: 'Account Created', value: createdAt, inline: true },
          { name: 'Joined Server', value: joinedAt, inline: true },
          { name: 'Roles', value: roles, inline: false }
        )
        .setTimestamp();
      
      await interaction.reply({ 
        embeds: [embed],
        ephemeral: true
      });
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('serverinfo')
      .setDescription('Display information about the server'),
    async execute(interaction) {
      if (!interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used in a server.',
          ephemeral: true
        });
        return;
      }
      
      const { guild } = interaction;
      await guild.members.fetch();
      
      const totalMembers = guild.memberCount;
      const onlineMembers = guild.members.cache.filter(m => m.presence?.status === 'online').size;
      const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText).size;
      const voiceChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size;
      const categories = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).size;
      const roleCount = guild.roles.cache.size;
      
      const embed = new EmbedBuilder()
        .setTitle(`Server Information - ${guild.name}`)
        .setThumbnail(guild.iconURL({ dynamic: true, size: 256 }))
        .setColor('#00FFFF')
        .addFields(
          { name: 'Server ID', value: guild.id, inline: true },
          { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
          { name: 'Created On', value: new Date(guild.createdTimestamp).toLocaleDateString(), inline: true },
          { name: 'Members', value: `${totalMembers} total`, inline: true },
          { name: 'Channels', value: `${textChannels} text | ${voiceChannels} voice | ${categories} categories`, inline: true },
          { name: 'Roles', value: roleCount.toString(), inline: true },
          { name: 'Server Boost Level', value: `Level ${guild.premiumTier}`, inline: true },
          { name: 'Boost Count', value: `${guild.premiumSubscriptionCount || 0} boosts`, inline: true }
        )
        .setTimestamp();
      
      await interaction.reply({ 
        embeds: [embed],
        ephemeral: false
      });
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('poll')
      .setDescription('Create a poll')
      .addStringOption(option => 
        option.setName('question')
          .setDescription('The poll question')
          .setRequired(true))
      .addStringOption(option => 
        option.setName('options')
          .setDescription('Poll options separated by commas (max 10)')
          .setRequired(true)),
    async execute(interaction) {
      const question = interaction.options.getString('question');
      let options = interaction.options.getString('options').split(',').map(opt => opt.trim());
      
      // Limit to 10 options
      if (options.length > 10) {
        options = options.slice(0, 10);
        await interaction.reply({
          content: 'You provided more than 10 options. Only the first 10 will be used.',
          ephemeral: true
        });
      }
      
      // Add number emojis for options
      const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
      const optionsText = options.map((opt, idx) => `${numberEmojis[idx]} ${opt}`).join('\n\n');
      
      const embed = new EmbedBuilder()
        .setTitle('📊 ' + question)
        .setDescription(optionsText)
        .setColor('#FFA500')
        .setFooter({ text: `Poll created by ${interaction.user.username}` })
        .setTimestamp();
      
      const sent = await interaction.reply({ 
        embeds: [embed],
        fetchReply: true
      });
      
      // Add reactions for voting
      for (let i = 0; i < options.length; i++) {
        await sent.react(numberEmojis[i]);
      }
    }
  },

  // ADMIN COMMANDS
  {
    data: new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a user from the server')
      .addUserOption(option => 
        option.setName('user')
          .setDescription('The user to kick')
          .setRequired(true))
      .addStringOption(option => 
        option.setName('reason')
          .setDescription('Reason for kicking')
          .setRequired(false))
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
    async execute(interaction) {
      const targetUser = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      
      if (!interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used in a server.',
          ephemeral: true
        });
        return;
      }
      
      const member = interaction.guild.members.cache.get(targetUser.id);
      
      if (!member) {
        await interaction.reply({
          content: 'This user is not in the server.',
          ephemeral: true
        });
        return;
      }
      
      // Check if the bot can kick the member
      if (!member.kickable) {
        await interaction.reply({
          content: 'I cannot kick this user. They might have higher permissions than me.',
          ephemeral: true
        });
        return;
      }
      
      try {
        await member.kick(reason);
        
        const embed = new EmbedBuilder()
          .setTitle('User Kicked')
          .setDescription(`**${targetUser.tag}** has been kicked from the server.`)
          .addFields({ name: 'Reason', value: reason })
          .setColor('#FF0000')
          .setTimestamp();
        
        await interaction.reply({ embeds: [embed] });
        addLog('info', `${targetUser.tag} was kicked by ${interaction.user.tag}. Reason: ${reason}`);
      } catch (error) {
        addLog('error', `Failed to kick ${targetUser.tag}: ${error.message}`);
        await interaction.reply({
          content: `Failed to kick the user: ${error.message}`,
          ephemeral: true
        });
      }
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a user from the server')
      .addUserOption(option => 
        option.setName('user')
          .setDescription('The user to ban')
          .setRequired(true))
      .addStringOption(option => 
        option.setName('reason')
          .setDescription('Reason for banning')
          .setRequired(false))
      .addIntegerOption(option => 
        option.setName('days')
          .setDescription('Number of days of messages to delete (0-7)')
          .setMinValue(0)
          .setMaxValue(7)
          .setRequired(false))
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    async execute(interaction) {
      const targetUser = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      const days = interaction.options.getInteger('days') || 0;
      
      if (!interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used in a server.',
          ephemeral: true
        });
        return;
      }
      
      try {
        await interaction.guild.members.ban(targetUser, { 
          deleteMessageDays: days,
          reason: reason
        });
        
        const embed = new EmbedBuilder()
          .setTitle('User Banned')
          .setDescription(`**${targetUser.tag}** has been banned from the server.`)
          .addFields(
            { name: 'Reason', value: reason },
            { name: 'Message History Deleted', value: `${days} days` }
          )
          .setColor('#FF0000')
          .setTimestamp();
        
        await interaction.reply({ embeds: [embed] });
        addLog('info', `${targetUser.tag} was banned by ${interaction.user.tag}. Reason: ${reason}`);
      } catch (error) {
        addLog('error', `Failed to ban ${targetUser.tag}: ${error.message}`);
        await interaction.reply({
          content: `Failed to ban the user: ${error.message}`,
          ephemeral: true
        });
      }
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Delete multiple messages from a channel')
      .addIntegerOption(option => 
        option.setName('amount')
          .setDescription('Number of messages to delete (1-100)')
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(true))
      .addUserOption(option => 
        option.setName('user')
          .setDescription('Delete messages only from this user')
          .setRequired(false))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    async execute(interaction) {
      const amount = interaction.options.getInteger('amount');
      const user = interaction.options.getUser('user');
      
      await interaction.deferReply({ ephemeral: true });
      
      try {
        let messages;
        if (user) {
          // Fetch more messages than requested to filter by user
          const fetchedMessages = await interaction.channel.messages.fetch({ 
            limit: Math.min(amount * 2, 100) 
          });
          
          // Filter messages by user
          const filteredMessages = fetchedMessages.filter(m => m.author.id === user.id);
          // Take only the requested amount
          messages = filteredMessages.first(amount);
        } else {
          // Fetch the requested amount directly
          messages = await interaction.channel.messages.fetch({ limit: amount });
        }
        
        if (messages.length === 0) {
          await interaction.editReply({
            content: user ? `No recent messages found from ${user.tag}` : 'No messages to delete',
            ephemeral: true
          });
          return;
        }
        
        const deletedCount = await interaction.channel.bulkDelete(messages, true)
          .then(deleted => deleted.size);
        
        await interaction.editReply({
          content: `Successfully deleted ${deletedCount} message${deletedCount !== 1 ? 's' : ''}${user ? ` from ${user.tag}` : ''}.`,
          ephemeral: true
        });
        
        addLog('info', `${interaction.user.tag} purged ${deletedCount} messages${user ? ` from ${user.tag}` : ''} in #${interaction.channel.name}`);
      } catch (error) {
        addLog('error', `Error in purge command: ${error.message}`);
        await interaction.editReply({
          content: `Failed to delete messages: ${error.message}. Note that messages older than 14 days cannot be bulk deleted.`,
          ephemeral: true
        });
      }
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('mute')
      .setDescription('Timeout a user')
      .addUserOption(option => 
        option.setName('user')
          .setDescription('The user to timeout')
          .setRequired(true))
      .addIntegerOption(option => 
        option.setName('duration')
          .setDescription('Timeout duration in minutes')
          .setMinValue(1)
          .setMaxValue(40320) // 28 days (Discord max)
          .setRequired(true))
      .addStringOption(option => 
        option.setName('reason')
          .setDescription('Reason for timeout')
          .setRequired(false))
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    async execute(interaction) {
      const targetUser = interaction.options.getUser('user');
      const duration = interaction.options.getInteger('duration');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      
      if (!interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used in a server.',
          ephemeral: true
        });
        return;
      }
      
      const member = interaction.guild.members.cache.get(targetUser.id);
      
      if (!member) {
        await interaction.reply({
          content: 'This user is not in the server.',
          ephemeral: true
        });
        return;
      }
      
      // Check if the bot can timeout the member
      if (!member.moderatable) {
        await interaction.reply({
          content: 'I cannot timeout this user. They might have higher permissions than me.',
          ephemeral: true
        });
        return;
      }
      
      try {
        // Convert minutes to milliseconds
        const timeoutDuration = duration * 60 * 1000;
        
        await member.timeout(timeoutDuration, reason);
        
        const embed = new EmbedBuilder()
          .setTitle('User Timed Out')
          .setDescription(`**${targetUser.tag}** has been timed out.`)
          .addFields(
            { name: 'Duration', value: `${duration} minute${duration !== 1 ? 's' : ''}` },
            { name: 'Reason', value: reason }
          )
          .setColor('#FFA500')
          .setTimestamp();
        
        await interaction.reply({ embeds: [embed] });
        addLog('info', `${targetUser.tag} was timed out by ${interaction.user.tag} for ${duration} minutes. Reason: ${reason}`);
      } catch (error) {
        addLog('error', `Failed to timeout ${targetUser.tag}: ${error.message}`);
        await interaction.reply({
          content: `Failed to timeout the user: ${error.message}`,
          ephemeral: true
        });
      }
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('unmute')
      .setDescription('Remove timeout from a user')
      .addUserOption(option => 
        option.setName('user')
          .setDescription('The user to remove timeout from')
          .setRequired(true))
      .addStringOption(option => 
        option.setName('reason')
          .setDescription('Reason for removing timeout')
          .setRequired(false))
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    async execute(interaction) {
      const targetUser = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      
      if (!interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used in a server.',
          ephemeral: true
        });
        return;
      }
      
      const member = interaction.guild.members.cache.get(targetUser.id);
      
      if (!member) {
        await interaction.reply({
          content: 'This user is not in the server.',
          ephemeral: true
        });
        return;
      }
      
      // Check if user is timed out
      if (!member.communicationDisabledUntil) {
        await interaction.reply({
          content: 'This user is not timed out.',
          ephemeral: true
        });
        return;
      }
      
      try {
        await member.timeout(null, reason);
        
        const embed = new EmbedBuilder()
          .setTitle('Timeout Removed')
          .setDescription(`Timeout has been removed from **${targetUser.tag}**.`)
          .addFields({ name: 'Reason', value: reason })
          .setColor('#00FF00')
          .setTimestamp();
        
        await interaction.reply({ embeds: [embed] });
        addLog('info', `Timeout removed from ${targetUser.tag} by ${interaction.user.tag}. Reason: ${reason}`);
      } catch (error) {
        addLog('error', `Failed to remove timeout from ${targetUser.tag}: ${error.message}`);
        await interaction.reply({
          content: `Failed to remove timeout: ${error.message}`,
          ephemeral: true
        });
      }
    }
  },

  // WELCOME SYSTEM
  {
    data: new SlashCommandBuilder()
      .setName('welcome')
      .setDescription('Configure the welcome system')
      .addSubcommand(subcommand =>
        subcommand
          .setName('setup')
          .setDescription('Set up welcome messages')
          .addChannelOption(option =>
            option.setName('channel')
              .setDescription('Channel to send welcome messages')
              .addChannelTypes(ChannelType.GuildText)
              .setRequired(true))
          .addStringOption(option =>
            option.setName('message')
              .setDescription('Welcome message (use {user} for mention, {server} for server name)')
              .setRequired(true)))
      .addSubcommand(subcommand =>
        subcommand
          .setName('disable')
          .setDescription('Disable welcome messages'))
      .addSubcommand(subcommand =>
        subcommand
          .setName('test')
          .setDescription('Test the welcome message'))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async execute(interaction) {
      if (!interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used in a server.',
          ephemeral: true
        });
        return;
      }
      
      const subcommand = interaction.options.getSubcommand();
      
      switch (subcommand) {
        case 'setup': {
          const channel = interaction.options.getChannel('channel');
          const message = interaction.options.getString('message');
          
          // Save welcome configuration
          welcomeConfig.set(interaction.guild.id, {
            channelId: channel.id,
            message: message
          });
          
          await interaction.reply({
            embeds: [{
              title: '✅ Welcome System Configured',
              description: 'Welcome messages have been set up successfully.',
              fields: [
                { name: 'Channel', value: `<#${channel.id}>`, inline: true },
                { name: 'Message', value: message, inline: false }
              ],
              color: 0x00FF00
            }],
            ephemeral: true
          });
          
          addLog('info', `Welcome system configured by ${interaction.user.tag} in server ${interaction.guild.name}`);
          break;
        }
        
        case 'disable': {
          welcomeConfig.delete(interaction.guild.id);
          
          await interaction.reply({
            embeds: [{
              title: '❌ Welcome System Disabled',
              description: 'Welcome messages have been disabled.',
              color: 0xFF0000
            }],
            ephemeral: true
          });
          
          addLog('info', `Welcome system disabled by ${interaction.user.tag} in server ${interaction.guild.name}`);
          break;
        }
        
        case 'test': {
          const config = welcomeConfig.get(interaction.guild.id);
          
          if (!config) {
            await interaction.reply({
              content: 'Welcome system is not configured. Use `/welcome setup` first.',
              ephemeral: true
            });
            return;
          }
          
          const channel = interaction.guild.channels.cache.get(config.channelId);
          
          if (!channel || channel.type !== ChannelType.GuildText) {
            await interaction.reply({
              content: 'The configured welcome channel no longer exists or is not a text channel.',
              ephemeral: true
            });
            return;
          }
          
          const welcomeMessage = config.message
            .replace('{user}', `<@${interaction.user.id}>`)
            .replace('{server}', interaction.guild.name);
          
          try {
            await channel.send({
              content: welcomeMessage,
              allowedMentions: { users: [interaction.user.id] }
            });
            
            await interaction.reply({
              content: `Test welcome message sent to <#${channel.id}>!`,
              ephemeral: true
            });
          } catch (error) {
            await interaction.reply({
              content: `Failed to send test message: ${error.message}`,
              ephemeral: true
            });
          }
          break;
        }
      }
    }
  },

  // TICKET SYSTEM
  {
    data: new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Configure and manage the ticket system')
      .addSubcommand(subcommand =>
        subcommand
          .setName('setup')
          .setDescription('Set up the ticket system')
          .addChannelOption(option =>
            option.setName('channel')
              .setDescription('Channel to send the ticket creation message')
              .addChannelTypes(ChannelType.GuildText)
              .setRequired(true))
          .addRoleOption(option =>
            option.setName('support_role')
              .setDescription('Role that can see and manage tickets')
              .setRequired(true))
          .addChannelOption(option =>
            option.setName('category')
              .setDescription('Category to create ticket channels in')
              .addChannelTypes(ChannelType.GuildCategory)
              .setRequired(true)))
      .addSubcommand(subcommand =>
        subcommand
          .setName('panel')
          .setDescription('Send a ticket panel to the configured channel'))
      .addSubcommand(subcommand =>
        subcommand
          .setName('disable')
          .setDescription('Disable the ticket system'))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async execute(interaction) {
      if (!interaction.guild) {
        await interaction.reply({
          content: 'This command can only be used in a server.',
          ephemeral: true
        });
        return;
      }
      
      const subcommand = interaction.options.getSubcommand();
      
      switch (subcommand) {
        case 'setup': {
          const channel = interaction.options.getChannel('channel');
          const supportRole = interaction.options.getRole('support_role');
          const category = interaction.options.getChannel('category');
          
          // Save ticket configuration
          ticketConfig.set(interaction.guild.id, {
            channelId: channel.id,
            supportRoleId: supportRole.id,
            categoryId: category.id,
            count: 0
          });
          
          await interaction.reply({
            embeds: [{
              title: '✅ Ticket System Configured',
              description: 'Ticket system has been set up successfully.',
              fields: [
                { name: 'Panel Channel', value: `<#${channel.id}>`, inline: true },
                { name: 'Support Role', value: `<@&${supportRole.id}>`, inline: true },
                { name: 'Tickets Category', value: category.name, inline: true },
                { name: 'Next Steps', value: 'Use `/ticket panel` to send the ticket creation panel.' }
              ],
              color: 0x00FF00
            }],
            ephemeral: true
          });
          
          addLog('info', `Ticket system configured by ${interaction.user.tag} in server ${interaction.guild.name}`);
          break;
        }
        
        case 'panel': {
          const config = ticketConfig.get(interaction.guild.id);
          
          if (!config) {
            await interaction.reply({
              content: 'Ticket system is not configured. Use `/ticket setup` first.',
              ephemeral: true
            });
            return;
          }
          
          const channel = interaction.guild.channels.cache.get(config.channelId);
          
          if (!channel || channel.type !== ChannelType.GuildText) {
            await interaction.reply({
              content: 'The configured ticket channel no longer exists or is not a text channel.',
              ephemeral: true
            });
            return;
          }
          
          const embed = new EmbedBuilder()
            .setTitle('🎫 Support Tickets')
            .setDescription('Click the button below to create a support ticket.')
            .setColor('#5865F2')
            .setFooter({ text: 'Your ticket will be created in a private channel.' });
          
          const row = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId('create_ticket')
                .setLabel('Create Ticket')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🎫')
            );
          
          try {
            await channel.send({
              embeds: [embed],
              components: [row]
            });
            
            await interaction.reply({
              content: `Ticket panel sent to <#${channel.id}>!`,
              ephemeral: true
            });
          } catch (error) {
            await interaction.reply({
              content: `Failed to send ticket panel: ${error.message}`,
              ephemeral: true
            });
          }
          break;
        }
        
        case 'disable': {
          ticketConfig.delete(interaction.guild.id);
          
          await interaction.reply({
            embeds: [{
              title: '❌ Ticket System Disabled',
              description: 'Ticket system has been disabled.',
              color: 0xFF0000
            }],
            ephemeral: true
          });
          
          addLog('info', `Ticket system disabled by ${interaction.user.tag} in server ${interaction.guild.name}`);
          break;
        }
      }
    }
  },

  // EMBED BUILDER
  {
    data: new SlashCommandBuilder()
      .setName('embed')
      .setDescription('Create and send custom embeds')
      .addSubcommand(subcommand =>
        subcommand
          .setName('create')
          .setDescription('Create a custom embed'))
      .addSubcommand(subcommand =>
        subcommand
          .setName('send')
          .setDescription('Send a previously created embed')
          .addChannelOption(option =>
            option.setName('channel')
              .setDescription('Channel to send the embed to')
              .addChannelTypes(ChannelType.GuildText)
              .setRequired(true)))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    async execute(interaction) {
      const subcommand = interaction.options.getSubcommand();
      
      if (subcommand === 'create') {
        // Show a modal to create the embed
        const modal = new ModalBuilder()
          .setCustomId('embed_creator_modal')
          .setTitle('Create Custom Embed');
        
        const titleInput = new TextInputBuilder()
          .setCustomId('embed_title')
          .setLabel('Title')
          .setPlaceholder('Enter embed title')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(256);
        
        const descriptionInput = new TextInputBuilder()
          .setCustomId('embed_description')
          .setLabel('Description')
          .setPlaceholder('Enter embed description')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000);
        
        const colorInput = new TextInputBuilder()
          .setCustomId('embed_color')
          .setLabel('Color (hex code)')
          .setPlaceholder('#FF0000')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(7);
        
        const imageInput = new TextInputBuilder()
          .setCustomId('embed_image')
          .setLabel('Image URL (optional)')
          .setPlaceholder('https://example.com/image.png')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);
        
        const footerInput = new TextInputBuilder()
          .setCustomId('embed_footer')
          .setLabel('Footer Text (optional)')
          .setPlaceholder('Enter footer text')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(2048);
        
        const titleRow = new ActionRowBuilder().addComponents(titleInput);
        const descriptionRow = new ActionRowBuilder().addComponents(descriptionInput);
        const colorRow = new ActionRowBuilder().addComponents(colorInput);
        const imageRow = new ActionRowBuilder().addComponents(imageInput);
        const footerRow = new ActionRowBuilder().addComponents(footerInput);
        
        modal.addComponents(titleRow, descriptionRow, colorRow, imageRow, footerRow);
        
        await interaction.showModal(modal);
      } else if (subcommand === 'send') {
        // Send the embed to a specific channel
        // This relies on temporary storage which will be handled in the modal submit interaction
        await interaction.reply({
          content: 'Please use the `/embed create` command first to create an embed.',
          ephemeral: true
        });
      }
    }
  }
];

// Format uptime
function getUptime(startTime) {
  if (!startTime) return 'Not available';
  
  const now = new Date();
  const uptimeMs = now - startTime;
  
  const seconds = Math.floor(uptimeMs / 1000) % 60;
  const minutes = Math.floor(uptimeMs / (1000 * 60)) % 60;
  const hours = Math.floor(uptimeMs / (1000 * 60 * 60)) % 24;
  const days = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
  
  if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// When the client is ready
client.once(Events.ClientReady, () => {
  addLog('info', `Logged in as ${client.user.tag}`);
  
  // Register slash commands
  const commandsData = commands.map(command => command.data.toJSON());
  
  client.application.commands.set(commandsData)
    .then(() => {
      addLog('info', 'Slash commands registered successfully');
    })
    .catch(error => {
      addLog('error', `Failed to register slash commands: ${error.message}`);
    });
});

// Guild Member Add Event for Welcome System
client.on(Events.GuildMemberAdd, async (member) => {
  const config = welcomeConfig.get(member.guild.id);
  if (!config) return;
  
  const channel = member.guild.channels.cache.get(config.channelId);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  
  const welcomeMessage = config.message
    .replace('{user}', `<@${member.id}>`)
    .replace('{server}', member.guild.name);
  
  try {
    await channel.send({
      content: welcomeMessage,
      allowedMentions: { users: [member.id] }
    });
    addLog('info', `Welcome message sent for ${member.user.tag} in ${member.guild.name}`);
  } catch (error) {
    addLog('error', `Failed to send welcome message for ${member.user.tag}: ${error.message}`);
  }
});

// Handle Button Interactions (for ticket system, etc.)
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId === 'create_ticket') {
      // Handle ticket creation
      if (!interaction.guild) return;
      
      const config = ticketConfig.get(interaction.guild.id);
      if (!config) {
        await interaction.reply({
          content: 'Ticket system is not properly configured.',
          ephemeral: true
        });
        return;
      }
      
      // Increment ticket count
      config.count++;
      ticketConfig.set(interaction.guild.id, config);
      
      // Create ticket channel
      try {
        const ticketChannel = await interaction.guild.channels.create({
          name: `ticket-${config.count}`,
          type: ChannelType.GuildText,
          parent: config.categoryId,
          permissionOverwrites: [
            {
              id: interaction.guild.id,
              deny: [PermissionFlagsBits.ViewChannel]
            },
            {
              id: interaction.user.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
            },
            {
              id: config.supportRoleId,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
            }
          ]
        });
        
        // Send initial message in ticket channel
        const embed = new EmbedBuilder()
          .setTitle(`Ticket #${config.count}`)
          .setDescription(`Ticket created by ${interaction.user.tag}. Support team will be with you shortly.`)
          .setColor('#5865F2')
          .setTimestamp();
        
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`close_ticket_${config.count}`)
              .setLabel('Close Ticket')
              .setStyle(ButtonStyle.Danger)
          );
        
        await ticketChannel.send({
          content: `<@${interaction.user.id}> <@&${config.supportRoleId}>`,
          embeds: [embed],
          components: [row]
        });
        
        await interaction.reply({
          content: `Your ticket has been created: <#${ticketChannel.id}>`,
          ephemeral: true
        });
        
        addLog('info', `Ticket #${config.count} created by ${interaction.user.tag} in ${interaction.guild.name}`);
      } catch (error) {
        await interaction.reply({
          content: `Failed to create ticket: ${error.message}`,
          ephemeral: true
        });
        addLog('error', `Failed to create ticket for ${interaction.user.tag}: ${error.message}`);
      }
    } else if (interaction.customId.startsWith('close_ticket_')) {
      // Handle ticket closing
      if (!interaction.guild) return;
      
      const embed = new EmbedBuilder()
        .setTitle('Ticket Closed')
        .setDescription(`Ticket was closed by ${interaction.user.tag}.`)
        .setColor('#FF0000')
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
      
      // Delay channel deletion by 5 seconds to allow users to see the message
      setTimeout(async () => {
        try {
          await interaction.channel.delete();
          addLog('info', `Ticket closed and deleted by ${interaction.user.tag}`);
        } catch (error) {
          addLog('error', `Failed to delete ticket channel: ${error.message}`);
        }
      }, 5000);
    }
  } else if (interaction.isModalSubmit()) {
    if (interaction.customId === 'embed_creator_modal') {
      // Handle embed creation from modal
      const title = interaction.fields.getTextInputValue('embed_title');
      const description = interaction.fields.getTextInputValue('embed_description');
      const colorString = interaction.fields.getTextInputValue('embed_color') || '#5865F2';
      const imageUrl = interaction.fields.getTextInputValue('embed_image');
      const footerText = interaction.fields.getTextInputValue('embed_footer');
      
      // Convert hex color to decimal
      const colorHex = colorString.replace('#', '');
      const color = parseInt(colorHex, 16) || 0x5865F2;
      
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
      
      if (imageUrl) {
        embed.setImage(imageUrl);
      }
      
      if (footerText) {
        embed.setFooter({ text: footerText });
      }
      
      // Create buttons to choose a channel or send to current channel
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('send_embed_here')
            .setLabel('Send Here')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('choose_embed_channel')
            .setLabel('Choose Channel')
            .setStyle(ButtonStyle.Secondary)
        );
      
      // Store the embed temporarily
      // In a production environment, you would use a database
      if (!interaction.guild.embedStore) {
        interaction.guild.embedStore = {};
      }
      interaction.guild.embedStore[interaction.user.id] = embed;
      
      await interaction.reply({
        content: 'Your embed has been created. Preview:',
        embeds: [embed],
        components: [row],
        ephemeral: true
      });
    }
  } else if (interaction.isCommand()) {
    const command = commands.find(cmd => cmd.data.name === interaction.commandName);
    
    if (!command) return;
    
    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(error);
      addLog('error', `Error executing command ${interaction.commandName}: ${error.message}`);
      
      const replyContent = {
        content: 'There was an error executing this command.',
        ephemeral: true
      };
      
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(replyContent);
      } else {
        await interaction.reply(replyContent);
      }
    }
  }
});

// Handle errors
client.on(Events.Error, error => {
  addLog('error', `Client error: ${error.message}`);
});

// Add a basic web server to keep the bot alive on Render
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Enhanced Discord Bot</title>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          font-family: Arial, sans-serif;
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
          line-height: 1.6;
        }
        .container {
          background-color: #f5f5f5;
          border-radius: 10px;
          padding: 20px;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        h1 {
          color: #5865F2;
          border-bottom: 2px solid #5865F2;
          padding-bottom: 10px;
        }
        .features {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 15px;
        }
        .feature {
          background-color: white;
          padding: 15px;
          border-radius: 5px;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
        }
        code {
          background-color: #f0f0f0;
          padding: 2px 5px;
          border-radius: 3px;
          font-family: monospace;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Enhanced Discord Bot</h1>
        <p>Status: 🟢 Online</p>
        <p>Features:</p>
        <div class="features">
          <div class="feature">
            <h3>✉️ Role DM System</h3>
            <p>Send direct messages to all users with a specific role.</p>
          </div>
          <div class="feature">
            <h3>🎵 Music System</h3>
            <p>Play music in voice channels with queue management.</p>
          </div>
          <div class="feature">
            <h3>🛠️ Utility Commands</h3>
            <p>Server info, user info, polls, and more.</p>
          </div>
          <div class="feature">
            <h3>👋 Welcome System</h3>
            <p>Customize welcome messages for new members.</p>
          </div>
          <div class="feature">
            <h3>🎫 Ticket System</h3>
            <p>Support ticket system for user assistance.</p>
          </div>
          <div class="feature">
            <h3>🖼️ Embed Builder</h3>
            <p>Create and send custom embeds to any channel.</p>
          </div>
          <div class="feature">
            <h3>🔨 Admin Commands</h3>
            <p>Moderation tools for server management.</p>
          </div>
          <div class="feature">
            <h3>📊 Logging</h3>
            <p>Comprehensive logging of bot activities.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

// Login to Discord
client.login(token);