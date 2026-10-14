import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import { clearAfk, getAfk, setAfk } from '../db';
import { ephemeral } from '../util';
import type { Command } from './index';

export const afk: Command = {
  data: new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Set or clear your AFK status')
    .addStringOption((o) => o.setName('reason').setDescription('Why you are away')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const existing = await getAfk(i.guildId, i.user.id);
    if (existing && !i.options.getString('reason')) {
      await clearAfk(i.guildId, i.user.id);
      await i.reply(ephemeral('Welcome back — AFK cleared.'));
      return;
    }
    const reason = i.options.getString('reason')?.slice(0, 200) ?? null;
    await setAfk(i.guildId, i.user.id, reason);
    await i.reply(ephemeral(`💤 You're now AFK${reason ? `: ${reason}` : ''}. I'll clear it when you speak.`));
  },
};
