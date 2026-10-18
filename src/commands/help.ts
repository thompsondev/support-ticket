import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, ephemeral, isStaff } from '../util';
import { env } from '../env';
import type { Command } from './index';

export const help: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all commands')
    .addSubcommand((s) =>
      s.setName('list').setDescription('Show the command list (private)'),
    )
    .addSubcommand((s) =>
      s.setName('post').setDescription('Post the full usage guide to this channel (staff)'),
    ),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const sub = i.options.getSubcommand(false);

    if (sub === 'post') {
      if (!(await isStaff(i.member))) {
        await i.reply(ephemeral('Staff only.'));
        return;
      }
      const dash = env.dashboardUrl;
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('📘 How to use this server — full guide')
            .setColor(COLORS.info)
            .setFooter({ text: 'For educational purposes only' })
            .setDescription(
              '**Getting support**\n' +
                '• Pick a category on the ticket panel → a private channel opens for you\n' +
                '• Or run `/issues` → pick your issue → click **Resolve this issue** for instant self-service\n' +
                '• One open ticket per person — use your existing ticket if you already have one\n\n' +
                '**Inside a ticket**\n' +
                '• Explain your issue clearly — staff are notified and will reply\n' +
                '• Staff can claim your ticket, ask questions, and close it when resolved\n' +
                '• When it closes you get a transcript and can rate the support\n\n' +
                '**Useful commands**\n' +
                '`/issues` — self-service issue picker\n' +
                '`/link show` — useful links\n' +
                '`/suggest new` — submit a suggestion\n' +
                '`/afk` — set AFK status · `/userinfo` `/serverinfo` — stats\n' +
                '`/tag list` · `/cmd list` — canned answers & server commands',
            ),
          new EmbedBuilder()
            .setTitle('🛠️ For staff')
            .setColor(COLORS.warn)
            .setDescription(
              '**Tickets:** `/panel` post a panel · claim/close via buttons · `/ticket add|remove|rename|priority|move|note|reopen`\n' +
                '**Tools:** `/tag send` · `/announce` · `/poll` `/giveaway` · `/sticky` · `/reactionrole` · `/mod` · `/blacklist`\n' +
                '**Routing:** right-click a message → **Apps → Route to Support** to send someone your hub invite (set yours on the dashboard → Coin discovery → My support hub)\n' +
                `**Dashboard:** ${dash} — configure everything, see referrals, click analytics and the full Guide & FAQ`,
            ),
        ],
      });
      return;
    }

    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🎫 Support Ticket Bot')
          .setColor(COLORS.info)
          .addFields(
            {
              name: 'Members',
              value: [
                '`/issues` — self-service issue picker',
                '`/link show` — drop useful server links',
                '`/tag send` `list` — canned answers',
                '`/suggest new` — submit a suggestion (votes)',
                '`/remind set|list|cancel` — personal reminders',
                '`/cmd run|list` — server custom commands',
                '`/afk [reason]` — AFK status (auto-replies to pings)',
                '`/userinfo` `/serverinfo` — profile & server stats',
                '`/ticket close` / `info` — inside a ticket',
                '`/help post` — post the full guide here (staff)',
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
                `Web dashboard: ${env.dashboardUrl} — Guide & FAQ tab has step-by-step setup`,
            },
          ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
