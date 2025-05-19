# Enhanced Discord Bot

A feature-rich Discord bot with role-based messaging, music, welcome system, ticket system, moderation tools, and more!

## Features

1. **Role DM System**
   - Send direct messages to all users with a specific role
   - Anonymous messaging option
   - Rate limiting to prevent Discord's anti-spam detection

2. **Music System** (placeholder - requires additional libraries)
   - Play songs from YouTube/Spotify
   - Queue management
   - Skip, stop, and view queue commands

3. **Utility Commands**
   - Ping - Check bot latency
   - User info - Display information about users
   - Server info - Display server statistics
   - Poll - Create interactive polls

4. **Welcome System**
   - Customizable welcome messages
   - Server and user variables
   - Test functionality

5. **Ticket System**
   - Support ticket creation
   - Private channels for each ticket
   - Role-based staff access

6. **Embed Builder**
   - Create and send custom embeds
   - Full customization of colors, titles, and images
   - Send to any channel

7. **Admin Commands**
   - Kick, ban, and timeout users
   - Purge messages from channels
   - Other server management tools

## Setup Instructions

### Prerequisites
- Node.js 16.9.0 or higher
- A Discord account and application with bot
- Discord bot token

### Installation

1. Clone the repository or download the files
   ```
   git clone https://github.com/yourusername/enhanced-discord-bot.git
   cd enhanced-discord-bot
   ```

2. Install dependencies
   ```
   npm install
   ```

3. Create a `.env` file in the root directory with your Discord token:
   ```
   DISCORD_TOKEN=your_token_here
   ```

4. Start the bot
   ```
   npm start
   ```

## Deployment

### Render Deployment
1. Create a new Web Service on Render
2. Connect to your GitHub repository
3. Set the following:
   - Build Command: `npm install`  
   - Start Command: `npm start`
4. Add the following environment variable:
   - Key: `DISCORD_TOKEN`
   - Value: Your Discord bot token
5. Deploy!

### Better Stack Monitoring
1. Create an account on Better Stack (betterstack.com)
2. Create a new monitor with your Render deployment URL
3. Set appropriate check intervals and alerts
4. Add notifications to your preferred channels

## Common Issues

### Discord Bot Anti-Spam Flag
If you receive errors like:
```
[ERROR] Failed to send DM to username: Your bot has been flagged by our anti-spam system for abusive behavior. Please reach out to our team by going to https://dis.gd/app-quarantine and appeal this action taken on your bot.
```

**Solution:**
1. The enhanced bot already includes rate limiting to prevent this in the future.
2. To fix a flagged bot:
   - Appeal the flag at https://dis.gd/app-quarantine
   - Be more careful with mass DM commands
   - Avoid DM'ing too many users in a short period

### Status Command Error
The error: `TypeError: Cannot read properties of null (reading 'name')` in the status command has been fixed in this enhanced version by safely checking if interaction.guild exists before accessing its name property.

## Music System Implementation (Additional Steps)

To fully implement the music system, you'll need to:

1. Install additional packages:
   ```
   npm install @discordjs/voice discord-player ffmpeg-static sodium
   ```

2. Implement a music player class with play, skip, stop, and queue functionality
3. Make sure your bot has proper voice channel permissions

## License
MIT