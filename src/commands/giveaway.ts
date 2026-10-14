import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { activeGiveaways, getGiveaway, giveawayEntries, insertGiveaway, setGiveawayMessage } from '../db';
import { COLORS, ephemeral, isStaff } from '../util';
import { endGiveaway, giveawayMessage } from '../giveaways';
import type { Command } from './index';

export function parseDuration(s: string): number | null {
  const re = /(\d+)\s*([smhd])/gi;
  let ms = 0;
  let m: RegExpExecArray | null;
  let matched = false;
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  while ((m = re.exec(s))) {
    matched = true;
    ms += Number(m[1]) * units[m[2].toLowerCase()];
  }
  return matched && ms > 0 ? ms : null;
}

export const giveaway: Command = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Run giveaways (staff)')
    .addSubcommand((s) =>
      s.setName('create').setDescription('Start a giveaway')
        .addStringOption((o) => o.setName('prize').setDescription('What is being given away').setRequired(true))
        .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 2h, 1d').setRequired(true))
        .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(20))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post (default: here)').addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((s) =>
      s.setName('end').setDescription('End a giveaway now')
        .addIntegerOption((o) => o.setName('id').setDescription('Giveaway id').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('reroll').setDescription('Pick new winner(s)')
        .addIntegerOption((o) => o.setName('id').setDescription('Giveaway id').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List active giveaways')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    if (!await isStaff(i.member)) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }
    const sub = i.options.getSubcommand();

    if (sub === 'create') {
      const ms = parseDuration(i.options.getString('duration', true));
      if (!ms || ms < 30_000 || ms > 30 * 86_400_000) {
        await i.reply(ephemeral('Invalid duration — use like `30m`, `2h`, `1d` (30s–30d).'));
        return;
      }
      const channel = i.options.getChannel('channel') ?? i.channel;
      if (!channel) return void (await i.reply(ephemeral('No channel to post in.')));
      const endsAt = Date.now() + ms;
      const winners = i.options.getInteger('winners') ?? 1;
      const prize = i.options.getString('prize', true).slice(0, 200);

      const id = await insertGiveaway({
        guild_id: i.guildId,
        host_id: i.user.id,
        prize,
        winner_count: winners,
        ends_at: endsAt,
      });
      const ch = await i.guild.channels.fetch(channel.id).catch(() => null);
      if (!ch?.isSendable()) return void (await i.reply(ephemeral('Cannot post in that channel.')));
      const msg = await ch.send(
        await giveawayMessage({
          id, guild_id: i.guildId, channel_id: ch.id, message_id: null, host_id: i.user.id,
          prize, winner_count: winners, ends_at: endsAt, closed: 0, created_at: Date.now(),
        }),
      );
      await setGiveawayMessage(id, ch.id, msg.id);
      await i.reply(ephemeral(`🎉 Giveaway #${id} created in ${channel}.`));
      return;
    }

    if (sub === 'list') {
      const rows = await activeGiveaways(i.guildId);
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Active giveaways')
            .setColor(COLORS.warn)
            .setDescription(
              (
                await Promise.all(
                  rows.map(
                    async (g) =>
                      `**#${g.id}** — ${g.prize} · ${(await giveawayEntries(g.id)).length} entries · ends <t:${Math.floor((g.ends_at ?? 0) / 1000)}:R>`,
                  ),
                )
              ).join('\n') || 'None active.',
            ),
        ],
        flags: ephemeral('').flags,
      });
      return;
    }

    const g = await getGiveaway(i.options.getInteger('id', true));
    if (!g || g.guild_id !== i.guildId) {
      await i.reply(ephemeral('Giveaway not found.'));
      return;
    }

    if (sub === 'end') {
      if (g.closed) return void (await i.reply(ephemeral('Already ended.')));
      await i.deferReply({ flags: ephemeral('').flags });
      const winners = await endGiveaway(i.client, g);
      await i.editReply(winners.length ? `Ended — winners: ${winners.map((w) => `<@${w}>`).join(', ')}` : 'Ended — no entries.');
    } else if (sub === 'reroll') {
      const entries = await giveawayEntries(g.id);
      if (!entries.length) return void (await i.reply(ephemeral('No entries to reroll from.')));
      const winners = [...entries].sort(() => Math.random() - 0.5).slice(0, g.winner_count);
      if (i.channel?.isSendable()) {
        await i.channel.send(`🔁 Rerolled **${g.prize}** — new winner(s): ${winners.map((w) => `<@${w}>`).join(', ')}`);
      }
      await i.reply(ephemeral('Rerolled.'));
    }
  },
};
