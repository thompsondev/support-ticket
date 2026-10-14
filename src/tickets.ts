import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  PermissionFlagsBits,
  TextChannel,
  User,
} from 'discord.js';
import { createTranscript, ExportReturnType } from 'discord-html-transcripts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addNote,
  getConfig,
  getOpenReferral,
  getTicketById,
  getTicketType,
  insertTicket,
  isBlacklisted,
  isGloballyBlacklisted,
  lastOpenAt,
  linkReferralTicket,
  nextTicketNumber,
  openTicketCount,
  openTickets,
  touchCooldown,
  updateTicket,
  type Ticket,
} from './db';
import { COLORS, controlButtons, pad, ticketEmbed } from './util';

export type CreateResult = { ok: true; channel: TextChannel; ticket: Ticket } | { ok: false; reason: string };

const STAFF_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
];

export async function createTicket(
  guild: Guild,
  user: User,
  typeId: string,
  subject: string | null,
  description: string | null,
): Promise<CreateResult> {
  const cfg = await getConfig(guild.id);

  if (await isGloballyBlacklisted(user.id)) {
    return { ok: false, reason: 'You are restricted from using this system.' };
  }
  if (await isBlacklisted(guild.id, user.id)) {
    return { ok: false, reason: 'You are blacklisted from opening tickets.' };
  }
  const type = await getTicketType(guild.id, typeId);
  if (!type) {
    return { ok: false, reason: 'That ticket category no longer exists — ask staff to refresh the panel.' };
  }

  const since = await lastOpenAt(guild.id, user.id);
  if (cfg.cooldown_seconds > 0 && Date.now() - since < cfg.cooldown_seconds * 1000) {
    const wait = Math.ceil((cfg.cooldown_seconds * 1000 - (Date.now() - since)) / 1000);
    return { ok: false, reason: `Slow down — you can open another ticket in ${wait}s.` };
  }

  const open = await openTicketCount(guild.id, user.id);
  if (open >= cfg.max_tickets) {
    return { ok: false, reason: `You already have ${open} open ticket(s) (limit: ${cfg.max_tickets}).` };
  }

  const me = guild.members.me;
  if (!me) return { ok: false, reason: 'Bot member not found in guild.' };

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
      ],
    },
    ...(cfg.support_role_id ? [{ id: cfg.support_role_id, allow: STAFF_PERMS }] : []),
    ...(cfg.admin_role_id ? [{ id: cfg.admin_role_id, allow: STAFF_PERMS }] : []),
  ];

  const number = await nextTicketNumber(guild.id);
  const channel = await guild.channels.create({
    name: `ticket-${pad(number)}`,
    type: ChannelType.GuildText,
    parent: cfg.open_category_id ?? undefined,
    topic: `Ticket #${pad(number)} | ${type?.label ?? typeId} | Owner: ${user.id}`,
    permissionOverwrites: overwrites,
  });

  const ticket = await insertTicket({
    number,
    guild_id: guild.id,
    channel_id: channel.id,
    owner_id: user.id,
    type: typeId,
    subject,
    description,
    status: 'open',
    priority: 'medium',
    claimed_by: null,
    control_message_id: null,
    created_at: Date.now(),
    closed_at: null,
    closed_by: null,
    close_reason: null,
    warned_at: null,
    last_message_at: Date.now(),
    first_staff_reply_at: null,
    escalated_at: null,
  });

  // referral attribution — user arrived via a satellite auto-reply
  const ref = await getOpenReferral(user.id);
  if (ref) {
    await linkReferralTicket(user.id, ticket.id);
    const fromName = guild.client.guilds.cache.get(ref.satellite_guild_id)?.name ?? ref.satellite_guild_id;
    await addNote(ticket.id, guild.client.user?.id ?? 'system', `📨 Referred from satellite server **${fromName}**`).catch(
      () => {},
    );
  }

  const ping = cfg.support_role_id ? `<@&${cfg.support_role_id}>` : '';
  const msg = await channel.send({
    content: `${user} ${ping}`.trim(),
    embeds: [await ticketEmbed(ticket)],
    components: [controlButtons(ticket)],
  });
  await updateTicket(ticket.id, { control_message_id: msg.id });
  await touchCooldown(guild.id, user.id);

  await logToGuild(guild, logEmbed('Ticket opened', COLORS.open, ticket, `Opened by ${user.tag}`));
  return { ok: true, channel, ticket };
}

