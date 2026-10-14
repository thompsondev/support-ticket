import {
  ActivityType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  Client,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  Guild,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  MessageReaction,
  PartialMessageReaction,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
} from 'discord.js';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord-api-types/v10';
import { env, validateEnv } from './env';
import { commands } from './commands';
import { onInteraction } from './interactions';
import { autoCloseSweep, logToGuild } from './tickets';
import {
  addReferral,
  addTempVoice,
  clearAfk,
  convertReferral,
  dbRun,
  deleteReminder,
  findWatchByGuild,
  dueReminders,
  expiredGiveaways,
  expiredPolls,
  getAfk,
  getConfig,
  getReactionRole,
  getSatellite,
  getStarEntry,
  getSticky,
  getTags,
  getTicketByChannel,
  getTicketTypes,
  isTempVoice,
  listCustomCommands,
  removeTempVoice,
  setSatellite,
  updateSticky,
  updateTicket,
  updateWatch,
  upsertStarEntry,
} from './db';
import { endPoll } from './votes';
import { endGiveaway } from './giveaways';
import { welcomeCard } from './cards';
import { handleSatelliteMessage, satelliteReplyText } from './satellites';
import { ephemeral, isOwnerId, isStaff, COLORS } from './util';
import { startWeb } from './web';

validateEnv();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    // privileged — enable "Server Members Intent" in the dev portal for welcome/autorole
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});

