import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
} from 'discord.js';
import {
  addNote,
  getNotes,
  getTicketByChannel,
  getTicketById,
  getTicketType,
  listTickets,
  updateTicket,
} from '../db';
import {
  COLORS,
  ephemeral,
  isStaff,
  pad,
  priorityLabel,
  PRIORITIES,
  ticketEmbed,
} from '../util';
import { closeTicket, deleteTicket, refreshControlMessage, reopenTicket } from '../tickets';
import type { Command } from './index';

const STAFF_SUBS = new Set([
  'claim', 'unclaim', 'add', 'remove', 'rename', 'priority', 'move',
  'note', 'notes', 'list', 'reopen', 'delete',
]);

export const ticket: Command = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Manage tickets')
    .addSubcommand((s) =>
      s.setName('close').setDescription('Close this ticket')
        .addStringOption((o) => o.setName('reason').setDescription('Reason for closing')),
    )
    .addSubcommand((s) => s.setName('claim').setDescription('Claim this ticket'))
    .addSubcommand((s) => s.setName('unclaim').setDescription('Release this ticket'))
    .addSubcommand((s) =>
      s.setName('add').setDescription('Add a user to this ticket')
        .addUserOption((o) => o.setName('user').setDescription('User to add').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Remove a user from this ticket')
        .addUserOption((o) => o.setName('user').setDescription('User to remove').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('rename').setDescription('Rename this ticket channel')
        .addStringOption((o) => o.setName('name').setDescription('New channel name').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('priority').setDescription('Set ticket priority')
        .addStringOption((o) =>
          o.setName('level').setDescription('Priority').setRequired(true)
            .addChoices(...PRIORITIES.map((p) => ({ name: p, value: p }))),
        ),
    )
    .addSubcommand((s) =>
      s.setName('move').setDescription('Change ticket type')
        .addStringOption((o) =>
          o.setName('type').setDescription('New type').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s.setName('note').setDescription('Add a private staff note')
        .addStringOption((o) => o.setName('text').setDescription('Note content').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('notes').setDescription('List staff notes on this ticket'))
    .addSubcommand((s) => s.setName('info').setDescription('Show ticket details'))
    .addSubcommand((s) =>
      s.setName('list').setDescription('List tickets')
        .addStringOption((o) =>
          o.setName('status').setDescription('Filter by status')
            .addChoices(
              { name: 'open', value: 'open' },
              { name: 'closed', value: 'closed' },
              { name: 'all', value: 'all' },
            ),
        )
        .addUserOption((o) => o.setName('user').setDescription('Filter by owner')),
    )
    .addSubcommand((s) => s.setName('reopen').setDescription('Reopen a closed ticket'))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete this ticket channel')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const sub = i.options.getSubcommand();
    const staff = await isStaff(i.member);
    const eph = { flags: MessageFlags.Ephemeral } as const;

    if (STAFF_SUBS.has(sub) && !staff) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }

    // /ticket list works anywhere
    if (sub === 'list') {
      const status = i.options.getString('status') ?? 'open';
      const user = i.options.getUser('user');
      const rows = await listTickets(i.guildId, status, user?.id);
      const lines = rows.map(
        (t) =>
          `\`#${pad(t.number)}\` ${t.status === 'open' ? '🟢' : '🔴'} <@${t.owner_id}> — ${t.type}` +
          (t.claimed_by ? ` (claimed by <@${t.claimed_by}>)` : ''),
      );
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`Tickets (${status}${user ? ` — ${user.tag}` : ''})`)
            .setDescription(lines.join('\n') || 'No tickets found.')
            .setColor(COLORS.info),
        ],
        ...eph,
      });
      return;
    }

    const t = await getTicketByChannel(i.channelId);
    if (!t) {
      await i.reply(ephemeral('This command must be used inside a ticket channel.'));
      return;
    }
    const channel = i.channel as TextChannel;
    const refresh = async () => refreshControlMessage(channel, (await getTicketById(t.id))!);

    switch (sub) {
      case 'close': {
        if (t.status !== 'open') return void (await i.reply(ephemeral('Ticket is already closed.')));
        await i.reply('🔒 Closing ticket…');
        await closeTicket(i.client, t, i.user, i.options.getString('reason'));
        break;
      }
      case 'claim': {
        if (t.status !== 'open') return void (await i.reply(ephemeral('Ticket is closed.')));
        if (t.claimed_by) return void (await i.reply(ephemeral(`Already claimed by <@${t.claimed_by}>.`)));
        await updateTicket(t.id, { claimed_by: i.user.id });
        await refresh();
        await i.reply(`🙋 Ticket claimed by ${i.user}.`);
        break;
      }
      case 'unclaim': {
        await updateTicket(t.id, { claimed_by: null });
        await refresh();
        await i.reply('Ticket released.');
        break;
      }
      case 'add': {
        const user = i.options.getUser('user', true);
        await channel.permissionOverwrites.edit(user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });
        await i.reply(`➕ ${user} added to the ticket.`);
        break;
      }
      case 'remove': {
        const user = i.options.getUser('user', true);
        if (user.id === t.owner_id) return void (await i.reply(ephemeral("Can't remove the ticket owner.")));
        await channel.permissionOverwrites.delete(user.id);
        await i.reply(`➖ ${user} removed from the ticket.`);
        break;
      }
      case 'rename': {
        const name = i.options.getString('name', true).toLowerCase().replace(/[^a-z0-9-_]/g, '-');
        await channel.setName(name);
        await i.reply(`Renamed to \`${name}\`.`);
        break;
      }
      case 'priority': {
        const level = i.options.getString('level', true);
        await updateTicket(t.id, { priority: level as typeof t.priority });
        await channel
          .setTopic(`Ticket #${pad(t.number)} | ${(await getTicketType(i.guildId, t.type))?.label ?? t.type} | Owner: ${t.owner_id} | Priority: ${level}`)
          .catch(() => {});
        await refresh();
        await i.reply(`Priority set to ${priorityLabel(level)}.`);
        break;
      }
      case 'move': {
        const type = i.options.getString('type', true);
        if (!await getTicketType(i.guildId, type)) {
          return void (await i.reply(ephemeral(`Unknown type \`${type}\` — see /types list.`)));
        }
        await updateTicket(t.id, { type });
        await refresh();
        await i.reply(`🔀 Ticket moved to **${(await getTicketType(i.guildId, type))?.label ?? type}**.`);
        break;
      }
      case 'note': {
        await addNote(t.id, i.user.id, i.options.getString('text', true));
        await i.reply(ephemeral('📝 Note saved.'));
        break;
      }
      case 'notes': {
        const notes = await getNotes(t.id);
        await i.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle(`Staff notes — ticket #${pad(t.number)}`)
              .setColor(COLORS.info)
              .setDescription(
                notes
                  .map((n) => `• <@${n.author_id}>: ${n.content}`)
                  .join('\n') || 'No notes yet.',
              ),
          ],
          ...eph,
        });
        break;
      }
      case 'info': {
        await i.reply({ embeds: [await ticketEmbed((await getTicketById(t.id))!)], ...eph });
        break;
      }
      case 'reopen': {
        if (t.status !== 'closed') return void (await i.reply(ephemeral('Ticket is not closed.')));
        await i.reply('♻️ Reopening ticket…');
        await reopenTicket(i.client, t);
        break;
      }
      case 'delete': {
        if (!i.member.permissions.has(PermissionFlagsBits.ManageChannels) && !staff) {
          return void (await i.reply(ephemeral('Staff only.')));
        }
        await i.reply('🗑️ Deleting ticket…');
        await deleteTicket(i.client, t, i.user);
        break;
      }
    }
  },
};
