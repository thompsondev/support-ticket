import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { linksMessage } from '../links';
import type { Command } from './index';

export const issues: Command = {
  data: new SlashCommandBuilder()
    .setName('issues')
    .setDescription('Self-service issue picker — get the resolution link for your issue'),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const msg = await linksMessage(i.guildId, i.guild.name);
    await i.reply({ embeds: msg.embeds, components: msg.components });
  },
};
