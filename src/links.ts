import {
  ActionRowBuilder,
  EmbedBuilder,
  MessageCreateOptions,
  StringSelectMenuBuilder,
} from 'discord.js';
import { createHmac } from 'node:crypto';
import { getLinks } from './db';
import { env } from './env';
import { COLORS } from './util';

// Signed token for tracked link redirects — proves the click URL was minted
// by us for that user, so clicks can't be forged with arbitrary user ids.
export function linkSig(guildId: string, linkId: number, userId: string): string {
  return createHmac('sha256', env.sessionSecret || env.token)
    .update(`${guildId}:${linkId}:${userId}`)
    .digest('hex')
    .slice(0, 16);
}

// Issue picker panel — a dropdown of the guild's links. No raw URLs and no
// button grid: picking an entry triggers an ephemeral self-service card
// (handled in interactions.ts) whose Resolve button is a tracked redirect.
export async function linksMessage(guildId: string, _guildName: string): Promise<MessageCreateOptions> {
  const links = await getLinks(guildId);
  const embed = new EmbedBuilder()
    .setTitle('� Select Category of your Issues')
    .setColor(COLORS.info)
    .setDescription(
      links.length
        ? "Choose the issue that best matches yours below — you'll get a **self-service** resolution instantly, no need to wait for staff."
        : 'No links configured yet. Staff can add them with `/link add` or the dashboard Links tab.',
    );
  if (!links.length) return { embeds: [embed] };

  const menu = new StringSelectMenuBuilder()
    .setCustomId('issues:pick')
    .setPlaceholder('Select the category of your issue…');
  for (const l of links.slice(0, 25)) {
    const opt: {
      label: string;
      value: string;
      description?: string;
      emoji?: string | { name: string; id: string };
    } = {
      label: l.label.slice(0, 100),
      value: String(l.id),
      description: (l.description ?? '').slice(0, 100) || undefined,
    };
    if (l.emoji) {
      const custom = /^<a?:(\w+):(\d+)>$/.exec(l.emoji);
      opt.emoji = custom ? { name: custom[1], id: custom[2] } : l.emoji;
    }
    menu.addOptions(opt);
  }
  return {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  };
}
