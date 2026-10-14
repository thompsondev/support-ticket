import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  TextChannel,
} from 'discord.js';
import {
  getConfig,
  getSuggestion,
  insertSuggestion,
  setSuggestionMessage,
  setSuggestionStatus,
  type SuggestionRow,
} from '../db';
import { ephemeral, isStaff } from '../util';
import { suggestionMessage, SUGGESTION_STATUS } from '../votes';
import type { Command } from './index';

export const suggest: Command = {
  data: new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Community suggestions')
    .addSubcommand((s) =>
      s.setName('new').setDescription('Submit a suggestion')
        .addStringOption((o) => o.setName('text').setDescription('Your suggestion').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('status').setDescription('Set a suggestion status (staff)')
        .addIntegerOption((o) => o.setName('id').setDescription('Suggestion number').setRequired(true))
        .addStringOption((o) =>
          o.setName('value').setDescription('New status').setRequired(true)
            .addChoices(
              { name: 'Pending', value: 'pending' },
              { name: 'Approved', value: 'approved' },
              { name: 'Denied', value: 'denied' },
              { name: 'Implemented', value: 'implemented' },
            ),
        ),
    ),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const sub = i.options.getSubcommand();

    if (sub === 'new') {
      const cfg = await getConfig(i.guildId);
      if (!cfg.suggestions_channel_id) {
        await i.reply(ephemeral('Suggestions are not enabled — staff can set a channel in /setup or the dashboard.'));
        return;
      }
      const channel = await i.guild.channels.fetch(cfg.suggestions_channel_id).catch(() => null);
      if (!channel?.isSendable()) {
        await i.reply(ephemeral('Suggestions channel is misconfigured.'));
        return;
      }
      const id = await insertSuggestion(i.guildId, i.user.id, i.options.getString('text', true).slice(0, 1000));
      const msg = await channel.send(
        await suggestionMessage({ id, guild_id: i.guildId, channel_id: null, message_id: null, author_id: i.user.id, content: i.options.getString('text', true).slice(0, 1000), status: 'pending', created_at: Date.now() } as SuggestionRow),
      );
      await setSuggestionMessage(id, channel.id, msg.id);
      await i.reply(ephemeral(`✅ Suggestion #${id} posted in ${channel}.`));
      return;
    }

    // status
    if (!await isStaff(i.member)) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }
    const id = i.options.getInteger('id', true);
    const value = i.options.getString('value', true) as SuggestionRow['status'];
    const sug = await getSuggestion(id);
    if (!sug || sug.guild_id !== i.guildId) {
      await i.reply(ephemeral('Suggestion not found.'));
      return;
    }
    await setSuggestionStatus(id, value);
    const updated = { ...sug, status: value };
    if (sug.channel_id && sug.message_id) {
      const ch = (await i.guild.channels.fetch(sug.channel_id).catch(() => null)) as TextChannel | null;
      const msg = await ch?.messages.fetch(sug.message_id).catch(() => null);
      await msg?.edit(await suggestionMessage(updated)).catch(() => {});
    }
    await i.reply(ephemeral(`Suggestion #${id} marked ${SUGGESTION_STATUS[value].label}.`));
  },
};
