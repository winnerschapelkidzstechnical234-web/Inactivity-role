require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, PermissionsBitField } = require('discord.js');

const PREFIX = process.env.PREFIX || '!';

const TRACKED_VC_IDS = (process.env.TRACKED_VC_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const TRACKED_ROLE_IDS = (process.env.TRACKED_ROLE_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const ALLOWED_ROLE_IDS = (process.env.ALLOWED_ROLE_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Where activity data is saved. If you add a Railway Volume, mount it at /data
// and set DATA_DIR=/data so this survives redeploys. Otherwise it resets on each deploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'activity.json');

function loadActivity() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

function saveActivity(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save activity data:', err);
  }
}

let activity = loadActivity(); // { userId: isoTimestampString }

function hasAccess(member) {
  if (ALLOWED_ROLE_IDS.length > 0) {
    return ALLOWED_ROLE_IDS.some((id) => member.roles.cache.has(id));
  }
  return member.permissions.has(PermissionsBitField.Flags.ManageRoles);
}

function formatSince(isoString) {
  if (!isoString) return 'Never joined';
  const then = new Date(isoString).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
  if (days === 0 && hours === 0) return 'Just now';
  if (days === 0) return `${hours}h ago`;
  return `${days}d ${hours}h ago`;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.GuildMember],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Prefix: ${PREFIX}`);
  console.log(`Commands: ${PREFIX}inactivity | ${PREFIX}lastseen @user`);
  if (TRACKED_VC_IDS.length === 0) {
    console.log('WARNING: No TRACKED_VC_IDS set — voice activity tracking is off until configured.');
  }
  if (TRACKED_ROLE_IDS.length === 0) {
    console.log('WARNING: No TRACKED_ROLE_ID set — !inactivity has nothing to check yet.');
  }
});

// Track when someone joins one of the designated recording VCs
client.on('voiceStateUpdate', (oldState, newState) => {
  if (TRACKED_VC_IDS.length === 0) return;
  const joinedChannelId = newState.channelId;
  const cameFromDifferentChannel = oldState.channelId !== newState.channelId;

  if (joinedChannelId && cameFromDifferentChannel && TRACKED_VC_IDS.includes(joinedChannelId)) {
    activity[newState.id] = new Date().toISOString();
    saveActivity(activity);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  // ---------- !inactivity ----------
  if (command === 'inactivity') {
    if (!hasAccess(message.member)) {
      return message.reply("You don't have access to this command.");
    }
    if (TRACKED_ROLE_IDS.length === 0) {
      return message.reply('TRACKED_ROLE_ID is not set, so I don\'t know which role(s) to check activity for.');
    }
    if (TRACKED_VC_IDS.length === 0) {
      return message.reply('TRACKED_VC_IDS is not set, so no voice channels are being tracked yet.');
    }

    await message.guild.members.fetch(); // ensure full member cache
    const trackedMembers = message.guild.members.cache.filter((m) =>
      TRACKED_ROLE_IDS.some((roleId) => m.roles.cache.has(roleId))
    );

    if (trackedMembers.size === 0) {
      return message.reply('No members currently have any of the tracked recording crew roles.');
    }

    const rows = trackedMembers.map((m) => ({
      tag: m.user.tag,
      lastSeen: activity[m.id] || null,
    }));

    // Sort: never-joined first, then oldest activity first (most inactive at top)
    rows.sort((a, b) => {
      const aTime = a.lastSeen ? new Date(a.lastSeen).getTime() : -1;
      const bTime = b.lastSeen ? new Date(b.lastSeen).getTime() : -1;
      return aTime - bTime;
    });

    const lines = rows.map((r) => `${r.lastSeen ? '🔸' : '⛔'} **${r.tag}** — ${formatSince(r.lastSeen)}`);

    // Discord messages cap at 2000 chars — chunk if needed
    let chunk = `**Recording Crew Activity (${rows.length} members)**\n`;
    for (const line of lines) {
      if ((chunk + line + '\n').length > 1900) {
        await message.channel.send(chunk);
        chunk = '';
      }
      chunk += line + '\n';
    }
    if (chunk.trim()) await message.channel.send(chunk);
    return;
  }

  // ---------- !lastseen @user ----------
  if (command === 'lastseen') {
    if (!hasAccess(message.member)) {
      return message.reply("You don't have access to this command.");
    }
    const target = message.mentions.members.first();
    if (!target) {
      return message.reply('Tag someone to check, e.g. `!lastseen @user`');
    }
    const lastSeen = activity[target.id] || null;
    return message.reply(`**${target.user.tag}** last joined a tracked recording VC: ${formatSince(lastSeen)}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