async function registerCommands(): Promise<void> {
  const rest = new REST().setToken(env.token);
  // "Route to Support" — message context command installable on a USER's
  // account, so it works in servers where the bot is not a member.
  const contextCmds = [
    new ContextMenuCommandBuilder()
      .setName('Route to Support')
      .setType(ApplicationCommandType.Message)
      .setIntegrationTypes(
        ApplicationIntegrationType.GuildInstall,
        ApplicationIntegrationType.UserInstall,
      )
      .setContexts(
        InteractionContextType.Guild,
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel,
      )
      .toJSON() as RESTPostAPIApplicationCommandsJSONBody,
  ];
  const body: RESTPostAPIApplicationCommandsJSONBody[] = [
    ...[...commands.values()].map(
      (c) => c.data.toJSON() as RESTPostAPIApplicationCommandsJSONBody,
    ),
    ...contextCmds,
  ];
  if (env.guildId) {
    await rest.put(Routes.applicationGuildCommands(env.clientId, env.guildId), { body });
    console.log(`Registered ${body.length} commands to guild ${env.guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(env.clientId), { body });
    console.log(`Registered ${body.length} commands globally`);
  }
  // enable user-installable commands on the application (dev portal →
  // Installation → User Install). Best-effort — some apps must toggle it
  // in the portal instead.
  try {
    await rest.patch(Routes.currentApplication(), {
      body: {
        integration_types_config: {
          '0': {},
          '1': { oauth2_install_params: { scopes: ['applications.commands'], permissions: '0' } },
        },
      },
    });
  } catch (err) {
    console.warn('Could not set user-install via API — enable "User Install" in dev portal → Installation.', err);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error('Command registration failed:', err);
  }
  // maintenance sweep every 5 minutes: ticket inactivity + poll expiry
  setInterval(async () => {
    autoCloseSweep(client).catch(console.error);
    for (const p of await expiredPolls(Date.now())) endPoll(client, p).catch(console.error);
  }, 5 * 60_000);
  // fast sweep every 30s: reminders + giveaway endings
  setInterval(async () => {
    try {
      for (const r of await dueReminders(Date.now())) {
        const ch = await client.channels.fetch(r.channel_id).catch(() => null);
        if (ch?.isSendable()) {
          await ch.send(`⏰ <@${r.user_id}> — reminder: ${r.text}`).catch(() => {});
        }
        await deleteReminder(r.id);
      }
      for (const g of await expiredGiveaways(Date.now())) {
        await endGiveaway(client, g).catch(console.error);
      }
    } catch (err) {
      console.error('fast sweep error:', err);
    }
  }, 30_000);
  // rotating presence
  const statuses = ['/help', `${c.guilds.cache.size} servers`, 'tickets & community', 'watching for spam'];
  let si = 0;
  c.user.setActivity(statuses[0], { type: ActivityType.Watching });
  setInterval(async () => {
    si = (si + 1) % statuses.length;
    statuses[1] = `${client.guilds.cache.size} servers`;
    client.user?.setActivity(statuses[si], { type: ActivityType.Watching });
  }, 120_000);
  startWeb(client);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isAutocomplete()) {
      if (!i.inCachedGuild()) return;
      const focused = String(i.options.getFocused()).toLowerCase();
      if (i.commandName === 'tag') {
        const matches = (await getTags(i.guildId))
          .filter((t) => t.name.includes(focused))
          .slice(0, 25);
        await i.respond(matches.map((t) => ({ name: t.name, value: t.name })));
        return;
      }
      if (i.commandName === 'cmd') {
        const matches = (await listCustomCommands(i.guildId))
          .filter((c) => c.name.includes(focused))
          .slice(0, 25);
        await i.respond(matches.map((c) => ({ name: `${c.name} (${c.uses}×)`, value: c.name })));
        return;
      }
      const matches = (await getTicketTypes(i.guildId))
        .filter(
          (t) =>
            t.type_id.includes(focused) || t.label.toLowerCase().includes(focused),
        )
        .slice(0, 25);
      await i.respond(
        matches.map((t) => ({ name: `${t.emoji ?? ''} ${t.label}`.trim(), value: t.type_id })),
      );
      return;
    }
    // godmode kill-switch: block everything in a disabled guild (owners bypass)
    if (i.guildId && (await getConfig(i.guildId)).disabled && !isOwnerId(i.user.id)) {
      if (i.isRepliable() && !i.replied && !i.deferred) {
        await i
          .reply(ephemeral('🚫 This bot is currently disabled in this server. Contact the bot administration.'))
          .catch(() => {});
      }
      return;
    }
    if (i.isChatInputCommand()) {
      if (!i.inCachedGuild()) {
        await i.reply({ content: 'Commands only work inside a server.', flags: MessageFlags.Ephemeral });
        return;
      }
      const cmd = commands.get(i.commandName);
      if (cmd) await cmd.execute(i);
      return;
    }
    // user-installable context command — works even in servers where the bot
    // isn't installed. Right-click a member's message → Apps → Route to Support.
    if (i.isMessageContextMenuCommand() && i.commandName === 'Route to Support') {
      if (!env.hubInvite) {
        await i.reply({ content: 'The support hub invite is not configured (HUB_INVITE).', flags: MessageFlags.Ephemeral });
        return;
      }
      const target = i.targetMessage;
      const guildName = i.guild?.name ?? 'this community';
      const text = await satelliteReplyText(
        { hub_invite: env.hubInvite, reply_text: null, ai_enabled: 1 },
        target.content || 'a support request',
        guildName,
      );
      await i.reply({
        embeds: [new EmbedBuilder().setColor(COLORS.info).setDescription(text)],
      });
      if (i.guildId && !target.author.bot) {
        await addReferral(i.guildId, target.author.id, i.channelId ?? '', target.id).catch(() => {});
      }
      return;
    }
    await onInteraction(i);
  } catch (err) {
    console.error('Command error:', err);
    if (i.isRepliable() && !i.replied && !i.deferred) {
      await i
        .reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
});

// track last activity for auto-close + first staff response + afk + sticky
client.on(Events.MessageCreate, async (m) => {
  if (!m.inGuild() || m.author.bot) return;
  try {
    const res = await dbRun(
      `UPDATE tickets SET last_message_at = ?, warned_at = NULL
       WHERE channel_id = ? AND status = 'open'`,
      [Date.now(), m.channelId],
    );
    // mark the first staff reply in a ticket (drives escalation sweep)
    if (Number(res.changes) > 0 && m.member && await isStaff(m.member)) {
      const t = await getTicketByChannel(m.channelId);
      if (t && !t.first_staff_reply_at && m.author.id !== t.owner_id) {
        await updateTicket(t.id, { first_staff_reply_at: Date.now() });
      }
    }

    // AFK: clear the author's status; reply to mentions of afk users
    if (await getAfk(m.guild.id, m.author.id)) {
      await clearAfk(m.guild.id, m.author.id);
      if (m.channel.isSendable()) {
        await m.channel.send(`👋 Welcome back <@${m.author.id}> — AFK cleared.`).catch(() => {});
      }
    }
    for (const [uid] of m.mentions.users) {
      if (uid === m.author.id) continue;
      const a = await getAfk(m.guild.id, uid);
      if (a && m.channel.isSendable()) {
        await m.channel
          .send(`💤 <@${uid}> is AFK${a.reason ? `: ${a.reason}` : ''} (<t:${Math.floor(a.since / 1000)}:R>)`)
          .catch(() => {});
      }
    }

    // satellite auto-responder — routes support questions to the hub server
    await handleSatelliteMessage(m);

    // sticky: re-pin to bottom after activity (min 15s between re-posts)
    const st = await getSticky(m.channelId);
    if (st && st.guild_id === m.guild.id && m.id !== st.last_message_id) {
      if (Date.now() - (st.last_post_at ?? 0) > 15_000) {
        if (st.last_message_id && 'messages' in m.channel) {
          await m.channel.messages.delete(st.last_message_id).catch(() => {});
        }
        if (m.channel.isSendable()) {
          const msg = await m.channel.send({
            embeds: [new EmbedBuilder().setDescription(`📌 ${st.content}`).setColor(COLORS.warn)],
          });
          await updateSticky(m.channelId, msg.id, Date.now());
        }
      }
    }
  } catch (err) {
    console.error('messageCreate error:', err);
  }
});

// ---------- reaction roles ----------

async function applyReactionRole(
  reaction: { message: { id: string; guild: Guild | null }; emoji: { id: string | null; name: string | null } },
  userId: string,
  add: boolean,
) {
  const guild = reaction.message.guild;
  if (!guild) return;
  const key = reaction.emoji.id ?? reaction.emoji.name;
  if (!key) return;
  const rr = await getReactionRole(reaction.message.id, key);
  if (!rr || rr.guild_id !== guild.id) return;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || member.user.bot) return;
  if (add) await member.roles.add(rr.role_id).catch(() => {});
  else await member.roles.remove(rr.role_id).catch(() => {});
}

// ---------- starboard ----------

const STAR_EMOJIS = new Set(['⭐', '🌟', '💫']);

async function handleStarboard(reaction: MessageReaction | PartialMessageReaction): Promise<void> {
  const emojiName = reaction.emoji.name;
  if (!emojiName || !STAR_EMOJIS.has(emojiName)) return;
  const msg = reaction.message.partial
    ? await reaction.message.fetch().catch(() => null)
    : reaction.message;
  if (!msg?.guild || msg.author?.bot) return;
  const cfg = await getConfig(msg.guild.id);
  if (cfg.disabled || !cfg.starboard_channel_id) return;
  if (msg.channelId === cfg.starboard_channel_id) return; // don't star starboard posts

  const stars = [...STAR_EMOJIS].reduce((n, e) => n + (msg.reactions.cache.get(e)?.count ?? 0), 0);
  const threshold = cfg.starboard_threshold > 0 ? cfg.starboard_threshold : 3;
  const entry = await getStarEntry(msg.id);
  if (stars < threshold) {
    if (entry) await upsertStarEntry(msg.id, msg.guild.id, msg.channelId, entry.star_message_id, stars);
    return;
  }

  const starChan = await msg.guild.channels.fetch(cfg.starboard_channel_id).catch(() => null);
  if (!starChan?.isSendable()) return;
  const content = `⭐ **${stars}** | <#${msg.channelId}>`;
  const embed = new EmbedBuilder()
    .setAuthor({
      name: msg.author?.tag ?? 'Unknown',
      iconURL: msg.author?.displayAvatarURL(),
    })
    .setDescription(msg.content?.slice(0, 1000) || '*attachment or embed*')
    .addFields({ name: 'Source', value: `[jump to message](${msg.url})` })
    .setColor(COLORS.warn)
    .setTimestamp(msg.createdTimestamp);
  const img = msg.attachments.first()?.url;
  if (img && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(img)) embed.setImage(img);

  if (entry?.star_message_id) {
    const sm = await starChan.messages.fetch(entry.star_message_id).catch(() => null);
    if (sm) {
      await sm.edit({ content, embeds: [embed] }).catch(() => {});
      await upsertStarEntry(msg.id, msg.guild.id, msg.channelId, entry.star_message_id, stars);
      return;
    }
  }
  const nm = await starChan.send({ content, embeds: [embed] }).catch(() => null);
  if (nm) await upsertStarEntry(msg.id, msg.guild.id, msg.channelId, nm.id, stars);
}

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  const r = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
  if (!r) return;
  await applyReactionRole(r, user.id, true).catch(() => {});
  await handleStarboard(r).catch(() => {});
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.bot) return;
  const r = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
  if (!r) return;
  await applyReactionRole(r, user.id, false).catch(() => {});
  await handleStarboard(r).catch(() => {});
});

