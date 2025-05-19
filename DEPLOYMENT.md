# Deployment Guide for Enhanced Discord Bot

This guide provides detailed instructions for deploying your enhanced Discord bot to various platforms.

## Prerequisites

Before deploying, make sure you have:

1. A Discord account
2. A Discord application with a bot user created in the [Discord Developer Portal](https://discord.com/developers/applications)
3. Your bot token from the Discord Developer Portal
4. Node.js 16.9.0 or higher installed (for local testing)
5. Git installed (for version control)

## Getting Started: Local Development

1. Clone or download the bot files to your local machine
2. Navigate to the bot directory
3. Install dependencies:
   ```
   npm install
   ```
4. Create a `.env` file in the root directory:
   ```
   DISCORD_TOKEN=your_discord_bot_token_here
   ```
5. Run the bot locally:
   ```
   npm start
   ```

## Deployment Options

### 1. Render Deployment

[Render](https://render.com/) provides a simple and reliable way to host your Discord bot.

#### Step 1: Prepare Your Repository
1. Create a GitHub repository and push your bot code
2. Make sure your repository includes:
   - `index.js`
   - `package.json` with proper dependencies and start script
   - `.gitignore` that excludes `node_modules` and `.env`

#### Step 2: Set Up a Render Web Service
1. Create a Render account at [render.com](https://render.com/)
2. Navigate to Dashboard → New → Web Service
3. Connect your GitHub repository
4. Configure the service:
   - **Name**: Choose a name for your service (e.g., "my-discord-bot")
   - **Environment**: Node
   - **Region**: Choose a region close to where most of your Discord server members are located
   - **Branch**: main (or your preferred branch)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (or select a paid plan for better reliability)

#### Step 3: Add Environment Variables
1. Scroll down to the "Environment" section
2. Add the following variable:
   - Key: `DISCORD_TOKEN`
   - Value: Your Discord bot token
3. Add any other environment variables your bot needs

#### Step 4: Deploy
1. Click "Create Web Service"
2. Wait for the deployment to complete
3. Your bot should be online shortly after deployment finishes

#### Step 5: Keep Your Bot Running
Render free tier services sleep after inactivity. To keep your bot active:
1. Use the included Express server in the bot (already implemented)
2. Set up a monitoring service to ping the URL periodically (see Better Stack instructions below)

### 2. GitHub + Render Auto-Deployment

For continuous deployment:

1. Keep your code in a GitHub repository
2. When connected to Render, any changes pushed to your main branch will trigger automatic redeployment
3. You can also manually deploy from the Render dashboard

### 3. Better Stack Monitoring

[Better Stack](https://betterstack.com/) (formerly Uptime) helps ensure your bot stays online.

#### Step 1: Create a Better Stack Account
1. Sign up at [betterstack.com](https://betterstack.com/)
2. Create a new team or use the default team

#### Step 2: Create a Monitor
1. Go to Monitoring → Create Monitor
2. Enter your Render deployment URL (e.g., `https://your-bot-name.onrender.com`)
3. Configure the settings:
   - **Monitor Name**: Your bot name
   - **Check Interval**: 5 minutes (recommended)
   - **Monitor Type**: HTTPS

#### Step 3: Set Up Notifications
1. Go to the Alerting section
2. Create a new on-call calendar
3. Set up notification channels (email, SMS, Slack, Discord, etc.)
4. Configure escalation policies if needed

#### Step 4: Create a Heartbeat URL (Optional but Recommended)
1. Go to Monitoring → Create Monitor → Heartbeat
2. Create a new heartbeat monitor
3. Add the provided URL to your bot to ping periodically:

```javascript
// Add this to your bot code
function pingBetterStack() {
  const https = require('https');
  https.get('https://uptime.betterstack.com/api/v1/heartbeat/YOUR_HEARTBEAT_ID');
}

// Ping every 5 minutes
setInterval(pingBetterStack, 5 * 60 * 1000);
```

## Discord Bot Permissions and Settings

### Adding Your Bot to Servers

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application
3. Go to OAuth2 → URL Generator
4. Select the following scopes:
   - `bot`
   - `applications.commands`
5. Select the bot permissions:
   - **General Permissions**: View Channels
   - **Text Permissions**: Send Messages, Embed Links, Attach Files, Read Message History, Use External Emojis, Add Reactions, Use Slash Commands
   - **Voice Permissions**: Connect, Speak (if using music features)
   - **Moderation Permissions**: Kick Members, Ban Members, Moderate Members, Manage Messages (if using admin commands)
   - **Advanced Permissions**: Manage Roles (if using role commands)
6. Copy the generated URL
7. Open the URL in a browser and select the server to add the bot to
8. Complete the authorization process

### Required Gateway Intents

The enhanced bot requires the following intents that need to be enabled in the Discord Developer Portal:

1. Go to your application in the Discord Developer Portal
2. Navigate to the "Bot" tab
3. Scroll down to "Privileged Gateway Intents"
4. Enable:
   - **SERVER MEMBERS** (required for welcome messages and user commands)
   - **MESSAGE CONTENT** (required for message commands)
   - **PRESENCE** (optional, for showing online users)

## Troubleshooting

### Bot Not Coming Online
1. Check your Render logs for errors
2. Verify your Discord token is correct
3. Make sure all required gateway intents are enabled in the Discord Developer Portal

### Commands Not Registering
1. Check if the bot has the `applications.commands` scope
2. Verify the bot has permission to create slash commands in the server
3. It may take up to an hour for global commands to propagate

### Anti-Spam Detection
If your bot gets flagged for spam:
1. Appeal at https://dis.gd/app-quarantine
2. Reduce the number of DMs sent in a short period
3. Use the rate limiting features built into the enhanced bot

### Render Service Sleeping
1. Set up a monitoring service as described above
2. Upgrade to a paid tier for 24/7 uptime

## Additional Notes

### Music Feature Implementation
To fully implement the music feature:

1. Install additional dependencies:
   ```
   npm install @discordjs/voice discord-player ffmpeg-static sodium
   ```
2. Uncomment and implement the music player system in your code
3. Make sure the bot has proper voice channel permissions
4. Be aware of YouTube's terms of service when implementing music features

### Data Persistence
For persistent data (welcome messages, ticket configurations):

1. Consider adding a database like MongoDB:
   ```
   npm install mongoose
   ```
2. Move all collections (welcomeConfig, ticketConfig) to database storage
3. Update the code to use database operations instead of in-memory collections

### Scaling Up
As your bot grows:
1. Consider moving to a paid tier on Render
2. Implement database storage for configurations and logs
3. Set up proper error monitoring
4. Add analytics to track command usage and performance

## Need Help?

If you encounter issues with your bot:
1. Check the console logs for error messages
2. Reach out to the Discord.js community:
   - [Discord.js Guide](https://discordjs.guide/)
   - [Discord.js Discord Server](https://discord.gg/djs)
3. Review the Discord Developer Documentation:
   - [Discord Developer Portal](https://discord.com/developers/docs/intro)
   - [Discord.js Documentation](https://discord.js.org/)