import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  MessageCreateOptions,
  MessageEditOptions,
  TextChannel,
} from 'discord.js';
import {
  closeGiveaway,
  giveawayEntries,
  giveawayEntryCount,
  type GiveawayRow,
} from './db';
import { COLORS } from './util';

export async function giveawayMessage(g: GiveawayRow): Promise<MessageCreateOptions & MessageEditOptions> {
  const entries = await giveawayEntryCount(g.id);
  const embed = new EmbedBuilder()
    .setTitle(`🎉 ${g.prize}`)
    .setColor(g.closed ? COLORS.closed : 0xfee75c)
    .addFields(
      { name: 'Winners', value: `**${g.winner_count}**`, inline: true },
      { name: 'Entries', value: `**${entries}**`, inline: true },
      { name: 'Hosted by', value: `<@${g.host_id}>`, inline: true },
    )
    .setTimestamp(g.created_at);
  if (g.ends_at && !g.closed) {
    embed.setDescription(`Ends <t:${Math.floor(g.ends_at / 1000)}:R> — click 🎉 to enter!`);
  } else if (g.closed) {
    embed.setDescription('**Giveaway ended.**');
  } else {
    embed.setDescription('Click 🎉 to enter!');
  }
  const components = g.closed
    ? []
    : [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`gw:enter:${g.id}`)
            .setEmoji('🎉')
            .setLabel(`Enter (${entries})`)
            .setStyle(ButtonStyle.Primary),
        ),
      ];
  return { embeds: [embed], components };
}

function pickWinners(entries: string[], count: number): string[] {
  const pool = [...entries];
  const winners: string[] = [];
  while (winners.length < count && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(i, 1)[0]);
  }
  return winners;
}

export async function endGiveaway(client: Client, g: GiveawayRow): Promise<string[]> {
  await closeGiveaway(g.id);
  const winners = pickWinners(await giveawayEntries(g.id), g.winner_count);

  if (g.channel_id) {
    const channel = await client.channels.fetch(g.channel_id).catch(() => null);
    if (channel && !channel.isDMBased() && channel.isTextBased()) {
      if (g.message_id) {
        const msg = await (channel as TextChannel).messages.fetch(g.message_id).catch(() => null);
        await msg?.edit(await giveawayMessage({ ...g, closed: 1 })).catch(() => {});
      }
      if (channel.isSendable()) {
        await channel
          .send(
            winners.length
              ? `🎉 **${g.prize}** — congratulations ${winners.map((w) => `<@${w}>`).join(', ')}!`
              : `🎉 **${g.prize}** ended — no entries.`,
          )
          .catch(() => {});
      }
    }
  }
  return winners;
}
