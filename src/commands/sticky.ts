import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { getSticky, removeSticky, setSticky, updateSticky } from '../db';
import { COLORS, ephemeral, isStaff } from '../util';
import type { Command } from './index';

export const sticky: Command = {
  data: new SlashCommandBuilder()
    .setName('sticky')
    .setDescription('Sticky messages — kept at the bottom of a channel (staff)')
    .addSubcommand((s) =>
      s.setName('set').setDescription('Stick a message to this channel')
        .addStringOption((o) => o.setName('text').setDescription('Sticky message content').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('remove').setDescription('Remove the sticky in this channel')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    if (!await isStaff(i.member)) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }
    const sub = i.options.getSubcommand();

    if (sub === 'set') {
      const text = i.options.getString('text', true).slice(0, 1500);
      await setSticky(i.guildId, i.channelId, text);
      if (i.channel?.isSendable()) {
        const msg = await i.channel.send({
          embeds: [new EmbedBuilder().setDescription(`📌 ${text}`).setColor(COLORS.warn)],
        });
        await updateSticky(i.channelId, msg.id, Date.now());
      }
      await i.reply(ephemeral('📌 Sticky set — it will re-pin itself after activity.'));
      return;
    }

    const st = await getSticky(i.channelId);
    if (!st) return void (await i.reply(ephemeral('No sticky in this channel.')));
    if (st.last_message_id && i.channel && 'messages' in i.channel) {
      await i.channel.messages.delete(st.last_message_id).catch(() => {});
    }
    await removeSticky(i.channelId);
    await i.reply(ephemeral('Sticky removed.'));
  },
};
