import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { getTicketTypes } from '../db';
import { ephemeral, isStaff } from '../util';
import { panelMessage, type PanelStyle } from '../panel';
import type { Command } from './index';

export const panel: Command = {
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Post a ticket panel in this channel')
    .addStringOption((o) =>
      o
        .setName('style')
        .setDescription('How users pick a ticket type')
        .addChoices(
          { name: 'Dropdown menu', value: 'select' },
          { name: 'Buttons', value: 'buttons' },
        ),
    )
    .addStringOption((o) => o.setName('title').setDescription('Panel title (overrides /setup default)'))
    .addStringOption((o) => o.setName('description').setDescription('Panel description override')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    if (!await isStaff(i.member)) {
      await i.reply({ content: 'Staff only.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await getTicketTypes(i.guildId)).length) {
      await i.reply(ephemeral('No ticket types configured — add some with `/types add` first.'));
      return;
    }
    if (!i.channel?.isSendable()) return;

    await i.channel.send(
      await panelMessage(i.guildId, {
        style: (i.options.getString('style') ?? 'select') as PanelStyle,
        title: i.options.getString('title') ?? undefined,
        description: i.options.getString('description') ?? undefined,
      }),
    );
    await i.reply({ content: 'Panel posted.', flags: MessageFlags.Ephemeral });
  },
};
