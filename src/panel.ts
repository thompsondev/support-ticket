import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageCreateOptions,
  StringSelectMenuBuilder,
} from 'discord.js';
import { botConfig } from './config';
import { getConfig, getTicketTypes } from './db';
import { COLORS } from './util';

export type PanelStyle = 'select' | 'buttons';

export async function panelMessage(
  guildId: string,
  opts?: { style?: PanelStyle; title?: string; description?: string },
): Promise<MessageCreateOptions> {
  const cfg = await getConfig(guildId);
  const types = await getTicketTypes(guildId);
  const style = opts?.style ?? 'select';

  const embed = new EmbedBuilder()
    .setTitle(opts?.title ?? cfg.panel_title ?? botConfig.panel.title)
    .setDescription(opts?.description ?? cfg.panel_description ?? botConfig.panel.description)
    .setColor(COLORS.info)
    .setFooter({ text: 'Select a category to open a private ticket' });

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (style === 'buttons') {
    for (let r = 0; r < types.length; r += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const t of types.slice(r, r + 5)) {
        const b = new ButtonBuilder()
          .setCustomId(`ticket:create:${t.type_id}`)
          .setLabel(t.label)
          .setStyle(ButtonStyle.Secondary);
        if (t.emoji) b.setEmoji(t.emoji);
        row.addComponents(b);
      }
      components.push(row);
    }
  } else {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('panel:select')
      .setPlaceholder('Choose a ticket category…')
      .addOptions(
        types.slice(0, 25).map((t) => ({
          label: t.label,
          value: t.type_id,
          description: (t.description ?? '').slice(0, 100) || undefined,
          emoji: t.emoji ?? undefined,
        })),
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }

  return { embeds: [embed], components };
}
