import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { blacklistAdd, blacklistList, blacklistRemove } from '../db';
import { COLORS, ephemeral, isStaff } from '../util';
import type { Command } from './index';

export const blacklist: Command = {
  data: new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Block users from opening tickets (staff)')
    .addSubcommand((s) =>
      s.setName('add').setDescription('Blacklist a user')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason')),
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Remove a user from the blacklist')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show the blacklist')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    if (!await isStaff(i.member)) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }
    const sub = i.options.getSubcommand();

    if (sub === 'add') {
      const user = i.options.getUser('user', true);
      await blacklistAdd(i.guildId, user.id, i.options.getString('reason'));
      await i.reply(ephemeral(`⛔ ${user.tag} blacklisted.`));
    } else if (sub === 'remove') {
      const user = i.options.getUser('user', true);
      await i.reply(
        ephemeral(
          await blacklistRemove(i.guildId, user.id)
            ? `✅ ${user.tag} removed from blacklist.`
            : `${user.tag} is not blacklisted.`,
        ),
      );
    } else {
      const rows = await blacklistList(i.guildId);
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Ticket blacklist')
            .setColor(COLORS.closed)
            .setDescription(
              rows.map((r) => `<@${r.user_id}>${r.reason ? ` — ${r.reason}` : ''}`).join('\n') ||
                'Blacklist is empty.',
            ),
        ],
        flags: ephemeral('').flags,
      });
    }
  },
};
