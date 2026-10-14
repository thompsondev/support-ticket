import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import {
  addTicketType,
  getTicketTypes,
  removeTicketType,
  updateTicketType,
} from '../db';
import { COLORS, ephemeral, isStaff } from '../util';
import type { Command } from './index';

const ID_RE = /^[a-z0-9-]{1,32}$/;

export const types: Command = {
  data: new SlashCommandBuilder()
    .setName('types')
    .setDescription('Manage ticket types for this server (staff)')
    .addSubcommand((s) =>
      s.setName('add').setDescription('Add a ticket type')
        .addStringOption((o) =>
          o.setName('id').setDescription('Short slug, e.g. "billing" (a-z 0-9 -)').setRequired(true),
        )
        .addStringOption((o) => o.setName('label').setDescription('Display name').setRequired(true))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji, e.g. 🎫'))
        .addStringOption((o) => o.setName('description').setDescription('Shown in the panel')),
    )
    .addSubcommand((s) =>
      s.setName('edit').setDescription('Edit a ticket type')
        .addStringOption((o) =>
          o.setName('id').setDescription('Type id').setRequired(true).setAutocomplete(true),
        )
        .addStringOption((o) => o.setName('label').setDescription('New display name'))
        .addStringOption((o) => o.setName('emoji').setDescription('New emoji'))
        .addStringOption((o) => o.setName('description').setDescription('New description')),
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Remove a ticket type')
        .addStringOption((o) =>
          o.setName('id').setDescription('Type id').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List ticket types')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    if (!await isStaff(i.member)) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }
    const sub = i.options.getSubcommand();

    if (sub === 'list') {
      const rows = await getTicketTypes(i.guildId);
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Ticket types')
            .setColor(COLORS.info)
            .setDescription(
              rows
                .map((t) => `${t.emoji ?? '•'} **${t.label}** (\`${t.type_id}\`) — ${t.description ?? '—'}`)
                .join('\n') || 'None configured.',
            ),
        ],
        flags: ephemeral('').flags,
      });
      return;
    }

    const id = i.options.getString('id', true);
    if (!ID_RE.test(id)) {
      await i.reply(ephemeral('Invalid id — use lowercase letters, numbers and dashes only (max 32).'));
      return;
    }

    if (sub === 'add') {
      if ((await getTicketTypes(i.guildId)).length >= 25) {
        await i.reply(ephemeral('Maximum of 25 ticket types reached (Discord select menu limit).'));
        return;
      }
      const ok = await addTicketType(i.guildId, {
        type_id: id,
        label: i.options.getString('label', true).slice(0, 100),
        emoji: i.options.getString('emoji')?.slice(0, 64) ?? null,
        description: i.options.getString('description')?.slice(0, 100) ?? null,
      });
      await i.reply(
        ephemeral(ok ? `✅ Type **${id}** added. Post a fresh /panel to use it.` : `Type **${id}** already exists.`),
      );
    } else if (sub === 'edit') {
      const patch: Record<string, string | null> = {};
      const label = i.options.getString('label');
      const emoji = i.options.getString('emoji');
      const description = i.options.getString('description');
      if (label) patch.label = label.slice(0, 100);
      if (emoji) patch.emoji = emoji.slice(0, 64);
      if (description) patch.description = description.slice(0, 100);
      if (!Object.keys(patch).length) {
        await i.reply(ephemeral('Nothing to update — pass label, emoji or description.'));
        return;
      }
      await i.reply(
        ephemeral(await updateTicketType(i.guildId, id, patch) ? `✅ Type **${id}** updated.` : `Type **${id}** not found.`),
      );
    } else if (sub === 'remove') {
      await i.reply(
        ephemeral(await removeTicketType(i.guildId, id) ? `🗑️ Type **${id}** removed.` : `Type **${id}** not found.`),
      );
    }
  },
};
