require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
} = require('discord.js');

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

// The role considered "Unverified" — removed by !removeunverified once someone
// has a role that implies they're actually verified.
const UNVERIFIED_ROLE_ID = process.env.UNVERIFIED_ROLE_ID || null;

// --- Automatic Unverified removal (runs on its own schedule, no command needed) ---
// Role(s) that count as "verified" — anyone with one of these AND Unverified gets Unverified stripped automatically.
const AUTO_VERIFIED_ROLE_IDS = (process.env.AUTO_VERIFIED_ROLE_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Channel to post a log message in every time the automatic check runs.
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;

// How often to run the automatic check, in hours (defaults to once a day).
const AUTO_CHECK_INTERVAL_HOURS = Number(process.env.AUTO_CHECK_INTERVAL_HOURS || 24);

// Where activity data is saved. If you add a Railway Volume, mount it at /data
// and set DATA_DIR=/data so this survives redeploys. Otherwise it resets on each deploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'activity.json');

// ==================== LOA (Leave of Absence) system ====================

// The Discord server this bot runs in — needed to register slash commands instantly.
const GUILD_ID = process.env.GUILD_ID || null;

// Who can run /loa request — your Recording Crew roles. Comma-separated.
const RECORDING_CREW_ROLE_IDS = (process.env.RECORDING_CREW_ROLE_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Who can run /loa manage, /loa list, and click Approve/Deny — your staff/instructor roles.
const LOA_STAFF_ROLE_IDS = (process.env.LOA_STAFF_ROLE_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// The role automatically given while someone is on LOA, and removed once it ends.
const LOA_ROLE_ID = process.env.LOA_ROLE_ID || null;

// Where /loa request gets typed, and where public approved/denied replies get posted.
const LOA_CHANNEL_ID = process.env.LOA_CHANNEL_ID || null;

// Where the Approve/Deny embed gets posted for staff to act on.
const LOA_STAFF_CHANNEL_ID = process.env.LOA_STAFF_CHANNEL_ID || null;

// Where the bot posts when an LOA automatically ends (pings LOA_STAFF_ROLE_IDS).
// Defaults to the staff channel above if not set separately.
const LOA_LOG_CHANNEL_ID = process.env.LOA_LOG_CHANNEL_ID || LOA_STAFF_CHANNEL_ID;

// The timezone LOA dates are interpreted in (defaults to US Eastern).
const LOA_TIMEZONE = process.env.LOA_TIMEZONE || 'America/New_York';

// How often to check for expired LOAs, in hours.
const LOA_CHECK_INTERVAL_HOURS = Number(process.env.LOA_CHECK_INTERVAL_HOURS || 1);

const LOA_DATA_FILE = path.join(DATA_DIR, 'loas.json');

function loadLoas() {
  try {
    const raw = fs.readFileSync(LOA_DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

function saveLoas(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOA_DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save LOA data:', err);
  }
}

let loas = loadLoas(); // { loaId: { userId, userTag, startDate, endDate, reason, status, ... } }

function hasAnyRole(member, roleIds) {
  return roleIds.some((id) => member.roles.cache.has(id));
}

function isRecordingCrew(member) {
  return hasAnyRole(member, RECORDING_CREW_ROLE_IDS);
}

function isLoaStaff(member) {
  return hasAnyRole(member, LOA_STAFF_ROLE_IDS);
}

// Parses "MM/DD/YYYY" into a plain date object (no time component)
function parseLoaDate(text) {
  const match = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Reject invalid calendar dates like Feb 30 (JS Date auto-rolls those forward)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

// Converts a LOA end date into the exact UTC moment their leave officially ends
// (end of that calendar day, in LOA_TIMEZONE). Reuses the same Intl-based
// zoned-time conversion approach as the sessiontime command in the other bot.
function endOfDayUtc(year, month, day, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  function getUtcMsForWallTimeAsIfUtc(ms) {
    const parts = dtf.formatToParts(new Date(ms));
    const obj = {};
    for (const p of parts) obj[p.type] = p.value;
    const hh = obj.hour === '24' ? 0 : Number(obj.hour);
    return Date.UTC(Number(obj.year), Number(obj.month) - 1, Number(obj.day), hh, Number(obj.minute), Number(obj.second));
  }
  const utcGuess = Date.UTC(year, month - 1, day, 23, 59, 59);
  const offset = utcGuess - getUtcMsForWallTimeAsIfUtc(utcGuess);
  return utcGuess + offset;
}

function formatLoaDate(year, month, day) {
  return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
}

function findActiveOrPendingLoa(userId) {
  return Object.entries(loas).find(
    ([, l]) => l.userId === userId && (l.status === 'pending' || l.status === 'approved')
  );
}

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

// Runs the same logic as !removeunverified, but automatically and across every
// guild the bot is in, then posts a log message instead of asking for confirmation.
async function runAutoRemoveUnverified() {
  if (!UNVERIFIED_ROLE_ID || AUTO_VERIFIED_ROLE_IDS.length === 0) {
    return; // not configured yet — silently skip rather than spam errors every interval
  }

  for (const guild of client.guilds.cache.values()) {
    try {
      const unverifiedRole = guild.roles.cache.get(UNVERIFIED_ROLE_ID);
      if (!unverifiedRole) continue;

      const botMember = await guild.members.fetchMe();
      if (unverifiedRole.position >= botMember.roles.highest.position) {
        console.error(`Auto-removeunverified: my role is below ${unverifiedRole.name} in ${guild.name}, skipping.`);
        continue;
      }

      await guild.members.fetch(); // ensure full member cache
      const verifiedRoles = AUTO_VERIFIED_ROLE_IDS.map((id) => guild.roles.cache.get(id)).filter(Boolean);
      if (verifiedRoles.length === 0) continue;

      const toClean = guild.members.cache.filter(
        (m) => m.roles.cache.has(unverifiedRole.id) && verifiedRoles.some((r) => m.roles.cache.has(r.id))
      );

      if (toClean.size === 0) continue; // nothing to do, no log spam on empty runs

      const removed = [];
      const failed = [];
      for (const member of toClean.values()) {
        try {
          await member.roles.remove(unverifiedRole);
          removed.push(member.user.tag);
        } catch (err) {
          console.error(`Auto-removeunverified: failed to remove role from ${member.user.tag}:`, err);
          failed.push(member.user.tag);
        }
      }

      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const lines = [
        `🔄 **Automatic Unverified check — ${timestamp} UTC**`,
        `✅ Removed Unverified from ${removed.length}: ${removed.join(', ')}`,
      ];
      if (failed.length) lines.push(`❌ Failed for ${failed.length}: ${failed.join(', ')}`);

      if (LOG_CHANNEL_ID) {
        const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (logChannel) {
          await logChannel.send(lines.join('\n'));
        } else {
          console.error(`Auto-removeunverified: could not find LOG_CHANNEL_ID ${LOG_CHANNEL_ID}`);
        }
      } else {
        console.log(lines.join('\n'));
      }
    } catch (err) {
      console.error(`Auto-removeunverified: unexpected error in guild ${guild.name}:`, err);
    }
  }
}

// ==================== LOA slash command definitions ====================

const loaCommand = new SlashCommandBuilder()
  .setName('loa')
  .setDescription('Recording Crew Leave of Absence system')
  .addSubcommand((sub) => sub.setName('request').setDescription('Request a Leave of Absence'))
  .addSubcommand((sub) =>
    sub
      .setName('manage')
      .setDescription('[Staff] View or manage a recording crew member\'s LOA')
      .addUserOption((opt) => opt.setName('user').setDescription('The member to look up').setRequired(true))
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('[Staff] List everyone currently on LOA'))
  .addSubcommand((sub) => sub.setName('help').setDescription('How the LOA system works'));

// ==================== Automatic LOA expiry checker ====================

async function runLoaExpiryCheck() {
  if (!LOA_ROLE_ID) return;

  const now = Date.now();
  const expiredEntries = Object.entries(loas).filter(
    ([, l]) => l.status === 'approved' && now >= l.endTimestamp
  );

  if (expiredEntries.length === 0) return;

  for (const guild of client.guilds.cache.values()) {
    const role = guild.roles.cache.get(LOA_ROLE_ID);
    if (!role) continue;

    for (const [loaId, loa] of expiredEntries) {
      try {
        const member = await guild.members.fetch(loa.userId).catch(() => null);
        if (member && member.roles.cache.has(LOA_ROLE_ID)) {
          await member.roles.remove(role);
        }
        loas[loaId].status = 'expired';
        saveLoas(loas);

        if (LOA_LOG_CHANNEL_ID) {
          const logChannel = await client.channels.fetch(LOA_LOG_CHANNEL_ID).catch(() => null);
          if (logChannel) {
            const staffPing = LOA_STAFF_ROLE_IDS.map((id) => `<@&${id}>`).join(' ');
            await logChannel.send(
              `🔔 ${staffPing}\n**${loa.userTag}**'s LOA has ended (was scheduled through ${formatLoaDate(loa.endYear, loa.endMonth, loa.endDay)}). The LOA role has been automatically removed.`
            );
          }
        }
      } catch (err) {
        console.error(`LOA expiry: failed to process ${loa.userTag}:`, err);
      }
    }
  }
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Prefix: ${PREFIX}`);
  console.log(`Commands: ${PREFIX}inactivity | ${PREFIX}lastseen @user | ${PREFIX}merge @OldRole @NewRole | ${PREFIX}removeunverified @Role`);
  if (TRACKED_VC_IDS.length === 0) {
    console.log('WARNING: No TRACKED_VC_IDS set — voice activity tracking is off until configured.');
  }
  if (TRACKED_ROLE_IDS.length === 0) {
    console.log('WARNING: No TRACKED_ROLE_ID set — !inactivity has nothing to check yet.');
  }

  if (UNVERIFIED_ROLE_ID && AUTO_VERIFIED_ROLE_IDS.length > 0) {
    console.log(`Automatic Unverified removal is ON — checking every ${AUTO_CHECK_INTERVAL_HOURS}h.`);
    // Run once shortly after startup, then repeat on the configured interval
    setTimeout(runAutoRemoveUnverified, 30000);
    setInterval(runAutoRemoveUnverified, AUTO_CHECK_INTERVAL_HOURS * 60 * 60 * 1000);
  } else {
    console.log('Automatic Unverified removal is OFF — set AUTO_VERIFIED_ROLE_ID to turn it on.');
  }

  // Register the /loa slash command
  if (GUILD_ID) {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) {
      guild.commands.set([loaCommand])
        .then(() => console.log('Slash command /loa registered successfully.'))
        .catch((err) => console.error('Failed to register /loa slash command:', err));
    } else {
      console.error(`GUILD_ID ${GUILD_ID} not found — is the bot actually in that server?`);
    }
  } else {
    console.log('WARNING: No GUILD_ID set — /loa slash command will not be registered.');
  }

  // Start the LOA expiry checker
  if (LOA_ROLE_ID && RECORDING_CREW_ROLE_IDS.length > 0) {
    console.log(`LOA system is ON — expiry checked every ${LOA_CHECK_INTERVAL_HOURS}h.`);
    setTimeout(runLoaExpiryCheck, 30000);
    setInterval(runLoaExpiryCheck, LOA_CHECK_INTERVAL_HOURS * 60 * 60 * 1000);
  } else {
    console.log('LOA system is OFF — set LOA_ROLE_ID and RECORDING_CREW_ROLE_ID to turn it on.');
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

  // ---------- !merge @OldRole @NewRole ----------
  if (command === 'merge') {
    if (!hasAccess(message.member)) {
      return message.reply("You don't have access to this command.");
    }

    // Parse role mentions directly from the raw text, in the exact order they appear,
    // rather than relying on the mentions collection's internal ordering.
    const roleIdMatches = [...message.content.matchAll(/<@&(\d+)>/g)].map((m) => m[1]);
    const uniqueRoleIds = [...new Set(roleIdMatches)];
    if (uniqueRoleIds.length < 2) {
      return message.reply(
        'Mention both roles in order: `!merge @OldRole @NewRole`\n' +
        'Everyone with @OldRole will be given @NewRole. Nothing is removed automatically — ' +
        'once you\'re happy with the result, delete @OldRole yourself in Server Settings > Roles.'
      );
    }

    const oldRole = message.guild.roles.cache.get(uniqueRoleIds[0]);
    const newRole = message.guild.roles.cache.get(uniqueRoleIds[1]);

    if (!oldRole || !newRole) {
      return message.reply('Could not find one of those roles — make sure both are valid, current roles in this server.');
    }

    if (oldRole.id === newRole.id) {
      return message.reply('Those are the same role — nothing to merge.');
    }

    await message.guild.members.fetch(); // ensure full member cache
    const membersWithOldRole = message.guild.members.cache.filter((m) => m.roles.cache.has(oldRole.id));
    const toUpdate = membersWithOldRole.filter((m) => !m.roles.cache.has(newRole.id));
    const alreadyHadBoth = membersWithOldRole.size - toUpdate.size;

    if (membersWithOldRole.size === 0) {
      return message.reply(`No members currently have **${oldRole.name}**. Nothing to merge.`);
    }

    // Make sure the bot can actually assign the new role
    const botMember = await message.guild.members.fetchMe();
    if (newRole.position >= botMember.roles.highest.position) {
      return message.reply(
        `I can't assign **${newRole.name}** because my role is positioned below it. ` +
        `Move my bot's role above **${newRole.name}** in Server Settings > Roles, then try again.`
      );
    }

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('merge_confirm').setLabel('Confirm Merge').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('merge_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );

    const confirmMsg = await message.reply({
      content:
        `**Merge check**\n` +
        `• **${membersWithOldRole.size}** members currently have **${oldRole.name}**\n` +
        `• **${toUpdate.size}** of them will be given **${newRole.name}**\n` +
        `• **${alreadyHadBoth}** already have both roles and will be skipped\n\n` +
        `This does **not** remove **${oldRole.name}** from anyone. Once you've confirmed it worked, ` +
        `delete that role yourself in Server Settings to clean it up.\n\n` +
        `Only <@${message.author.id}> can confirm this. This request expires in 60 seconds.`,
      components: [confirmRow],
    });

    const authorOnlyFilter = (interaction) => {
      if (interaction.user.id !== message.author.id) {
        interaction.reply({ content: 'Only the person who ran this command can confirm it.', ephemeral: true }).catch(() => {});
        return false; // doesn't count against the collector, so the real author still gets their turn
      }
      return true;
    };

    const collector = confirmMsg.createMessageComponentCollector({ filter: authorOnlyFilter, time: 60000, max: 1 });

    collector.on('collect', async (interaction) => {
      if (interaction.customId === 'merge_cancel') {
        await interaction.update({ content: 'Merge cancelled. No changes were made.', components: [] });
        return;
      }

      await interaction.update({ content: 'Merging… this may take a moment for large groups.', components: [] });

      const results = { added: [], failed: [] };
      for (const member of toUpdate.values()) {
        try {
          await member.roles.add(newRole);
          results.added.push(member.user.tag);
        } catch (err) {
          console.error(`Failed to add ${newRole.name} to ${member.user.tag}:`, err);
          results.failed.push(member.user.tag);
        }
      }

      const summaryLines = [
        `**Merge complete: ${oldRole.name} → ${newRole.name}**`,
        `✅ Given the role: ${results.added.length}`,
        `ℹ️ Already had both roles (skipped): ${alreadyHadBoth}`,
      ];
      if (results.failed.length) {
        summaryLines.push(`❌ Failed: ${results.failed.length} (${results.failed.join(', ')})`);
      }
      summaryLines.push(
        `\nNothing was removed. Double check the member list, then delete **${oldRole.name}** yourself when you're ready.`
      );

      await message.channel.send(summaryLines.join('\n'));
    });

    collector.on('end', async (collected) => {
      if (collected.size === 0) {
        await confirmMsg.edit({ content: 'Merge request expired — no changes were made. Run `!merge` again if you still want to do this.', components: [] });
      }
    });

    return;
  }

  // ---------- !removeunverified @Role ----------
  if (command === 'removeunverified') {
    if (!hasAccess(message.member)) {
      return message.reply("You don't have access to this command.");
    }

    if (!UNVERIFIED_ROLE_ID) {
      return message.reply('UNVERIFIED_ROLE_ID is not set in the bot\'s config, so I don\'t know which role counts as "Unverified".');
    }

    const roleIdMatches = [...message.content.matchAll(/<@&(\d+)>/g)].map((m) => m[1]);
    const uniqueRoleIds = [...new Set(roleIdMatches)];
    if (uniqueRoleIds.length < 1) {
      return message.reply(
        'Mention the role that counts as verified: `!removeunverified @Role`\n' +
        'Everyone with @Role who also has the Unverified role will have Unverified removed.'
      );
    }

    const verifiedRole = message.guild.roles.cache.get(uniqueRoleIds[0]);
    if (!verifiedRole) {
      return message.reply('Could not find that role — make sure it\'s a valid, current role in this server.');
    }

    const unverifiedRole = message.guild.roles.cache.get(UNVERIFIED_ROLE_ID);
    if (!unverifiedRole) {
      return message.reply('Could not find the Unverified role from UNVERIFIED_ROLE_ID. Double check that ID in the bot\'s config.');
    }

    if (verifiedRole.id === unverifiedRole.id) {
      return message.reply('That role IS the Unverified role — nothing to do here.');
    }

    await message.guild.members.fetch(); // ensure full member cache
    const membersWithVerifiedRole = message.guild.members.cache.filter((m) => m.roles.cache.has(verifiedRole.id));
    const toUpdate = membersWithVerifiedRole.filter((m) => m.roles.cache.has(unverifiedRole.id));
    const alreadyClean = membersWithVerifiedRole.size - toUpdate.size;

    if (membersWithVerifiedRole.size === 0) {
      return message.reply(`No members currently have **${verifiedRole.name}**. Nothing to do.`);
    }

    if (toUpdate.size === 0) {
      return message.reply(`Everyone with **${verifiedRole.name}** is already clear of the Unverified role. Nothing to do.`);
    }

    // Make sure the bot can actually remove the unverified role
    const botMember = await message.guild.members.fetchMe();
    if (unverifiedRole.position >= botMember.roles.highest.position) {
      return message.reply(
        `I can't remove **${unverifiedRole.name}** because my role is positioned below it. ` +
        `Move my bot's role above **${unverifiedRole.name}** in Server Settings > Roles, then try again.`
      );
    }

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('unverify_confirm').setLabel('Confirm Removal').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('unverify_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );

    const confirmMsg = await message.reply({
      content:
        `**Remove Unverified check**\n` +
        `• **${membersWithVerifiedRole.size}** members have **${verifiedRole.name}**\n` +
        `• **${toUpdate.size}** of them still have **${unverifiedRole.name}** and will have it removed\n` +
        `• **${alreadyClean}** are already clear and will be skipped\n\n` +
        `Only <@${message.author.id}> can confirm this. This request expires in 60 seconds.`,
      components: [confirmRow],
    });

    const authorOnlyFilter = (interaction) => {
      if (interaction.user.id !== message.author.id) {
        interaction.reply({ content: 'Only the person who ran this command can confirm it.', ephemeral: true }).catch(() => {});
        return false;
      }
      return true;
    };

    const collector = confirmMsg.createMessageComponentCollector({ filter: authorOnlyFilter, time: 60000, max: 1 });

    collector.on('collect', async (interaction) => {
      if (interaction.customId === 'unverify_cancel') {
        await interaction.update({ content: 'Cancelled. No changes were made.', components: [] });
        return;
      }

      await interaction.update({ content: 'Removing Unverified role… this may take a moment for large groups.', components: [] });

      const results = { removed: [], failed: [] };
      for (const member of toUpdate.values()) {
        try {
          await member.roles.remove(unverifiedRole);
          results.removed.push(member.user.tag);
        } catch (err) {
          console.error(`Failed to remove ${unverifiedRole.name} from ${member.user.tag}:`, err);
          results.failed.push(member.user.tag);
        }
      }

      const summaryLines = [
        `**Removal complete: ${unverifiedRole.name} cleared from ${verifiedRole.name} members**`,
        `✅ Removed from: ${results.removed.length}`,
        `ℹ️ Already clear (skipped): ${alreadyClean}`,
      ];
      if (results.failed.length) {
        summaryLines.push(`❌ Failed: ${results.failed.length} (${results.failed.join(', ')})`);
      }

      await message.channel.send(summaryLines.join('\n'));
    });

    collector.on('end', async (collected) => {
      if (collected.size === 0) {
        await confirmMsg.edit({ content: 'Request expired — no changes were made. Run `!removeunverified` again if you still want to do this.', components: [] });
      }
    });

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

// ==================== LOA embed builders ====================

function buildRequestEmbed(loa, statusLabel, color) {
  return new EmbedBuilder()
    .setTitle('Leave of Absence Request')
    .setColor(color)
    .addFields(
      { name: 'Requested by', value: `<@${loa.userId}>`, inline: true },
      { name: 'Status', value: statusLabel, inline: true },
      { name: 'Start Date', value: formatLoaDate(loa.startYear, loa.startMonth, loa.startDay), inline: true },
      { name: 'End Date', value: formatLoaDate(loa.endYear, loa.endMonth, loa.endDay), inline: true },
      { name: 'Reason', value: loa.reason || 'No reason given' }
    )
    .setTimestamp(loa.requestedAt);
}

// ==================== Interaction handling (slash commands, modals, buttons) ====================

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ---------- /loa slash command ----------
    if (interaction.isChatInputCommand() && interaction.commandName === 'loa') {
      const sub = interaction.options.getSubcommand();

      // ----- /loa request -----
      if (sub === 'request') {
        if (!isRecordingCrew(interaction.member)) {
          return interaction.reply({ content: "You don't have access to this command.", ephemeral: true });
        }
        if (LOA_CHANNEL_ID && interaction.channelId !== LOA_CHANNEL_ID) {
          return interaction.reply({ content: `Please use this command in <#${LOA_CHANNEL_ID}>.`, ephemeral: true });
        }
        const existing = findActiveOrPendingLoa(interaction.user.id);
        if (existing) {
          const [, l] = existing;
          return interaction.reply({
            content: `You already have ${l.status === 'pending' ? 'a pending' : 'an active'} LOA request. You can't submit another until that one is resolved.`,
            ephemeral: true,
          });
        }

        const modal = new ModalBuilder().setCustomId('loa_request_modal').setTitle('Request a Leave of Absence');
        const startInput = new TextInputBuilder()
          .setCustomId('start_date').setLabel('Start Date (MM/DD/YYYY)')
          .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('07/25/2026');
        const endInput = new TextInputBuilder()
          .setCustomId('end_date').setLabel('End Date (MM/DD/YYYY)')
          .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('08/01/2026');
        const reasonInput = new TextInputBuilder()
          .setCustomId('reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph).setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(startInput),
          new ActionRowBuilder().addComponents(endInput),
          new ActionRowBuilder().addComponents(reasonInput)
        );
        return interaction.showModal(modal);
      }

      // ----- /loa manage -----
      if (sub === 'manage') {
        if (!isLoaStaff(interaction.member)) {
          return interaction.reply({ content: "You don't have access to this command.", ephemeral: true });
        }
        const target = interaction.options.getUser('user');
        const existing = findActiveOrPendingLoa(target.id);
        if (!existing) {
          return interaction.reply({ content: `${target.tag} doesn't have an active or pending LOA.`, ephemeral: true });
        }
        const [loaId, loa] = existing;
        const embed = buildRequestEmbed(loa, loa.status === 'pending' ? '⏳ Pending' : '✅ Approved', loa.status === 'pending' ? 0xf1c40f : 0x2ecc71);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`loa_cancel_${loaId}`).setLabel('Cancel LOA').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`loa_extend_${loaId}`).setLabel('Extend LOA').setStyle(ButtonStyle.Primary)
        );
        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      }

      // ----- /loa list -----
      if (sub === 'list') {
        if (!isLoaStaff(interaction.member)) {
          return interaction.reply({ content: "You don't have access to this command.", ephemeral: true });
        }
        const active = Object.values(loas)
          .filter((l) => l.status === 'approved')
          .sort((a, b) => a.endTimestamp - b.endTimestamp);

        if (active.length === 0) {
          return interaction.reply({ content: 'Nobody is currently on LOA.', ephemeral: true });
        }

        const embed = new EmbedBuilder().setTitle('Active Leaves of Absence').setColor(0x2ecc71);
        for (const loa of active.slice(0, 25)) {
          const daysLeft = Math.max(0, Math.ceil((loa.endTimestamp - Date.now()) / 86400000));
          embed.addFields({
            name: loa.userTag,
            value: `${formatLoaDate(loa.startYear, loa.startMonth, loa.startDay)} → ${formatLoaDate(loa.endYear, loa.endMonth, loa.endDay)} (${daysLeft}d left)`,
          });
        }
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // ----- /loa help -----
      if (sub === 'help') {
        const embed = new EmbedBuilder()
          .setTitle('LOA System — How It Works')
          .setColor(0x5865f2)
          .setDescription(
            `**/loa request** — Recording Crew members can request a Leave of Absence (start date, end date, reason). ` +
            `Submitted in <#${LOA_CHANNEL_ID || 'the LOA channel'}>, then reviewed by staff.\n\n` +
            `Once approved, you'll automatically get the LOA role for the dates you requested, and it's removed automatically once your LOA ends.`
          );
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
    }

    // ---------- Modal submissions ----------
    if (interaction.isModalSubmit()) {
      // ----- New LOA request submitted -----
      if (interaction.customId === 'loa_request_modal') {
        const startRaw = interaction.fields.getTextInputValue('start_date');
        const endRaw = interaction.fields.getTextInputValue('end_date');
        const reason = interaction.fields.getTextInputValue('reason');

        const start = parseLoaDate(startRaw);
        const end = parseLoaDate(endRaw);
        if (!start || !end) {
          return interaction.reply({ content: 'Dates must be in MM/DD/YYYY format, e.g. `07/25/2026`.', ephemeral: true });
        }
        const startTimestamp = Date.UTC(start.year, start.month - 1, start.day);
        const endTimestamp = endOfDayUtc(end.year, end.month, end.day, LOA_TIMEZONE);
        if (endTimestamp <= startTimestamp) {
          return interaction.reply({ content: 'The end date has to be after the start date.', ephemeral: true });
        }

        const loaId = `${interaction.user.id}-${Date.now()}`;
        const loa = {
          userId: interaction.user.id,
          userTag: interaction.user.tag,
          startYear: start.year, startMonth: start.month, startDay: start.day,
          endYear: end.year, endMonth: end.month, endDay: end.day,
          startTimestamp, endTimestamp,
          reason,
          status: 'pending',
          requestedAt: Date.now(),
        };
        loas[loaId] = loa;
        saveLoas(loas);

        await interaction.reply(`⏳ <@${interaction.user.id}>'s LOA request has been submitted and is awaiting staff approval.`);

        if (LOA_STAFF_CHANNEL_ID) {
          const staffChannel = await client.channels.fetch(LOA_STAFF_CHANNEL_ID).catch(() => null);
          if (staffChannel) {
            const embed = buildRequestEmbed(loa, '⏳ Pending', 0xf1c40f);
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`loa_approve_${loaId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`loa_deny_${loaId}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
            );
            const staffMsg = await staffChannel.send({ embeds: [embed], components: [row] });
            loas[loaId].staffMessageId = staffMsg.id;
            saveLoas(loas);
          }
        }
        return;
      }

      // ----- Deny reason submitted -----
      if (interaction.customId.startsWith('loa_deny_modal_')) {
        const loaId = interaction.customId.replace('loa_deny_modal_', '');
        const loa = loas[loaId];
        if (!loa || loa.status !== 'pending') {
          return interaction.reply({ content: 'This request is no longer pending.', ephemeral: true });
        }
        const reason = interaction.fields.getTextInputValue('deny_reason');

        loa.status = 'denied';
        loa.deniedBy = interaction.user.tag;
        loa.denyReason = reason || null;
        saveLoas(loas);

        await interaction.reply({ content: 'Request denied.', ephemeral: true });

        if (LOA_CHANNEL_ID) {
          const loaChannel = await client.channels.fetch(LOA_CHANNEL_ID).catch(() => null);
          if (loaChannel) {
            await loaChannel.send(
              `❌ <@${loa.userId}>'s LOA request has been denied.${reason ? `\n**Reason:** ${reason}` : ''}`
            );
          }
        }

        if (loa.staffMessageId && LOA_STAFF_CHANNEL_ID) {
          const staffChannel = await client.channels.fetch(LOA_STAFF_CHANNEL_ID).catch(() => null);
          const staffMsg = await staffChannel?.messages.fetch(loa.staffMessageId).catch(() => null);
          if (staffMsg) {
            const embed = buildRequestEmbed(loa, `❌ Denied by ${interaction.user.tag}`, 0xe74c3c);
            await staffMsg.edit({ embeds: [embed], components: [] });
          }
        }
        return;
      }

      // ----- Extend LOA submitted -----
      if (interaction.customId.startsWith('loa_extend_modal_')) {
        const loaId = interaction.customId.replace('loa_extend_modal_', '');
        const loa = loas[loaId];
        if (!loa || loa.status !== 'approved') {
          return interaction.reply({ content: 'That LOA is no longer active.', ephemeral: true });
        }
        const newEndRaw = interaction.fields.getTextInputValue('new_end_date');
        const newEnd = parseLoaDate(newEndRaw);
        if (!newEnd) {
          return interaction.reply({ content: 'Date must be in MM/DD/YYYY format.', ephemeral: true });
        }
        const newEndTimestamp = endOfDayUtc(newEnd.year, newEnd.month, newEnd.day, LOA_TIMEZONE);
        if (newEndTimestamp <= loa.startTimestamp) {
          return interaction.reply({ content: 'New end date has to be after the LOA start date.', ephemeral: true });
        }

        loa.endYear = newEnd.year; loa.endMonth = newEnd.month; loa.endDay = newEnd.day;
        loa.endTimestamp = newEndTimestamp;
        saveLoas(loas);

        await interaction.reply({ content: `Extended to ${formatLoaDate(newEnd.year, newEnd.month, newEnd.day)}.`, ephemeral: true });

        if (LOA_CHANNEL_ID) {
          const loaChannel = await client.channels.fetch(LOA_CHANNEL_ID).catch(() => null);
          if (loaChannel) {
            await loaChannel.send(`📅 <@${loa.userId}>'s LOA has been extended to ${formatLoaDate(newEnd.year, newEnd.month, newEnd.day)}.`);
          }
        }
        return;
      }
    }

    // ---------- Buttons ----------
    if (interaction.isButton()) {
      // ----- Approve -----
      if (interaction.customId.startsWith('loa_approve_')) {
        if (!isLoaStaff(interaction.member)) {
          return interaction.reply({ content: "You don't have access to this.", ephemeral: true });
        }
        const loaId = interaction.customId.replace('loa_approve_', '');
        const loa = loas[loaId];
        if (!loa || loa.status !== 'pending') {
          return interaction.reply({ content: 'This request is no longer pending.', ephemeral: true });
        }

        loa.status = 'approved';
        loa.approvedBy = interaction.user.tag;
        loa.approvedAt = Date.now();
        saveLoas(loas);

        const guild = interaction.guild;
        const member = await guild.members.fetch(loa.userId).catch(() => null);
        const role = guild.roles.cache.get(LOA_ROLE_ID);
        if (member && role) {
          await member.roles.add(role).catch((err) => console.error('Failed to add LOA role:', err));
        }

        const embed = buildRequestEmbed(loa, `✅ Approved by ${interaction.user.tag}`, 0x2ecc71);
        await interaction.update({ embeds: [embed], components: [] });

        if (LOA_CHANNEL_ID) {
          const loaChannel = await client.channels.fetch(LOA_CHANNEL_ID).catch(() => null);
          if (loaChannel) {
            await loaChannel.send(
              `✅ <@${loa.userId}>'s LOA request has been approved! On leave from ` +
              `${formatLoaDate(loa.startYear, loa.startMonth, loa.startDay)} to ${formatLoaDate(loa.endYear, loa.endMonth, loa.endDay)}.`
            );
          }
        }
        return;
      }

      // ----- Deny (opens a modal for an optional reason) -----
      if (interaction.customId.startsWith('loa_deny_')) {
        if (!isLoaStaff(interaction.member)) {
          return interaction.reply({ content: "You don't have access to this.", ephemeral: true });
        }
        const loaId = interaction.customId.replace('loa_deny_', '');
        const loa = loas[loaId];
        if (!loa || loa.status !== 'pending') {
          return interaction.reply({ content: 'This request is no longer pending.', ephemeral: true });
        }

        const modal = new ModalBuilder().setCustomId(`loa_deny_modal_${loaId}`).setTitle('Deny LOA Request');
        const reasonInput = new TextInputBuilder()
          .setCustomId('deny_reason').setLabel('Reason (optional)')
          .setStyle(TextInputStyle.Paragraph).setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        return interaction.showModal(modal);
      }

      // ----- Cancel (from /loa manage) -----
      if (interaction.customId.startsWith('loa_cancel_')) {
        if (!isLoaStaff(interaction.member)) {
          return interaction.reply({ content: "You don't have access to this.", ephemeral: true });
        }
        const loaId = interaction.customId.replace('loa_cancel_', '');
        const loa = loas[loaId];
        if (!loa || loa.status !== 'approved') {
          return interaction.reply({ content: 'That LOA is no longer active.', ephemeral: true });
        }

        loa.status = 'cancelled';
        saveLoas(loas);

        const guild = interaction.guild;
        const member = await guild.members.fetch(loa.userId).catch(() => null);
        const role = guild.roles.cache.get(LOA_ROLE_ID);
        if (member && role && member.roles.cache.has(LOA_ROLE_ID)) {
          await member.roles.remove(role).catch((err) => console.error('Failed to remove LOA role on cancel:', err));
        }

        await interaction.update({ content: `LOA for <@${loa.userId}> has been cancelled.`, embeds: [], components: [] });

        if (LOA_CHANNEL_ID) {
          const loaChannel = await client.channels.fetch(LOA_CHANNEL_ID).catch(() => null);
          if (loaChannel) {
            await loaChannel.send(`🛑 <@${loa.userId}>'s LOA has been ended early by staff.`);
          }
        }
        return;
      }

      // ----- Extend (from /loa manage — opens a modal) -----
      if (interaction.customId.startsWith('loa_extend_')) {
        if (!isLoaStaff(interaction.member)) {
          return interaction.reply({ content: "You don't have access to this.", ephemeral: true });
        }
        const loaId = interaction.customId.replace('loa_extend_', '');
        const loa = loas[loaId];
        if (!loa || loa.status !== 'approved') {
          return interaction.reply({ content: 'That LOA is no longer active.', ephemeral: true });
        }

        const modal = new ModalBuilder().setCustomId(`loa_extend_modal_${loaId}`).setTitle('Extend LOA');
        const newEndInput = new TextInputBuilder()
          .setCustomId('new_end_date').setLabel('New End Date (MM/DD/YYYY)')
          .setStyle(TextInputStyle.Short).setRequired(true)
          .setPlaceholder(formatLoaDate(loa.endYear, loa.endMonth, loa.endDay));
        modal.addComponents(new ActionRowBuilder().addComponents(newEndInput));
        return interaction.showModal(modal);
      }
    }
  } catch (err) {
    console.error('LOA interaction error:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong processing that. Check the logs.', ephemeral: true }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