// ---------- join-to-create voice ----------

client.on(Events.VoiceStateUpdate, async (oldS, newS) => {
  try {
    const cfg = await getConfig(newS.guild.id);
    if (cfg.disabled) return;

    // joined the hub → create a personal room and move them
    if (cfg.voice_hub_channel_id && newS.channelId === cfg.voice_hub_channel_id && newS.member) {
      const room = await newS.guild.channels
        .create({
          name: `🔊 ${newS.member.displayName}'s room`,
          type: ChannelType.GuildVoice,
          parent: newS.channel?.parentId ?? undefined,
        })
        .catch(() => null);
      if (room) {
        await addTempVoice(room.id, newS.guild.id, newS.member.id);
        await newS.member.voice.setChannel(room).catch(() => {});
      }
    }

    // temp room emptied → delete it
    const left = oldS.channel;
    if (left && await isTempVoice(left.id) && left.members.size === 0) {
      await left.delete().catch(() => {});
      await removeTempVoice(left.id);
    }
  } catch (err) {
    console.error('voiceStateUpdate error:', err);
  }
});

// ---------- audit logging (leave / delete / edit) ----------

client.on(Events.GuildMemberRemove, async (member) => {
  const cfg = await getConfig(member.guild.id);
  if (!cfg.log_channel_id || cfg.disabled) return;
  const embed = new EmbedBuilder()
    .setTitle('👋 Member left')
    .setDescription(`${member.user.tag} (<@${member.id}>)`)
    .addFields(
      { name: 'ID', value: member.id, inline: true },
      {
        name: 'Joined',
        value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'unknown',
        inline: true,
      },
    )
    .setColor(COLORS.info)
    .setTimestamp();
  logToGuild(member.guild, embed).catch(() => {});
});

