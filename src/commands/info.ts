import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, ephemeral } from '../util';
import type { Command } from './index';

export const userinfo: Command = {
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Show info about a user')
    .addUserOption((o) => o.setName('user').setDescription('User (default: you)')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const user = i.options.getUser('user') ?? i.user;
    const member = await i.guild.members.fetch(user.id).catch(() => null);
    const roles = member
      ? member.roles.cache
          .filter((r) => r.id !== i.guild.roles.everyone.id)
          .sort((a, b) => b.position - a.position)
          .map((r) => `<@&${r.id}>`)
          .slice(0, 15)
          .join(' ')
      : '';
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${user.tag}`)
          .setThumbnail(user.displayAvatarURL({ size: 256 }))
          .setColor(COLORS.info)
          .addFields(
            { name: 'ID', value: user.id, inline: true },
            { name: 'Account created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
            ...(member
              ? [
                  { name: 'Joined server', value: `<t:${Math.floor((member.joinedTimestamp ?? 0) / 1000)}:R>`, inline: true },
                  { name: `Roles (${member.roles.cache.size - 1})`, value: roles || '—' },
                ]
              : [{ name: 'Server member', value: 'No' }]),
          ),
      ],
      flags: ephemeral('').flags,
    });
  },
};

export const serverinfo: Command = {
  data: new SlashCommandBuilder().setName('serverinfo').setDescription('Show server info'),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const g = i.guild;
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(g.name)
          .setThumbnail(g.iconURL({ size: 256 }))
          .setColor(COLORS.info)
          .addFields(
            { name: 'ID', value: g.id, inline: true },
            { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
            { name: 'Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
            { name: 'Members', value: String(g.memberCount), inline: true },
            { name: 'Channels', value: String(g.channels.cache.size), inline: true },
            { name: 'Roles', value: String(g.roles.cache.size), inline: true },
            { name: 'Boosts', value: `${g.premiumSubscriptionCount ?? 0} (tier ${g.premiumTier})`, inline: true },
          ),
      ],
      flags: ephemeral('').flags,
    });
  },
};
