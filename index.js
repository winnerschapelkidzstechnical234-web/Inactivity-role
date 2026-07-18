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

client.login(process.env.DISCORD_TOKEN);

