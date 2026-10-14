import { env } from './env';

// OpenAI-compatible chat-completions client (works with Neon AI Gateway and
// any compatible endpoint). Every function fails open — returns null on error
// or timeout — so the bot never blocks on AI availability.

const TIMEOUT_MS = 12_000;

export function aiEnabled(): boolean {
  return !!(env.aiGatewayUrl && env.aiGatewayToken);
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function chat(messages: ChatMessage[], maxTokens = 300): Promise<string | null> {
  if (!aiEnabled()) return null;
  const base = env.aiGatewayUrl.replace(/\/+$/, '');
  const url = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.aiGatewayToken}`,
      },
      body: JSON.stringify({
        model: env.aiModel,
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

/**
 * Classify whether a message from a satellite server is a support need —
 * complaint, problem, question, or request for help.
 */
export async function classifySupportIntent(text: string): Promise<{ support: boolean; confidence: number }> {
  const r = parseJson<{ support: boolean; confidence: number }>(
    await chat(
      [
        {
          role: 'system',
          content:
            'You classify Discord messages. Reply with JSON only: {"support": true|false, "confidence": 0-1}. ' +
            '"support" is true when the message is a complaint, bug report, problem, how-to question, or request for help about a crypto project/token. ' +
            'False for general chat, price talk, greetings, and memes.',
        },
        { role: 'user', content: text.slice(0, 1000) },
      ],
      60,
    ),
  );
  return r ?? { support: false, confidence: 0 };
}

/** Draft a short, friendly reply pointing a user to the support server. */
export async function draftSupportReply(userText: string, serverName: string): Promise<string | null> {
  return chat(
    [
      {
        role: 'system',
        content:
          'You are a helpful community-support assistant in a Discord server. ' +
          'Write ONE short sentence (max 25 words) acknowledging the user\'s issue and telling them the support team can help in the official support server. ' +
          'Do not include a link — it is appended separately. No markdown headers, no emojis overload (0-1 emoji ok).',
      },
      { role: 'user', content: `User in "${serverName}" wrote: ${userText.slice(0, 800)}` },
    ],
    80,
  );
}

/** Ticket triage — categorize + suggest priority + draft a first staff reply. */
export async function triageTicket(
  subject: string,
  description: string,
): Promise<{ priority: string; category: string; draft: string } | null> {
  const r = parseJson<{ priority: string; category: string; draft: string }>(
    await chat(
      [
        {
          role: 'system',
          content:
            'You triage support tickets. Reply with JSON only: {"priority": "low|medium|high|urgent", "category": "short label", "draft": "2-3 sentence suggested staff reply"}.',
        },
        { role: 'user', content: `Subject: ${subject.slice(0, 200)}\n${description.slice(0, 1000)}` },
      ],
      250,
    ),
  );
  if (!r || !['low', 'medium', 'high', 'urgent'].includes(r.priority)) return null;
  return r;
}
