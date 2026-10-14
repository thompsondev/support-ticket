import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { getTag, getTags, removeTag, setTag } from '../db';
import { COLORS, ephemeral, isStaff } from '../util';
import type { Command } from './index';

const NAME_RE = /^[a-z0-9-_]{1,32}$/;

export const tag: Command = {
  data: new SlashCommandBuilder()
    .setName('tag')
    .setDescription('Canned replies — quick answers for common questions')
    .addSubcommand((s) =>
      s.setName('send').setDescription('Post a saved reply here')
        .addStringOption((o) =>
          o.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s.setName('add').setDescription('Save a canned reply (staff)')
        .addStringOption((o) => o.setName('name').setDescription('Tag name (a-z 0-9 - _)').setRequired(true))
        .addStringOption((o) => o.setName('content').setDescription('Reply text').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Delete a tag (staff)')
        .addStringOption((o) =>
          o.setName('name').setDescription('Tag name').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List all tags')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const sub = i.options.getSubcommand();

    if (sub === 'list') {
      const rows = await getTags(i.guildId);
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🏷️ Tags')
            .setColor(COLORS.info)
            .setDescription(rows.map((t) => `\`${t.name}\``).join(', ') || 'No tags saved.'),
        ],
        flags: ephemeral('').flags,
      });
      return;
    }

    if (sub === 'send') {
      const name = i.options.getString('name', true);
      const t = await getTag(i.guildId, name);
      if (!t) return void (await i.reply(ephemeral(`No tag \`${name}\` — see /tag list.`)));
      await i.reply(t.content);
      return;
    }

    if (!await isStaff(i.member)) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }

    const name = i.options.getString('name', true).toLowerCase();
    if (!NAME_RE.test(name)) {
      await i.reply(ephemeral('Invalid name — lowercase letters, numbers, - and _ only.'));
      return;
    }

    if (sub === 'add') {
      await setTag(i.guildId, name, i.options.getString('content', true).slice(0, 2000));
      await i.reply(ephemeral(`✅ Tag \`${name}\` saved.`));
    } else if (sub === 'remove') {
      await i.reply(ephemeral(await removeTag(i.guildId, name) ? `🗑️ Tag \`${name}\` removed.` : `No tag \`${name}\`.`));
    }
  },
};
