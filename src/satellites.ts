import { EmbedBuilder, Message } from 'discord.js';
import { addReferral, getSatellite } from './db';
import { aiEnabled, classifySupportIntent, draftSupportReply } from './ai';
import { COLORS, isStaff } from './util';

// Built-in support-intent keywords — cheap pre-filter before any AI call.
const SUPPORT_RE =
  /\b(help|issue|problem|bug|error|broken|scam|stuck|failed|failing|wrong|support|question|assist|migrate|migration|claim|refund|hack|hacked|phish|drain|lost|can'?t|cannot|how do i|how to|how can i|where do i|not working|doesn'?t work|won'?t work|unable|when will|wen )\b/i;

// Question-ish heuristic for messages that didn't match keywords — only these
// go to the AI classifier, to keep gateway calls minimal.
const QUESTIONISH_RE = /\?|^(?:can|could|is|are|does|do|why|what|how|when|where|will|should|any)\b/i;

// per (guild,user) rate limit + per-channel floor, in-memory
const lastReply = new Map<string, number>();
const lastChannelReply = new Map<string, number>();
const CHANNEL_FLOOR_MS = 15_000;

/** True when the message looks like it needs support. AI-assisted when enabled. */
export async function isSupportMessage(sat: { ai_enabled: number }, content: string, guildName: string): Promise<boolean> {
  if (SUPPORT_RE.test(content)) return true;
  if (!sat.ai_enabled || !aiEnabled()) return false;
  if (!QUESTIONISH_RE.test(content) && content.length < 60) return false;
  const r = await classifySupportIntent(content);
  return r.support && r.confidence >= 0.6;
}

/** Build the reply text for a satellite auto-response. */
export async function satelliteReplyText(
  sat: { hub_invite: string; reply_text: string | null; ai_enabled: number },
  content: string,
  guildName: string,
): Promise<string> {
  const base = (sat.reply_text ??
    'Thanks for reaching out — our support team handles issues like this directly. Open a ticket in the official support server and someone will help you right away:')
    .trim();
  let draft: string | null = null;
  if (sat.ai_enabled && aiEnabled()) {
    draft = await draftSupportReply(content, guildName);
  }
  const lines = draft ? [draft, base] : [base];
  return `${lines.join('\n')}\n👉 ${sat.hub_invite}`;
}

/**
 * MessageCreate hook — call for every guild message. No-ops fast when the
 * guild isn't a satellite. Responds, then records the referral.
 */
export async function handleSatelliteMessage(m: Message<true>): Promise<void> {
  if (!m.guild || m.author.bot || !m.content || m.content.length < 8) return;
  if (m.mentions.everyone || /discord\.(gg|com\/invite)\//i.test(m.content)) return;

  const sat = await getSatellite(m.guild.id);
  if (!sat || !sat.enabled) return;

  const channels = JSON.parse(sat.channels || '[]') as string[];
  if (channels.length && !channels.includes(m.channelId)) return;

  if (m.member && (await isStaff(m.member))) return; // don't auto-reply to staff

  // rate limits: per user (configured) + per channel (15s floor)
  const now = Date.now();
  const userKey = `${m.guild.id}:${m.author.id}`;
  if (now - (lastReply.get(userKey) ?? 0) < sat.rate_limit_minutes * 60_000) return;
  if (now - (lastChannelReply.get(m.channelId) ?? 0) < CHANNEL_FLOOR_MS) return;

  if (!(await isSupportMessage(sat, m.content, m.guild.name))) return;

  lastReply.set(userKey, now);
  lastChannelReply.set(m.channelId, now);

  const text = await satelliteReplyText(sat, m.content, m.guild.name);
  const embed = new EmbedBuilder().setDescription(text).setColor(COLORS.info);
  const sent = await m.reply({ embeds: [embed] }).catch(() => null);
  await addReferral(m.guild.id, m.author.id, m.channelId, sent?.id ?? m.id).catch(() => {});
}