async function buildTranscript(channel: TextChannel, ticket: Ticket) {
  const filename = `transcript-ticket-${pad(ticket.number)}.html`;
  const attachment = await createTranscript(channel, {
    limit: -1,
    returnType: ExportReturnType.Attachment,
    filename,
    poweredBy: false,
  });
  const buf = Buffer.from(attachment.attachment as Buffer | string);
  const dir = join('transcripts', ticket.guild_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), buf);
  return new AttachmentBuilder(buf, { name: filename });
}

export async function closeTicket(
  client: Client,
  ticket: Ticket,
  closer: User,
  reason: string | null,
): Promise<void> {
  const guild = await client.guilds.fetch(ticket.guild_id);
  const channel = (await guild.channels.fetch(ticket.channel_id)) as TextChannel | null;
  if (!channel) {
    await updateTicket(ticket.id, { status: 'closed', closed_at: Date.now(), closed_by: closer.id });
    return;
  }

  const transcript = await buildTranscript(channel, ticket).catch(() => null);
  const now = Date.now();
  await updateTicket(ticket.id, {
    status: 'closed',
    closed_at: now,
    closed_by: closer.id,
    close_reason: reason,
  });
  const updated = { ...ticket, status: 'closed' as const, closed_at: now, closed_by: closer.id, close_reason: reason };

  await channel.permissionOverwrites
    .edit(ticket.owner_id, { SendMessages: false })
    .catch(() => {});
  await channel.setName(`closed-${pad(ticket.number)}`).catch(() => {});

  const cfg = await getConfig(ticket.guild_id);
  if (cfg.closed_category_id) await channel.setParent(cfg.closed_category_id).catch(() => {});

  // refresh the control message with closed-state buttons
  await refreshControlMessage(channel, updated);

  // send transcript to transcript/log channel
  const destId = cfg.transcript_channel_id ?? cfg.log_channel_id;
  if (destId) {
    const dest = await guild.channels.fetch(destId).catch(() => null);
    if (dest?.isTextBased()) {
      await dest
        .send({
          embeds: [
            logEmbed('Ticket closed', COLORS.closed, updated, `Closed by ${closer.tag}${reason ? ` — ${reason}` : ''}`),
          ],
          files: transcript ? [transcript] : [],
        })
        .catch(() => {});
    }
  }

  // ask the owner for a rating
  const owner = await client.users.fetch(ticket.owner_id).catch(() => null);
  if (owner) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...[1, 2, 3, 4, 5].map((s) =>
        new ButtonBuilder()
          .setCustomId(`rate:${ticket.id}:${s}`)
          .setLabel(`${s}★`)
          .setStyle(ButtonStyle.Secondary),
      ),
    );
    await owner
      .send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`How was your experience on ticket #${pad(ticket.number)}?`)
            .setDescription('Tap a star rating below — feedback helps us improve.')
            .setColor(COLORS.info),
        ],
        components: [row],
      })
      .catch(() => {});
  }

  await logToGuild(guild, logEmbed('Ticket closed', COLORS.closed, updated, `Closed by ${closer.tag}`));
}

export async function reopenTicket(client: Client, ticket: Ticket): Promise<void> {
  const guild = await client.guilds.fetch(ticket.guild_id);
  const channel = (await guild.channels.fetch(ticket.channel_id)) as TextChannel | null;
  if (!channel) return;

  const cfg = await getConfig(ticket.guild_id);
  await updateTicket(ticket.id, {
    status: 'open',
    closed_at: null,
    closed_by: null,
    close_reason: null,
    warned_at: null,
    escalated_at: null,
    last_message_at: Date.now(),
  });
  const updated = (await getTicketById(ticket.id))!;

  await channel.permissionOverwrites
    .edit(ticket.owner_id, { ViewChannel: true, SendMessages: true })
    .catch(() => {});
  await channel.setName(`ticket-${pad(ticket.number)}`).catch(() => {});
  if (cfg.open_category_id) await channel.setParent(cfg.open_category_id).catch(() => {});

  await refreshControlMessage(channel, updated);
  await channel.send({ embeds: [new EmbedBuilder().setDescription('♻️ Ticket reopened.').setColor(COLORS.open)] });
  await logToGuild(guild, logEmbed('Ticket reopened', COLORS.open, updated, null));
}