client.on(Events.MessageDelete, async (message) => {
  if (!message.guild || message.author?.bot) return;
  const cfg = await getConfig(message.guild.id);
  if (!cfg.log_channel_id || cfg.disabled) return;
  const embed = new EmbedBuilder()
    .setTitle('🗑️ Message deleted')
    .setDescription(
      `${message.author ? `<@${message.author.id}>` : 'Unknown author'} in <#${message.channelId}>\n` +
        (message.content ? `> ${message.content.slice(0, 500)}` : '*content unavailable (uncached)*'),
    )
    .setColor(COLORS.closed)
    .setTimestamp();
  logToGuild(message.guild, embed).catch(() => {});
});

client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
  const m = oldMsg.partial ? await oldMsg.fetch().catch(() => null) : oldMsg;
  if (!m?.guild || m.author?.bot) return;
  if (m.content === newMsg.content) return;
  const cfg = await getConfig(m.guild.id);
  if (!cfg.log_channel_id || cfg.disabled) return;
  const embed = new EmbedBuilder()
    .setTitle('✏️ Message edited')
    .setDescription(`<@${m.author.id}> in <#${m.channelId}> — [jump](${newMsg.url})`)
    .addFields(
      { name: 'Before', value: (m.content || '*uncached*').slice(0, 500) },
      { name: 'After', value: (newMsg.content || '*uncached*').slice(0, 500) },
    )
    .setColor(COLORS.info)
    .setTimestamp();
  logToGuild(m.guild, embed).catch(() => {});
});

