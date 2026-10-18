import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { getLinks } from '../db';
import { COLORS, ephemeral } from '../util';
import type { Command } from './index';

export const issues: Command = {
  data: new SlashCommandBuilder()
    .setName('issues')
    .setDescription('Self-service issue picker — get the resolution link for your issue'),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const links = await getLinks(i.guildId);
    if (!links.length) {
      await i.reply(ephemeral('No issue links are configured yet — staff can add them from the dashboard Links tab.'));
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle(`🛠️ ${i.guild.name} — Self-service support`)
      .setColor(COLORS.info)
      .setDescription(
        'Select the category that best matches your issue below.\n' +
          "You'll get a resolution link instantly — no need to wait for staff.",
      );
    const menu = new StringSelectMenuBuilder()
      .setCustomId('issues:pick')
      .setPlaceholder('Select the category of your issue…');
    for (const l of links.slice(0, 25)) {
      const opt: { label: string; value: string; description?: string; emoji?: string | { name: string; id: string } } = {
        label: l.label.slice(0, 100),
        value: String(l.id),
        description: (l.description ?? '').slice(0, 100) || undefined,
      };
      if (l.emoji) {
        const custom = /^<a?:(\w+):(\d+)>$/.exec(l.emoji);
        opt.emoji = custom ? { name: custom[1], id: custom[2] } : l.emoji;
      }
      menu.addOptions(opt);
    }
    await i.reply({
      embeds: [embed],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    });
  },
};
