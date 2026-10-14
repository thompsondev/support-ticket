import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { avgRating, dbAll } from '../db';
import { COLORS, ephemeral, isStaff } from '../util';
import type { Command } from './index';

export const stats: Command = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Ticket statistics for this server'),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    if (!await isStaff(i.member)) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }

    const counts = await dbAll<{ status: string; c: number }>(
      'SELECT status, COUNT(*) AS c FROM tickets WHERE guild_id = ? GROUP BY status',
      [i.guildId],
    );
    const byType = await dbAll<{ type: string; c: number }>(
      'SELECT type, COUNT(*) AS c FROM tickets WHERE guild_id = ? GROUP BY type ORDER BY c DESC',
      [i.guildId],
    );
    const rating = await avgRating(i.guildId);

    const get = (s: string) => counts.find((r) => r.status === s)?.c ?? 0;
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📊 Ticket stats')
          .setColor(COLORS.info)
          .addFields(
            { name: 'Open', value: String(get('open')), inline: true },
            { name: 'Closed', value: String(get('closed')), inline: true },
            { name: 'Deleted', value: String(get('deleted')), inline: true },
            {
              name: 'Avg rating',
              value: rating ? `${rating.toFixed(1)}★` : 'No ratings yet',
              inline: true,
            },
            {
              name: 'By type',
              value: byType.map((r) => `**${r.type}**: ${r.c}`).join('\n') || '—',
              inline: true,
            },
          ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
