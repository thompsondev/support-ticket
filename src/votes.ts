import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  EmbedBuilder,
  MessageCreateOptions,
  MessageEditOptions,
  TextChannel,
} from 'discord.js';
import {
  closePollRow,
  getPoll,
  getSuggestion,
  getUserVote,
  removeVote,
  setVote,
  voteCounts,
  type PollRow,
  type SuggestionRow,
} from './db';
import { COLORS, ephemeral } from './util';

export const SUGGESTION_STATUS: Record<
  string,
  { label: string; color: number }
> = {
  pending: { label: '⏳ Pending', color: COLORS.info },
  approved: { label: '✅ Approved', color: COLORS.open },
  denied: { label: '❌ Denied', color: COLORS.closed },
  implemented: { label: '🚀 Implemented', color: 0x9b59b6 },
};

// ---------- suggestions ----------

export async function suggestionMessage(sug: SuggestionRow): Promise<MessageCreateOptions & MessageEditOptions> {
  const counts = await voteCounts(`sug:${sug.id}`);
  const up = counts.up ?? 0;
  const down = counts.down ?? 0;
  const st = SUGGESTION_STATUS[sug.status] ?? SUGGESTION_STATUS.pending;
  const embed = new EmbedBuilder()
    .setTitle(`💡 Suggestion #${sug.id}`)
    .setDescription(sug.content)
    .setColor(st.color)
    .addFields(
      { name: 'Status', value: st.label, inline: true },
      { name: 'Score', value: `${up - down >= 0 ? '+' : ''}${up - down} (👍 ${up} / 👎 ${down})`, inline: true },
      { name: 'Suggested by', value: `<@${sug.author_id}>`, inline: true },
    )
    .setTimestamp(sug.created_at);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`sug:vote:${sug.id}:up`)
      .setEmoji('👍')
      .setLabel(String(up))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`sug:vote:${sug.id}:down`)
      .setEmoji('👎')
      .setLabel(String(down))
      .setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

// ---------- polls ----------

export async function pollMessage(poll: PollRow): Promise<MessageCreateOptions & MessageEditOptions> {
  const options = JSON.parse(poll.options) as string[];
  const counts = await voteCounts(`poll:${poll.id}`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const lines = options.map((o, idx) => {
    const c = counts[String(idx)] ?? 0;
    const pct = total ? Math.round((c / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `**${idx + 1}.** ${o}\n\`${bar}\` ${c} votes (${pct}%)`;
  });
  if (poll.ends_at && !poll.closed) {
    lines.push(`\n_Ends <t:${Math.floor(poll.ends_at / 1000)}:R>_`);
  }

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${poll.question}`)
    .setDescription(lines.join('\n'))
    .setColor(poll.closed ? COLORS.closed : COLORS.info)
    .setFooter({ text: poll.closed ? 'Poll closed' : `Poll #${poll.id} — vote below` })
    .setTimestamp(poll.created_at);

  const components = poll.closed
    ? []
    : [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...options.slice(0, 5).map((o, idx) =>
            new ButtonBuilder()
              .setCustomId(`poll:vote:${poll.id}:${idx}`)
              .setLabel(o.slice(0, 60))
              .setStyle(ButtonStyle.Secondary),
          ),
        ),
      ];
  return { embeds: [embed], components };
}

// ---------- vote handling ----------

export async function handleSuggestionVote(i: ButtonInteraction<'cached'>): Promise<void> {
  const [, , sid, dir] = i.customId.split(':');
  const sug = await getSuggestion(Number(sid));
  if (!sug) return void (await i.reply(ephemeral('Suggestion not found.')));

  const subject = `sug:${sug.id}`;
  if (await getUserVote(subject, i.user.id) === dir) await removeVote(subject, i.user.id);
  else await setVote(subject, i.user.id, dir);

  await i.update(await suggestionMessage(sug));
}

export async function handlePollVote(i: ButtonInteraction<'cached'>): Promise<void> {
  const [, , pid, idx] = i.customId.split(':');
  const poll = await getPoll(Number(pid));
  if (!poll) return void (await i.reply(ephemeral('Poll not found.')));
  if (poll.closed) return void (await i.reply(ephemeral('This poll is closed.')));

  const subject = `poll:${poll.id}`;
  if (await getUserVote(subject, i.user.id) === idx) await removeVote(subject, i.user.id);
  else await setVote(subject, i.user.id, idx);

  await i.update(await pollMessage(poll));
}

// ---------- poll closing ----------

export async function endPoll(client: Client, poll: PollRow): Promise<string[]> {
  await closePollRow(poll.id);
  const options = JSON.parse(poll.options) as string[];
  const counts = await voteCounts(`poll:${poll.id}`);
  const winners = options
    .map((o, idx) => ({ o, c: counts[String(idx)] ?? 0 }))
    .sort((a, b) => b.c - a.c);
  const top = winners.filter((w) => w.c === winners[0]?.c && w.c > 0).map((w) => w.o);

  if (poll.channel_id && poll.message_id) {
    const channel = await client.channels.fetch(poll.channel_id).catch(() => null);
    if (channel && !channel.isDMBased() && channel.isTextBased()) {
      const msg = await (channel as TextChannel).messages.fetch(poll.message_id).catch(() => null);
      if (msg) {
        await msg.edit(await pollMessage({ ...poll, closed: 1 })).catch(() => {});
        if (top.length && channel.isSendable()) {
          await channel
            .send(
              `📊 Poll closed — **${poll.question}**\nWinner${top.length > 1 ? 's' : ''}: **${top.join('", "')}** (${winners[0].c} votes)`,
            )
            .catch(() => {});
        }
      }
    }
  }
  return top;
}
