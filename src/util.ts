import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { getConfig, getTicketType, type Ticket } from './db';
import { env } from './env';

export const COLORS = {
  open: 0x57f287,
  closed: 0xed4245,
  info: 0x5865f2,
  warn: 0xfee75c,
};

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export function priorityLabel(p: string): string {
  const map: Record<string, string> = {
    low: '🟢 Low',
    medium: '🟡 Medium',
    high: '🟠 High',
    urgent: '🔴 Urgent',
  };
  return map[p] ?? p;
}

export function pad(n: number): string {
  return String(n).padStart(4, '0');
}

export function isOwnerId(userId: string): boolean {
  return env.ownerIds.includes(userId);
}

export async function isStaff(member: GuildMember): Promise<boolean> {
  if (isOwnerId(member.id)) return true; // godmode
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const cfg = await getConfig(member.guild.id);
  return [cfg.support_role_id, cfg.admin_role_id].some(
    (r) => r != null && member.roles.cache.has(r),
  );
}

export async function ticketEmbed(t: Ticket): Promise<EmbedBuilder> {
  const type = await getTicketType(t.guild_id, t.type);
  const e = new EmbedBuilder()
    .setTitle(`${type?.emoji ?? '🎫'} Ticket #${pad(t.number)} — ${type?.label ?? t.type}`)
    .setColor(t.status === 'open' ? COLORS.open : COLORS.closed)
    .addFields(
      { name: 'Opened by', value: `<@${t.owner_id}>`, inline: true },
      { name: 'Status', value: t.status === 'open' ? '🟢 Open' : '🔴 Closed', inline: true },
      { name: 'Priority', value: priorityLabel(t.priority), inline: true },
    )
    .setTimestamp(t.created_at);
  if (t.subject) e.addFields({ name: 'Subject', value: t.subject });
  if (t.description) e.addFields({ name: 'Description', value: t.description.slice(0, 1024) });
  if (t.claimed_by) e.addFields({ name: 'Claimed by', value: `<@${t.claimed_by}>`, inline: true });
  if (t.closed_by) e.addFields({ name: 'Closed by', value: `<@${t.closed_by}>`, inline: true });
  if (t.close_reason) e.addFields({ name: 'Close reason', value: t.close_reason });
  return e;
}

export function controlButtons(t: Ticket): ActionRowBuilder<ButtonBuilder> {
  if (t.status === 'open') {
    const claim = new ButtonBuilder()
      .setCustomId('ticket:claim')
      .setEmoji('🙋')
      .setStyle(ButtonStyle.Primary);
    if (t.claimed_by) claim.setLabel(`Claimed`).setDisabled(true);
    else claim.setLabel('Claim');
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      claim,
      new ButtonBuilder()
        .setCustomId('ticket:close')
        .setLabel('Close')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger),
    );
  }
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:reopen')
      .setLabel('Reopen')
      .setEmoji('♻️')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('ticket:delete')
      .setLabel('Delete')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
  );
}

export function confirmRow(action: 'close' | 'delete'): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket:${action}-confirm`)
      .setLabel(`Confirm ${action}`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`ticket:${action}-cancel`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
}

export function ephemeral(content: string) {
  return { content, flags: MessageFlags.Ephemeral } as const;
}
