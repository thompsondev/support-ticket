import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { addLink, removeLink } from '../db';
import { linksMessage } from '../links';
import { ephemeral, isStaff } from '../util';
import type { Command } from './index';

function validUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export const link: Command = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Post or manage useful server links')
    .addSubcommand((s) =>
      s.setName('show').setDescription('Drop the links embed in this channel')
        .addBooleanOption((o) => o.setName('private').setDescription('Only show it to you')),
    )
    .addSubcommand((s) =>
      s.setName('add').setDescription('Add a link (staff)')
        .addStringOption((o) => o.setName('label').setDescription('Link name').setRequired(true))
        .addStringOption((o) => o.setName('url').setDescription('https://…').setRequired(true))
        .addStringOption((o) => o.setName('description').setDescription('Short description'))
        .addStringOption((o) => o.setName('emoji').setDescription('Button emoji (unicode or <:name:id>)')),
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Remove a link (staff)')
        .addStringOption((o) => o.setName('label').setDescription('Link name').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List configured links')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const sub = i.options.getSubcommand();

    if (sub === 'show' || sub === 'list') {
      const priv = sub === 'list' || (i.options.getBoolean('private') ?? false);
      await i.reply({ ...(await linksMessage(i.guildId, i.guild.name)), flags: priv ? MessageFlags.Ephemeral : undefined });
      return;
    }

    if (!await isStaff(i.member)) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }

    if (sub === 'add') {
      const label = i.options.getString('label', true).slice(0, 80);
      const url = i.options.getString('url', true);
      if (!validUrl(url)) {
        await i.reply(ephemeral('Invalid URL — must start with http:// or https://'));
        return;
      }
      const added = await addLink(i.guildId, label, url, i.options.getString('description'), i.options.getString('emoji'));
      await i.reply(
        ephemeral(added ? `✅ Added **${label}**.` : `A link named **${label}** already exists.`),
      );
    } else if (sub === 'remove') {
      const label = i.options.getString('label', true);
      await i.reply(
        ephemeral(await removeLink(i.guildId, label) ? `🗑️ Removed **${label}**.` : `No link named **${label}**.`),
      );
    }
  },
};
