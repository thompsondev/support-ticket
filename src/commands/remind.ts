import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { addReminder, deleteReminder, getReminders } from '../db';
import { COLORS, ephemeral } from '../util';
import { parseDuration } from './giveaway';
import type { Command } from './index';

export const remind: Command = {
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Personal reminders')
    .addSubcommand((s) =>
      s.setName('set').setDescription('Set a reminder')
        .addStringOption((o) => o.setName('when').setDescription('e.g. 10m, 2h, 1d').setRequired(true))
        .addStringOption((o) => o.setName('text').setDescription('What to remind you about').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Your pending reminders'))
    .addSubcommand((s) =>
      s.setName('cancel').setDescription('Cancel a reminder')
        .addIntegerOption((o) => o.setName('id').setDescription('Reminder id').setRequired(true)),
    ),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const sub = i.options.getSubcommand();

    if (sub === 'set') {
      const ms = parseDuration(i.options.getString('when', true));
      if (!ms || ms < 30_000 || ms > 365 * 86_400_000) {
        await i.reply(ephemeral('Invalid duration — use like `10m`, `2h`, `1d`.'));
        return;
      }
      const id = await addReminder(
        i.guildId, i.user.id, i.channelId,
        i.options.getString('text', true).slice(0, 500),
        Date.now() + ms,
      );
      await i.reply(ephemeral(`⏰ Reminder #${id} set — I'll ping you here <t:${Math.floor((Date.now() + ms) / 1000)}:R>.`));
      return;
    }

    if (sub === 'list') {
      const rows = await getReminders(i.guildId, i.user.id);
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Your reminders')
            .setColor(COLORS.info)
            .setDescription(
              rows.map((r) => `**#${r.id}** — ${r.text.slice(0, 60)} · <t:${Math.floor(r.remind_at / 1000)}:R>`).join('\n') || 'None pending.',
            ),
        ],
        flags: ephemeral('').flags,
      });
      return;
    }

    const id = i.options.getInteger('id', true);
    const mine = (await getReminders(i.guildId, i.user.id)).some((r) => r.id === id);
    await i.reply(ephemeral(mine && await deleteReminder(id) ? `Cancelled reminder #${id}.` : 'Reminder not found.'));
  },
};