// welcome message + autorole
client.on(Events.GuildMemberAdd, async (member) => {
  const cfg = await getConfig(member.guild.id);
  // referral conversion — a user we redirected from a satellite just joined the hub
  const ref = await convertReferral(member.id, member.guild.id);
  if (ref) {
    const sat = await getSatellite(ref.satellite_guild_id);
    const fromName = client.guilds.cache.get(ref.satellite_guild_id)?.name ?? ref.satellite_guild_id;
    logToGuild(
      member.guild,
      new EmbedBuilder()
        .setTitle('📨 Referral joined')
        .setColor(COLORS.info)
        .setDescription(
          `<@${member.id}> was routed here from **${fromName}**` +
            (sat ? ` (satellite ${sat.hub_invite})` : ''),
        )
        .setTimestamp(),
    ).catch(() => {});
  }
  if (cfg.autorole_id) {
    await member.roles.add(cfg.autorole_id).catch(() => {});
  }
  if (cfg.welcome_channel_id) {
    const ch = await member.guild.channels.fetch(cfg.welcome_channel_id).catch(() => null);
    if (ch?.isSendable()) {
      const text = (cfg.welcome_message ?? 'Welcome {user} to **{server}**! You are member #{count}.')
        .replaceAll('{user}', `${member}`)
        .replaceAll('{server}', member.guild.name)
        .replaceAll('{count}', String(member.guild.memberCount));
      const card = cfg.welcome_card ? await welcomeCard(member) : null;
      await ch
        .send({
          embeds: [
            new EmbedBuilder().setDescription(`👋 ${text}`).setColor(COLORS.open).setTimestamp(Date.now()),
          ],
          files: card ? [card] : [],
        })
        .catch(() => {});
    }
  }
});

// ---------- satellite auto-arm on join ----------

// When the bot is authorized into a guild that someone tracked via the
// dashboard's "add coin server" flow, mark the watchlist entry joined and —
// if this instance has a hub configured — arm satellite mode automatically.
client.on(Events.GuildCreate, async (guild) => {
  try {
    const w = await findWatchByGuild(guild.id);
    if (!w) return; // organic install — admin configures via /satellite or dashboard
    if (w.status !== 'joined') await updateWatch(w.id, { status: 'joined' }).catch(() => {});

    if (!env.hubGuildId || (await getSatellite(guild.id))) return;
    const hub =
      client.guilds.cache.get(env.hubGuildId) ??
      (await client.guilds.fetch(env.hubGuildId).catch(() => null));
    let inviteUrl = '';
    if (hub) {
      const chan = hub.channels.cache.find(
        (c) =>
          c.isTextBased() &&
          !c.isThread() &&
          'createInvite' in c &&
          c.permissionsFor(client.user!.id)?.has(PermissionFlagsBits.CreateInstantInvite),
      );
      const inv =
        chan && 'createInvite' in chan
          ? await chan.createInvite({ maxAge: 0, maxUses: 0, reason: 'satellite auto-link' }).catch(() => null)
          : null;
      inviteUrl = inv?.url ?? '';
    }
    await setSatellite(guild.id, env.hubGuildId, inviteUrl || 'ask the hub admin for the invite', {
      enabled: inviteUrl ? 1 : 0,
    });
    const sc = guild.systemChannel;
    if (sc?.isSendable()) {
      await sc
        .send({
          embeds: [
            new EmbedBuilder()
              .setTitle('🛰️ Satellite mode armed')
              .setColor(COLORS.info)
              .setDescription(
                `This server is linked to the support hub **${hub?.name ?? env.hubGuildId}**. ` +
                  'Support questions here get an automatic reply with the hub invite.\n' +
                  'Admins: `/satellite status` to review, `/satellite toggle` to pause, `/satellite unlink` to remove.',
              ),
          ],
        })
        .catch(() => {});
    }
  } catch (err) {
    console.error('GuildCreate satellite error:', err);
  }
});

client.login(env.token);
