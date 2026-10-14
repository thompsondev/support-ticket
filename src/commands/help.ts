import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS } from '../util';
import type { Command } from './index';

export const help: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all commands'),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🎫 Support Ticket Bot')
          .setColor(COLORS.info)
          .addFields(
            {
              name: 'Members',
              value: [
                '`/link show` — drop useful server links',
                '`/tag send` `list` — canned answers',
                '`/suggest new` — submit a suggestion (votes)',
                '`/remind set|list|cancel` — personal reminders',
                '`/cmd run|list` — server custom commands',
                '`/afk [reason]` — AFK status (auto-replies to pings)',
                '`/userinfo` `/serverinfo` — profile & server stats',
                '`/ticket close` / `info` — inside a ticket',
                '`/help` — this menu',
              ].join('\n'),
            },
            {
              name: 'Staff',
              value: [
                '`/panel` — post a ticket panel (dropdown or buttons)',
                '`/ticket claim` `unclaim` `add` `remove` `rename`',
                '`/ticket priority` `move` `note` `notes` `list` `reopen` `delete`',
                '`/types` — per-server ticket categories',
                '`/tag add|remove` — canned replies',
                '`/link add|remove` — manage the links embed',
                '`/suggest status` — approve/deny suggestions',
                '`/poll create|end` — quick polls',
                '`/giveaway create|end|reroll|list` — timed giveaways',
                '`/sticky set|remove` — pinned-to-bottom messages',
                '`/reactionrole create|bind|unbind|list` — react-to-get-role',
                '`/form add|list|remove|clear` — per-type intake questions',
                '`/cmd add|remove` — manage custom commands',
                '`/announce` — styled embed to a channel',
                '`/mod warn|warnings|clearwarnings|kick|ban|timeout|untimeout`',
                '`/blacklist add|remove|list` — block ticket abusers',
                '`/stats` — volume, ratings, per-type breakdown',
              ].join('\n'),
            },
            {
              name: 'Admins',
              value:
                '`/setup` — roles, categories, limits, channels, welcome/autorole, suggestions, escalation\n' +
                '`/automod` — native AutoMod: keywords, spam, mention-spam, invite block\n' +
                'Web dashboard: OAuth2 login → per-server tabs for everything',
            },
          ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
