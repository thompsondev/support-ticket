import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import { getPoll, insertPoll, setPollMessage } from '../db';
import { ephemeral, isStaff } from '../util';
import { endPoll, pollMessage } from '../votes';
import type { Command } from './index';

export const poll: Command = {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create and manage polls')
    .addSubcommand((s) =>
      s.setName('create').setDescription('Start a poll')
        .addStringOption((o) => o.setName('question').setDescription('Poll question').setRequired(true))
        .addStringOption((o) => o.setName('option1').setDescription('Option 1').setRequired(true))
        .addStringOption((o) => o.setName('option2').setDescription('Option 2').setRequired(true))
        .addStringOption((o) => o.setName('option3').setDescription('Option 3'))
        .addStringOption((o) => o.setName('option4').setDescription('Option 4'))
        .addStringOption((o) => o.setName('option5').setDescription('Option 5'))
        .addIntegerOption((o) =>
          o.setName('minutes').setDescription('Auto-close after N minutes').setMinValue(1).setMaxValue(10080),
        ),
    )
    .addSubcommand((s) =>
      s.setName('end').setDescription('End a poll early')
        .addIntegerOption((o) => o.setName('id').setDescription('Poll number (shown in footer)').setRequired(true)),
    ),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const sub = i.options.getSubcommand();

    if (sub === 'create') {
      if (!await isStaff(i.member)) {
        await i.reply(ephemeral('Staff only.'));
        return;
      }
      const options = [1, 2, 3, 4, 5]
        .map((n) => i.options.getString(`option${n}`))
        .filter((o): o is string => !!o)
        .map((o) => o.slice(0, 80));
      const minutes = i.options.getInteger('minutes');
      const id = await insertPoll(
        i.guildId,
        i.user.id,
        i.options.getString('question', true).slice(0, 200),
        options,
        minutes ? Date.now() + minutes * 60_000 : null,
      );
      if (!i.channel?.isSendable()) return;
      const msg = await i.channel.send(
        await pollMessage({
          id, guild_id: i.guildId, channel_id: null, message_id: null,
          author_id: i.user.id, question: i.options.getString('question', true).slice(0, 200),
          options: JSON.stringify(options), closed: 0,
          ends_at: minutes ? Date.now() + minutes * 60_000 : null, created_at: Date.now(),
        }),
      );
      await setPollMessage(id, i.channelId, msg.id);
      await i.reply(ephemeral(`📊 Poll #${id} created.`));
      return;
    }

    // end
    const id = i.options.getInteger('id', true);
    const p = await getPoll(id);
    if (!p || p.guild_id !== i.guildId) {
      await i.reply(ephemeral('Poll not found.'));
      return;
    }
    if (p.closed) {
      await i.reply(ephemeral('Poll already closed.'));
      return;
    }
    if (!await isStaff(i.member) && i.user.id !== p.author_id) {
      await i.reply(ephemeral('Only staff or the poll creator can end it.'));
      return;
    }
    await i.deferReply({ flags: ephemeral('').flags });
    const winners = await endPoll(i.client, p);
    await i.editReply(winners.length ? `Poll closed — winner: **${winners.join('", "')}**` : 'Poll closed — no votes.');
  },
};