export async function deleteTicket(client: Client, ticket: Ticket, staff: User): Promise<void> {
  const guild = await client.guilds.fetch(ticket.guild_id);
  const channel = (await guild.channels.fetch(ticket.channel_id)) as TextChannel | null;

  // always try to capture a transcript before destroying the channel
  let file: AttachmentBuilder | null = null;
  if (channel && ticket.status !== 'closed') {
    file = await buildTranscript(channel, ticket).catch(() => null);
  }

  await updateTicket(ticket.id, { status: 'deleted' });

  const cfg = await getConfig(ticket.guild_id);
  const destId = cfg.transcript_channel_id ?? cfg.log_channel_id;
  if (destId && file) {
    const dest = await guild.channels.fetch(destId).catch(() => null);
    if (dest?.isTextBased()) {
      await dest
        .send({
          embeds: [logEmbed('Ticket deleted', COLORS.closed, ticket, `Deleted by ${staff.tag}`)],
          files: [file],
        })
        .catch(() => {});
    }
  }

  await logToGuild(guild, logEmbed('Ticket deleted', COLORS.closed, ticket, `Deleted by ${staff.tag}`));
  if (channel) await channel.delete(`Ticket deleted by ${staff.tag}`).catch(() => {});
}

export async function refreshControlMessage(channel: TextChannel, ticket: Ticket): Promise<void> {
  if (!ticket.control_message_id) return;
  const msg = await channel.messages.fetch(ticket.control_message_id).catch(() => null);
  if (!msg) return;
  await msg
    .edit({ embeds: [await ticketEmbed(ticket)], components: [controlButtons(ticket)] })
    .catch(() => {});
}

export function logEmbed(title: string, color: number, t: Ticket, detail: string | null): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: 'Ticket', value: `#${pad(t.number)} (${t.type})`, inline: true },
      { name: 'Owner', value: `<@${t.owner_id}>`, inline: true },
    )
    .setTimestamp(Date.now());
  if (detail) e.setDescription(detail);
  return e;
}

export async function logToGuild(guild: Guild, embed: EmbedBuilder): Promise<void> {
  const cfg = await getConfig(guild.id);
  if (!cfg.log_channel_id) return;
  const ch = await guild.channels.fetch(cfg.log_channel_id).catch(() => null);
  if (ch?.isTextBased()) await ch.send({ embeds: [embed] }).catch(() => {});
}

// ---------- inactivity auto-close ----------

export async function autoCloseSweep(client: Client): Promise<void> {
  const now = Date.now();
  for (const t of await openTickets()) {
    try {
      const cfg = await getConfig(t.guild_id);

      // escalation: ping support if no staff has replied within escalation_minutes
      if (
        cfg.escalation_minutes > 0 &&
        !t.first_staff_reply_at &&
        !t.escalated_at &&
        now - t.created_at > cfg.escalation_minutes * 60_000
      ) {
        const guild = await client.guilds.fetch(t.guild_id).catch(() => null);
        const channel = guild
          ? ((await guild.channels.fetch(t.channel_id).catch(() => null)) as TextChannel | null)
          : null;
        if (channel) {
          await channel
            .send({
              content: cfg.support_role_id ? `<@&${cfg.support_role_id}>` : undefined,
              embeds: [
                new EmbedBuilder()
                  .setDescription(`🚨 No staff response in ${cfg.escalation_minutes}m — this ticket needs attention.`)
                  .setColor(COLORS.closed),
              ],
            })
            .catch(() => {});
          await updateTicket(t.id, { escalated_at: now });
        }
      }

      if (!cfg.autoclose_hours) continue;
      const last = t.last_message_at ?? t.created_at;
      const idleMs = cfg.autoclose_hours * 3_600_000;

      if (!t.warned_at && now - last > idleMs) {
        const guild = await client.guilds.fetch(t.guild_id).catch(() => null);
        const channel = guild
          ? ((await guild.channels.fetch(t.channel_id).catch(() => null)) as TextChannel | null)
          : null;
        if (channel) {
          await channel
            .send({
              embeds: [
                new EmbedBuilder()
                  .setDescription('⏰ This ticket has been inactive and will be auto-closed in 1 hour.')
                  .setColor(COLORS.warn),
              ],
            })
            .catch(() => {});
          await updateTicket(t.id, { warned_at: now });
        }
      } else if (t.warned_at && now - t.warned_at > 3_600_000) {
        await closeTicket(client, t, client.user!, 'Auto-closed due to inactivity');
      }
    } catch {
      // keep sweeping other tickets
    }
  }
}
