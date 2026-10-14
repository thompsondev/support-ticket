import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import {
  bumpCustomCommand,
  getCustomCommand,
  listCustomCommands,
  removeCustomCommand,
  setCustomCommand,
} from '../db';
import { COLORS, ephemeral, isStaff } from '../util';
import type { Command } from './index';

const NAME_RE = /^[a-z0-9-_]{1,32}$/;

export const cmd: Command = {
  data: new SlashCommandBuilder()
    .setName('cmd')
    .setDescription('Custom commands for this server')
    .addSubcommand((s) =>
      s.setName('run').setDescription('Run a custom command')
        .addStringOption((o) => o.setName('name').setDescription('Command name').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s.setName('add').setDescription('Create/update a custom command (staff)')
        .addStringOption((o) => o.setName('name').setDescription('Command name (a-z 0-9 - _)').setRequired(true))
        .addStringOption((o) => o.setName('response').setDescription('What it replies with').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Delete a custom command (staff)')
        .addStringOption((o) => o.setName('name').setDescription('Command name').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List custom commands')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const sub = i.options.getSubcommand();

    if (sub === 'run') {
      const name = i.options.getString('name', true).toLowerCase();
      const c = await getCustomCommand(i.guildId, name);
      if (!c) return void (await i.reply(ephemeral(`No custom command \`${name}\` — try \`/cmd list\`.`)));
      await bumpCustomCommand(i.guildId, name);
      await i.reply({ embeds: [new EmbedBuilder().setDescription(c.response.slice(0, 2000)).setColor(COLORS.info)] });
      return;
    }

    if (sub === 'list') {
      const rows = await listCustomCommands(i.guildId);
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Custom commands')
            .setColor(COLORS.info)
            .setDescription(
              rows.map((c) => `\`/cmd run ${c.name}\` — used ${c.uses}×`).join('\n') || 'None yet — staff can add one with `/cmd add`.',
            ),
        ],
        flags: ephemeral('').flags,
      });
      return;
    }

    if (!await isStaff(i.member)) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }

    const name = i.options.getString('name', true).toLowerCase();
    if (sub === 'add') {
      if (!NAME_RE.test(name)) {
        return void (await i.reply(ephemeral('Invalid name — lowercase letters, numbers, `-` and `_` only.')));
      }
      await setCustomCommand(i.guildId, name, i.options.getString('response', true).slice(0, 2000));
      await i.reply(ephemeral(`✅ \`/cmd run ${name}\` saved.`));
      return;
    }

    await i.reply(
      ephemeral(await removeCustomCommand(i.guildId, name) ? `🗑️ \`${name}\` removed.` : `No command named \`${name}\`.`),
    );
  },
};
