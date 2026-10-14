import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { addFormField, clearFormFields, getFormFields, getTicketType, removeFormField } from '../db';
import { COLORS, ephemeral, isStaff } from '../util';
import type { Command } from './index';

export const form: Command = {
  data: new SlashCommandBuilder()
    .setName('form')
    .setDescription('Custom intake questions per ticket type (staff)')
    .addSubcommand((s) =>
      s.setName('add').setDescription('Add a question to a ticket type (max 5)')
        .addStringOption((o) => o.setName('type').setDescription('Ticket type').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('question').setDescription('Question shown in the modal').setRequired(true))
        .addStringOption((o) => o.setName('style').setDescription('Input size').addChoices(
          { name: 'Short (one line)', value: 'short' },
          { name: 'Paragraph', value: 'paragraph' },
        ))
        .addBooleanOption((o) => o.setName('required').setDescription('Required? (default: yes)')),
    )
    .addSubcommand((s) =>
      s.setName('list').setDescription('Show questions for a type')
        .addStringOption((o) => o.setName('type').setDescription('Ticket type').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Remove question #N from a type')
        .addStringOption((o) => o.setName('type').setDescription('Ticket type').setRequired(true).setAutocomplete(true))
        .addIntegerOption((o) => o.setName('number').setDescription('Question number from /form list').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s.setName('clear').setDescription('Remove all questions (revert to default modal)')
        .addStringOption((o) => o.setName('type').setDescription('Ticket type').setRequired(true).setAutocomplete(true)),
    ),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    if (!await isStaff(i.member)) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }
    const typeId = i.options.getString('type', true);
    const type = await getTicketType(i.guildId, typeId);
    if (!type) return void (await i.reply(ephemeral(`Unknown ticket type \`${typeId}\`.`)));

    const sub = i.options.getSubcommand();

    if (sub === 'add') {
      const id = await addFormField(
        i.guildId,
        typeId,
        i.options.getString('question', true).slice(0, 45), // modal label limit
        i.options.getString('style') ?? 'short',
        i.options.getBoolean('required') ?? true,
      );
      await i.reply(
        ephemeral(
          id === null
            ? 'That type already has 5 questions — Discord modals cap at 5 inputs.'
            : `✅ Question added to **${type.label}** (${(await getFormFields(i.guildId, typeId)).length}/5).`,
        ),
      );
      return;
    }

    if (sub === 'list') {
      const rows = await getFormFields(i.guildId, typeId);
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`Form — ${type.label}`)
            .setColor(COLORS.info)
            .setDescription(
              rows
                .map((f, n) => `**${n + 1}.** ${f.question} _(${f.style}${f.required ? ', required' : ''})_`)
                .join('\n') || 'No custom questions — this type uses the default subject+description modal.',
            ),
        ],
        flags: ephemeral('').flags,
      });
      return;
    }

    if (sub === 'remove') {
      const rows = await getFormFields(i.guildId, typeId);
      const n = i.options.getInteger('number', true) - 1;
      if (!rows[n]) return void (await i.reply(ephemeral('Question number out of range.')));
      await removeFormField(rows[n].id, i.guildId);
      await i.reply(ephemeral(`🗑️ Removed question ${n + 1} from **${type.label}**.`));
      return;
    }

    const n = await clearFormFields(i.guildId, typeId);
    await i.reply(ephemeral(n ? `🗑️ Cleared ${n} question(s) — back to the default modal.` : 'No questions to clear.'));
  },
};
