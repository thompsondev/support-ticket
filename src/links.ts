import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageCreateOptions,
} from 'discord.js';
import { getLinks } from './db';
import { COLORS } from './util';

// Professional links panel: descriptions live in the embed, each link is a
// Link-style button — users click the label, the URL is never shown in chat.
export async function linksMessage(guildId: string, guildName: string): Promise<MessageCreateOptions> {
  const links = await getLinks(guildId);
  const embed = new EmbedBuilder()
    .setTitle(`🔗 ${guildName} — Useful links`)
    .setColor(COLORS.info)
    .setDescription(
      links.length
        ? links
            .map((l) => `${l.emoji ? `${l.emoji} ` : ''}**${l.label}**${l.description ? `\n${l.description}` : ''}`)
            .join('\n\n')
        : 'No links configured yet. Staff can add them with `/link add` or the dashboard.',
    );
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let r = 0; r < Math.min(links.length, 25); r += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const l of links.slice(r, r + 5)) {
      const b = new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(l.url)
        .setLabel(l.label.slice(0, 80));
      if (l.emoji) {
        try {
          b.setEmoji(l.emoji);
        } catch { /* invalid emoji string — skip it */ }
      }
      row.addComponents(b);
    }
    components.push(row);
  }
  return { embeds: [embed], components };
}
