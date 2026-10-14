import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { ephemeral, isStaff } from '../util';
import type { Command } from './index';

export const announce: Command = {
  data: new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Post an announcement embed to a channel (staff)')
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Target channel').setRequired(true).addChannelTypes(ChannelType.GuildText),
    )
    .addStringOption((o) => o.setName('title').setDescription('Announcement title').setRequired(true))
    .addStringOption((o) => o.setName('message').setDescription('Announcement body').setRequired(true))
    .addRoleOption((o) => o.setName('ping').setDescription('Role to ping'))
    .addStringOption((o) =>
      o.setName('color').setDescription('Hex color, e.g. #5865f2').setMaxLength(7),
    ),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    if (!await isStaff(i.member)) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }
    const channel = i.options.getChannel('channel', true);
    const title = i.options.getString('title', true);
    const message = i.options.getString('message', true);
    const ping = i.options.getRole('ping');
    const colorRaw = i.options.getString('color');
    const color = colorRaw && /^#[0-9a-fA-F]{6}$/.test(colorRaw) ? parseInt(colorRaw.slice(1), 16) : 0x5865f2;

    const ch = await i.guild.channels.fetch(channel.id).catch(() => null);
    if (!ch?.isSendable()) {
      await i.reply(ephemeral('I can\'t post in that channel.'));
      return;
    }
    await ch.send({
      content: ping ? `<@&${ping.id}>` : undefined,
      embeds: [
        new EmbedBuilder()
          .setTitle(`📢 ${title}`)
          .setDescription(message)
          .setColor(color)
          .setFooter({ text: `Posted by ${i.user.tag}` })
          .setTimestamp(Date.now()),
      ],
      allowedMentions: ping ? { roles: [ping.id] } : undefined,
    });
    await i.reply(ephemeral(`📢 Announced in ${channel}.`));
  },
};
