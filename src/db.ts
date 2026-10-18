import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { Pool, types as pgTypes } from 'pg';
import { env } from './env';
import { botConfig } from './config';

mkdirSync('data', { recursive: true });
mkdirSync('transcripts', { recursive: true });

// ============================================================================
// Dual-driver database layer.
// Postgres when DATABASE_URL is set (recommended for production / multi-guild),
// otherwise embedded node:sqlite. All exported functions are async.
// ============================================================================

export interface RunResult {
  changes: number;
  lastId: number;
}

type QueryRow = Record<string, unknown>;

// tables that have an auto-increment `id` column (pg RETURNING id applies only to these)
const ID_TABLES = new Set([
  'tickets', 'notes', 'ratings', 'links', 'suggestions', 'polls', 'warnings',
  'reminders', 'giveaways', 'form_fields', 'audit_log', 'referrals', 'watchlist',
]);

// primary keys used to translate sqlite `INSERT OR REPLACE` → pg ON CONFLICT … DO UPDATE
const TABLE_PK: Record<string, string[]> = {
  blacklist: ['guild_id', 'user_id'],
  cooldowns: ['guild_id', 'user_id'],
  tags: ['guild_id', 'name'],
  votes: ['subject', 'user_id'],
  global_blacklist: ['user_id'],
  sticky: ['channel_id'],
  reaction_roles: ['message_id', 'emoji'],
  afk: ['guild_id', 'user_id'],
  automod_rules: ['guild_id', 'kind'],
  custom_commands: ['guild_id', 'name'],
  starboard: ['message_id'],
  temp_voice: ['channel_id'],
  sessions: ['sid'],
  ticket_types: ['guild_id', 'type_id'],
  satellites: ['guild_id'],
  user_profiles: ['user_id'],
};

/** Convert sqlite-flavoured SQL (? placeholders, INSERT OR REPLACE/IGNORE) to Postgres syntax. */
function toPg(sql: string): string {
  let s = sql.trim();

  const orMatch = s.match(/^INSERT\s+OR\s+(REPLACE|IGNORE)\s+INTO\s+(\w+)\s*\(([^)]*)\)/i);
  if (orMatch) {
    const [, mode, table, colsRaw] = orMatch;
    const cols = colsRaw.split(',').map((c) => c.trim()).filter(Boolean);
    const tail = s.slice(orMatch[0].length);
    if (mode.toUpperCase() === 'IGNORE') {
      s = `INSERT INTO ${table} (${cols.join(', ')})${tail} ON CONFLICT DO NOTHING`;
    } else {
      const pk = TABLE_PK[table] ?? cols.slice(0, 1);
      const nonPk = cols.filter((c) => !pk.includes(c));
      const conflict = nonPk.length
        ? ` DO UPDATE SET ${nonPk.map((c) => `${c} = excluded.${c}`).join(', ')}`
        : ' DO NOTHING';
      s = `INSERT INTO ${table} (${cols.join(', ')})${tail} ON CONFLICT (${pk.join(', ')})${conflict}`;
    }
  }

  const insMatch = s.match(/^INSERT\s+INTO\s+(\w+)\b/i);
  if (insMatch && ID_TABLES.has(insMatch[1]) && !/\bRETURNING\b/i.test(s)) {
    s += ' RETURNING id';
  }

  // ? → $n, skipping '...' string literals
  let out = '';
  let n = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (ch === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
        } else {
          inStr = false;
        }
      }
    } else if (ch === "'") {
      inStr = true;
      out += ch;
    } else if (ch === '?') {
      n += 1;
      out += `$${n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

interface Driver {
  run(sql: string, params: unknown[]): Promise<RunResult>;
  get<T>(sql: string, params: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params: unknown[]): Promise<T[]>;
}

const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  support_role_id TEXT,
  admin_role_id TEXT,
  log_channel_id TEXT,
  transcript_channel_id TEXT,
  open_category_id TEXT,
  closed_category_id TEXT,
  max_tickets INTEGER NOT NULL DEFAULT 3,
  cooldown_seconds INTEGER NOT NULL DEFAULT 60,
  autoclose_hours INTEGER NOT NULL DEFAULT 24,
  ticket_counter INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'medium',
  claimed_by TEXT,
  control_message_id TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by TEXT,
  close_reason TEXT,
  warned_at INTEGER,
  last_message_at INTEGER
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  stars INTEGER NOT NULL,
  feedback TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(ticket_id, user_id)
);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  UNIQUE(guild_id, label)
);
CREATE TABLE IF NOT EXISTS blacklist (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS cooldowns (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_open INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS ticket_types (
  guild_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  emoji TEXT,
  category_id TEXT,
  instant INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, type_id)
);
CREATE TABLE IF NOT EXISTS tags (
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, name)
);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  choice TEXT NOT NULL,
  PRIMARY KEY (subject, user_id)
);
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  author_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  ends_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS global_blacklist (
  user_id TEXT PRIMARY KEY,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  text TEXT NOT NULL,
  remind_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  host_id TEXT NOT NULL,
  prize TEXT NOT NULL,
  winner_count INTEGER NOT NULL DEFAULT 1,
  ends_at INTEGER,
  closed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (giveaway_id, user_id)
);
CREATE TABLE IF NOT EXISTS sticky (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  content TEXT NOT NULL,
  last_message_id TEXT,
  last_post_at INTEGER
);
CREATE TABLE IF NOT EXISTS reaction_roles (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (message_id, emoji)
);
CREATE TABLE IF NOT EXISTS afk (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  since INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS automod_rules (
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, kind)
);
CREATE TABLE IF NOT EXISTS custom_commands (
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  response TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, name)
);
CREATE TABLE IF NOT EXISTS form_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  question TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT 'short',
  required INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  guild_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS starboard (
  message_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  star_message_id TEXT,
  stars INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS temp_voice (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS satellites (
  guild_id TEXT PRIMARY KEY,
  hub_guild_id TEXT NOT NULL,
  hub_invite TEXT NOT NULL,
  channels TEXT NOT NULL DEFAULT '[]',
  reply_text TEXT,
  ai_enabled INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  rate_limit_minutes INTEGER NOT NULL DEFAULT 60,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  satellite_guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  referred_by TEXT,
  ticket_id INTEGER,
  created_at INTEGER NOT NULL,
  converted_at INTEGER
);
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  hub_guild_id TEXT,
  hub_invite TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  added_by TEXT NOT NULL,
  coin_id TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  discord_url TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  guild_id TEXT,
  invite_code TEXT,
  created_at INTEGER NOT NULL
);
`;

const PG_DDL = `
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  support_role_id TEXT,
  admin_role_id TEXT,
  log_channel_id TEXT,
  transcript_channel_id TEXT,
  open_category_id TEXT,
  closed_category_id TEXT,
  max_tickets INTEGER NOT NULL DEFAULT 3,
  cooldown_seconds INTEGER NOT NULL DEFAULT 60,
  autoclose_hours INTEGER NOT NULL DEFAULT 24,
  ticket_counter BIGINT NOT NULL DEFAULT 0,
  panel_title TEXT,
  panel_description TEXT,
  welcome_channel_id TEXT,
  welcome_message TEXT,
  autorole_id TEXT,
  suggestions_channel_id TEXT,
  escalation_minutes INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  seeded INTEGER NOT NULL DEFAULT 0,
  welcome_card INTEGER NOT NULL DEFAULT 0,
  starboard_channel_id TEXT,
  starboard_threshold INTEGER NOT NULL DEFAULT 0,
  voice_hub_channel_id TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  number INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'medium',
  claimed_by TEXT,
  control_message_id TEXT,
  created_at BIGINT NOT NULL,
  closed_at BIGINT,
  closed_by TEXT,
  close_reason TEXT,
  warned_at BIGINT,
  last_message_at BIGINT,
  first_staff_reply_at BIGINT,
  escalated_at BIGINT
);
CREATE TABLE IF NOT EXISTS notes (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ratings (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  stars INTEGER NOT NULL,
  feedback TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE(ticket_id, user_id)
);
CREATE TABLE IF NOT EXISTS links (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  UNIQUE(guild_id, label)
);
CREATE TABLE IF NOT EXISTS blacklist (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS cooldowns (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_open BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS ticket_types (
  guild_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  emoji TEXT,
  category_id TEXT,
  instant INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, type_id)
);
CREATE TABLE IF NOT EXISTS tags (
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id, name)
);
CREATE TABLE IF NOT EXISTS suggestions (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  choice TEXT NOT NULL,
  PRIMARY KEY (subject, user_id)
);
CREATE TABLE IF NOT EXISTS polls (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  author_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  ends_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS warnings (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS global_blacklist (
  user_id TEXT PRIMARY KEY,
  reason TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  text TEXT NOT NULL,
  remind_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS giveaways (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  host_id TEXT NOT NULL,
  prize TEXT NOT NULL,
  winner_count INTEGER NOT NULL DEFAULT 1,
  ends_at BIGINT,
  closed INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (giveaway_id, user_id)
);
CREATE TABLE IF NOT EXISTS sticky (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  content TEXT NOT NULL,
  last_message_id TEXT,
  last_post_at BIGINT
);
CREATE TABLE IF NOT EXISTS reaction_roles (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (message_id, emoji)
);
CREATE TABLE IF NOT EXISTS afk (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  since BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS automod_rules (
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, kind)
);
CREATE TABLE IF NOT EXISTS custom_commands (
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  response TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id, name)
);
CREATE TABLE IF NOT EXISTS form_fields (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  question TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT 'short',
  required INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT NOT NULL,
  guild_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS starboard (
  message_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  star_message_id TEXT,
  stars INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS temp_voice (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS satellites (
  guild_id TEXT PRIMARY KEY,
  hub_guild_id TEXT NOT NULL,
  hub_invite TEXT NOT NULL,
  channels TEXT NOT NULL DEFAULT '[]',
  reply_text TEXT,
  ai_enabled INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  rate_limit_minutes INTEGER NOT NULL DEFAULT 60,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS referrals (
  id BIGSERIAL PRIMARY KEY,
  satellite_guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  referred_by TEXT,
  ticket_id BIGINT,
  created_at BIGINT NOT NULL,
  converted_at BIGINT
);
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  hub_guild_id TEXT,
  hub_invite TEXT,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist (
  id BIGSERIAL PRIMARY KEY,
  added_by TEXT NOT NULL,
  coin_id TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  discord_url TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  guild_id TEXT,
  invite_code TEXT,
  created_at BIGINT NOT NULL
);
`;

// column upgrades applied to existing databases (sqlite: guarded by PRAGMA; pg: IF NOT EXISTS)
const CFG_TEXT_COLS = [
  'panel_title', 'panel_description', 'welcome_channel_id', 'welcome_message',
  'autorole_id', 'suggestions_channel_id', 'starboard_channel_id', 'voice_hub_channel_id',
];
const CFG_INT_COLS = ['seeded', 'escalation_minutes', 'disabled', 'welcome_card', 'starboard_threshold'];
const TICKET_INT_COLS = ['first_staff_reply_at', 'escalated_at'];

// ---------- drivers ----------

const pgUrl = env.databaseUrlPooled || env.databaseUrl;
const usePg = !!pgUrl;
export const DB_KIND: 'pg' | 'sqlite' = usePg ? 'pg' : 'sqlite';

let sqlite: DatabaseSync | null = null;
let pg: Pool | null = null;

if (!usePg) {
  sqlite = new DatabaseSync('data/tickets.db');
} else {
  // pg returns BIGINT/NUMERIC as strings by default — parse them as numbers
  pgTypes.setTypeParser(20, (v: string | null) => (v === null ? v : Number(v))); // int8
  pgTypes.setTypeParser(1700, (v: string | null) => (v === null ? v : parseFloat(v))); // numeric (AVG etc)
  pg = new Pool({
    // sslmode/no-ssl is taken from the connection string (pg parses sslmode itself)
    connectionString: pgUrl.replace(/channel_binding=[^&]*&?/, ''),
    max: 5,
  });
}

async function initSchema(): Promise<void> {
  if (sqlite) {
    sqlite.exec(SQLITE_DDL);
    const cfgCols = (sqlite.prepare('PRAGMA table_info(guild_config)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const col of CFG_TEXT_COLS) {
      if (!cfgCols.includes(col)) sqlite.exec(`ALTER TABLE guild_config ADD COLUMN ${col} TEXT`);
    }
    for (const col of CFG_INT_COLS) {
      if (!cfgCols.includes(col)) sqlite.exec(`ALTER TABLE guild_config ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    }
    const ticketCols = (sqlite.prepare('PRAGMA table_info(tickets)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const col of TICKET_INT_COLS) {
      if (!ticketCols.includes(col)) sqlite.exec(`ALTER TABLE tickets ADD COLUMN ${col} INTEGER`);
    }
    const wlCols = (sqlite.prepare('PRAGMA table_info(watchlist)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const col of ['guild_id', 'invite_code']) {
      if (!wlCols.includes(col)) sqlite.exec(`ALTER TABLE watchlist ADD COLUMN ${col} TEXT`);
    }
    const refCols = (sqlite.prepare('PRAGMA table_info(referrals)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (!refCols.includes('referred_by')) {
      sqlite.exec('ALTER TABLE referrals ADD COLUMN referred_by TEXT');
    }
    const ttCols = (sqlite.prepare('PRAGMA table_info(ticket_types)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (!ttCols.includes('category_id')) {
      sqlite.exec('ALTER TABLE ticket_types ADD COLUMN category_id TEXT');
    }
    if (!ttCols.includes('instant')) {
      sqlite.exec('ALTER TABLE ticket_types ADD COLUMN instant INTEGER NOT NULL DEFAULT 1');
    }
    return;
  }
  const p = pg!;
  await p.query(PG_DDL);
  for (const col of CFG_TEXT_COLS) {
    await p.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS ${col} TEXT`);
  }
  for (const col of CFG_INT_COLS) {
    await p.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS ${col} INTEGER NOT NULL DEFAULT 0`);
  }
  for (const col of TICKET_INT_COLS) {
    await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ${col} BIGINT`);
  }
  for (const col of ['guild_id', 'invite_code']) {
    await p.query(`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS ${col} TEXT`);
  }
  await p.query('ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referred_by TEXT');
  await p.query('ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS category_id TEXT');
  await p.query('ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS instant INTEGER NOT NULL DEFAULT 1');
}

let initPromise: Promise<void> | null = null;
function ensure(): Promise<void> {
  return (initPromise ??= initSchema().catch((err) => {
    initPromise = null;
    throw err;
  }));
}

async function qRun(sql: string, params: unknown[]): Promise<RunResult> {
  await ensure();
  if (sqlite) {
    const res = sqlite.prepare(sql).run(...(params as never[]));
    return { changes: Number(res.changes), lastId: Number(res.lastInsertRowid) };
  }
  const res = await pg!.query(toPg(sql), params as never[]);
  const row = res.rows[0] as { id?: number | string } | undefined;
  return { changes: res.rowCount ?? 0, lastId: Number(row?.id ?? 0) };
}

async function qGet<T>(sql: string, params: unknown[]): Promise<T | undefined> {
  await ensure();
  if (sqlite) return sqlite.prepare(sql).get(...(params as never[])) as T | undefined;
  const res = await pg!.query(toPg(sql), params as never[]);
  return res.rows[0] as T | undefined;
}

async function qAll<T>(sql: string, params: unknown[]): Promise<T[]> {
  await ensure();
  if (sqlite) return sqlite.prepare(sql).all(...(params as never[])) as T[];
  const res = await pg!.query(toPg(sql), params as never[]);
  return res.rows as T[];
}

// raw query helpers for cross-module use (session store, dashboards counts, etc.)
export const dbRun = qRun;
export const dbGet = qGet;
export const dbAll = qAll;

const D = { run: qRun, get: qGet, all: qAll };

export interface GuildConfig {
  guild_id: string;
  support_role_id: string | null;
  admin_role_id: string | null;
  log_channel_id: string | null;
  transcript_channel_id: string | null;
  open_category_id: string | null;
  closed_category_id: string | null;
  max_tickets: number;
  cooldown_seconds: number;
  autoclose_hours: number;
  ticket_counter: number;
  panel_title: string | null;
  panel_description: string | null;
  welcome_channel_id: string | null;
  welcome_message: string | null;
  autorole_id: string | null;
  suggestions_channel_id: string | null;
  escalation_minutes: number;
  disabled: number;
  seeded: number;
  welcome_card: number;
  starboard_channel_id: string | null;
  starboard_threshold: number;
  voice_hub_channel_id: string | null;
}

export interface TicketTypeRow {
  guild_id: string;
  type_id: string;
  label: string;
  description: string | null;
  emoji: string | null;
  category_id: string | null;
  instant: number;
  position: number;
}

export interface Ticket {
  id: number;
  number: number;
  guild_id: string;
  channel_id: string;
  owner_id: string;
  type: string;
  subject: string | null;
  description: string | null;
  status: 'open' | 'closed' | 'deleted';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  claimed_by: string | null;
  control_message_id: string | null;
  created_at: number;
  closed_at: number | null;
  closed_by: string | null;
  close_reason: string | null;
  warned_at: number | null;
  last_message_at: number | null;
  first_staff_reply_at: number | null;
  escalated_at: number | null;
}

export interface Note {
  id: number;
  ticket_id: number;
  author_id: string;
  content: string;
  created_at: number;
}

export interface LinkRow {
  id: number;
  guild_id: string;
  label: string;
  url: string;
  description: string | null;
}

// ---------- guild config ----------

export async function getConfig(guildId: string): Promise<GuildConfig> {
  let cfg = await D.get('SELECT * FROM guild_config WHERE guild_id = ?', [guildId]) as
    | GuildConfig
    | undefined;
  if (!cfg) {
    await D.run('INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)', [guildId]);
    cfg = await D.get('SELECT * FROM guild_config WHERE guild_id = ?', [guildId]) as unknown as GuildConfig;
  }
  if (!cfg.seeded) {
    await seedGuildDefaults(guildId);
    await D.run('UPDATE guild_config SET seeded = 1 WHERE guild_id = ?', [guildId]);
    cfg.seeded = 1;
  }
  return cfg;
}

async function seedGuildDefaults(guildId: string): Promise<void> {
  for (const [idx, t] of botConfig.ticketTypes.entries()) {
    await D.run('INSERT OR IGNORE INTO ticket_types (guild_id, type_id, label, description, emoji, position) VALUES (?, ?, ?, ?, ?, ?)', [guildId, t.id, t.label, t.description ?? null, t.emoji ?? null, idx]);
  }
  for (const l of botConfig.links) {
    await D.run('INSERT OR IGNORE INTO links (guild_id, label, url, description) VALUES (?, ?, ?, ?)', [guildId, l.label, l.url, l.description ?? null]);
  }
}

export async function saveConfig(guildId: string, patch: Partial<Omit<GuildConfig, 'guild_id'>>): Promise<void> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  await getConfig(guildId);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  await D.run(`UPDATE guild_config SET ${set} WHERE guild_id = ?`, [...keys.map((k) => patch[k] as string | number | null),
    guildId,]);
}

export async function nextTicketNumber(guildId: string): Promise<number> {
  await D.run('UPDATE guild_config SET ticket_counter = ticket_counter + 1 WHERE guild_id = ?', [guildId,]);
  const row = await D.get('SELECT ticket_counter AS c FROM guild_config WHERE guild_id = ?', [guildId]) as { c: number };
  return row.c;
}

// ---------- tickets ----------

export async function insertTicket(t: Omit<Ticket, 'id'>): Promise<Ticket> {
  const res = await D.run(`INSERT INTO tickets (number, guild_id, channel_id, owner_id, type, subject, description,
        status, priority, claimed_by, control_message_id, created_at, closed_at, closed_by,
        close_reason, warned_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [t.number, t.guild_id, t.channel_id, t.owner_id, t.type, t.subject, t.description,
      t.status, t.priority, t.claimed_by, t.control_message_id, t.created_at, t.closed_at,
      t.closed_by, t.close_reason, t.warned_at, t.last_message_at,]);
  return { ...t, id: Number(res.lastId) };
}

export async function getTicketByChannel(channelId: string): Promise<Ticket | undefined> {
  return await D.get('SELECT * FROM tickets WHERE channel_id = ?', [channelId]) as
    | Ticket
    | undefined;
}

export async function getTicketById(id: number): Promise<Ticket | undefined> {
  return await D.get('SELECT * FROM tickets WHERE id = ?', [id]) as Ticket | undefined;
}

export async function updateTicket(id: number, patch: Partial<Omit<Ticket, 'id'>>): Promise<void> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = ?`).join(', ');
  await D.run(`UPDATE tickets SET ${set} WHERE id = ?`, [...keys.map((k) => patch[k] as string | number | null),
    id,]);
}

export async function openTicketCount(guildId: string, ownerId: string): Promise<number> {
  const row = await D.get(`SELECT COUNT(*) AS c FROM tickets WHERE guild_id = ? AND owner_id = ? AND status = 'open'`, [guildId, ownerId]) as { c: number };
  return row.c;
}

export async function listTickets(guildId: string, status?: string, ownerId?: string, limit = 20): Promise<Ticket[]> {
  let sql = 'SELECT * FROM tickets WHERE guild_id = ?';
  const params: (string | number)[] = [guildId];
  if (status && status !== 'all') {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (ownerId) {
    sql += ' AND owner_id = ?';
    params.push(ownerId);
  }
  sql += ' ORDER BY number DESC LIMIT ?';
  params.push(limit);
  return await D.all(sql, [...params]) as unknown as Ticket[];
}

export async function openTickets(): Promise<Ticket[]> {
  return await D.all(`SELECT * FROM tickets WHERE status = 'open'`, []) as unknown as Ticket[];
}

// ---------- notes ----------

export async function addNote(ticketId: number, authorId: string, content: string): Promise<void> {
  await D.run('INSERT INTO notes (ticket_id, author_id, content, created_at) VALUES (?, ?, ?, ?)', [ticketId, authorId, content, Date.now(),]);
}

export async function getNotes(ticketId: number): Promise<Note[]> {
  return await D.all('SELECT * FROM notes WHERE ticket_id = ? ORDER BY created_at', [ticketId]) as unknown as Note[];
}

// ---------- ratings ----------

export async function upsertRating(ticketId: number, userId: string, stars: number, feedback: string | null): Promise<void> {
  await D.run(`INSERT INTO ratings (ticket_id, user_id, stars, feedback, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(ticket_id, user_id) DO UPDATE SET stars = excluded.stars, feedback = excluded.feedback`, [ticketId, userId, stars, feedback, Date.now()]);
}

export async function avgRating(guildId: string): Promise<number | null> {
  const row = await D.get(`SELECT AVG(r.stars) AS a FROM ratings r JOIN tickets t ON t.id = r.ticket_id WHERE t.guild_id = ?`, [guildId]) as { a: number | null };
  return row.a;
}

// ---------- links ----------

export async function getLinks(guildId: string): Promise<LinkRow[]> {
  return await D.all('SELECT * FROM links WHERE guild_id = ? ORDER BY label', [guildId]) as unknown as LinkRow[];
}

export async function addLink(guildId: string, label: string, url: string, description: string | null): Promise<boolean> {
  const res = await D.run('INSERT OR IGNORE INTO links (guild_id, label, url, description) VALUES (?, ?, ?, ?)', [guildId, label, url, description]);
  return Number(res.changes) > 0;
}

export async function removeLink(guildId: string, label: string): Promise<boolean> {
  const res = await D.run('DELETE FROM links WHERE guild_id = ? AND label = ?', [guildId, label]);
  return Number(res.changes) > 0;
}

// ---------- blacklist ----------

export async function isBlacklisted(guildId: string, userId: string): Promise<boolean> {
  return !!await D.get('SELECT 1 FROM blacklist WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
}

export async function blacklistAdd(guildId: string, userId: string, reason: string | null): Promise<void> {
  await D.run('INSERT OR REPLACE INTO blacklist (guild_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)', [guildId, userId, reason, Date.now()]);
}

export async function blacklistRemove(guildId: string, userId: string): Promise<boolean> {
  const res = await D.run('DELETE FROM blacklist WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  return Number(res.changes) > 0;
}

export async function blacklistList(guildId: string): Promise<{ user_id: string; reason: string | null }[]> {
  return await D.all('SELECT user_id, reason FROM blacklist WHERE guild_id = ?', [guildId]) as unknown as {
    user_id: string;
    reason: string | null;
  }[];
}

// ---------- cooldowns ----------

export async function lastOpenAt(guildId: string, userId: string): Promise<number> {
  const row = await D.get('SELECT last_open FROM cooldowns WHERE guild_id = ? AND user_id = ?', [guildId, userId]) as { last_open: number } | undefined;
  return row?.last_open ?? 0;
}

export async function touchCooldown(guildId: string, userId: string): Promise<void> {
  await D.run('INSERT OR REPLACE INTO cooldowns (guild_id, user_id, last_open) VALUES (?, ?, ?)', [guildId, userId, Date.now()]);
}

// ---------- ticket types (per-guild) ----------

export async function getTicketTypes(guildId: string): Promise<TicketTypeRow[]> {
  return await D.all('SELECT * FROM ticket_types WHERE guild_id = ? ORDER BY position, label', [guildId]) as unknown as TicketTypeRow[];
}

export async function getTicketType(guildId: string, typeId: string): Promise<TicketTypeRow | undefined> {
  return await D.get('SELECT * FROM ticket_types WHERE guild_id = ? AND type_id = ?', [guildId, typeId]) as TicketTypeRow | undefined;
}

export async function addTicketType(
  guildId: string,
  t: { type_id: string; label: string; description?: string | null; emoji?: string | null; category_id?: string | null; instant?: number },
): Promise<boolean> {
  const max = await D.get('SELECT COALESCE(MAX(position), -1) AS m FROM ticket_types WHERE guild_id = ?', [guildId]) as { m: number };
  const res = await D.run('INSERT OR IGNORE INTO ticket_types (guild_id, type_id, label, description, emoji, category_id, instant, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [guildId, t.type_id, t.label, t.description ?? null, t.emoji ?? null, t.category_id ?? null, t.instant ?? 1, max.m + 1]);
  return Number(res.changes) > 0;
}

export async function updateTicketType(
  guildId: string,
  typeId: string,
  patch: Partial<Pick<TicketTypeRow, 'label' | 'description' | 'emoji' | 'category_id' | 'instant'>>,
): Promise<boolean> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return true;
  const set = keys.map((k) => `${k} = ?`).join(', ');
  const res = await D.run(`UPDATE ticket_types SET ${set} WHERE guild_id = ? AND type_id = ?`, [...keys.map((k) => patch[k] as string | null), guildId, typeId]);
  return Number(res.changes) > 0;
}

export async function removeTicketType(guildId: string, typeId: string): Promise<boolean> {
  const res = await D.run('DELETE FROM ticket_types WHERE guild_id = ? AND type_id = ?', [guildId, typeId]);
  return Number(res.changes) > 0;
}

// ---------- tags (canned replies) ----------

export interface TagRow {
  guild_id: string;
  name: string;
  content: string;
  created_at: number;
}

export async function getTags(guildId: string): Promise<TagRow[]> {
  return await D.all('SELECT * FROM tags WHERE guild_id = ? ORDER BY name', [guildId]) as unknown as TagRow[];
}

export async function getTag(guildId: string, name: string): Promise<TagRow | undefined> {
  return await D.get('SELECT * FROM tags WHERE guild_id = ? AND name = ?', [guildId, name]) as TagRow | undefined;
}

export async function setTag(guildId: string, name: string, content: string): Promise<void> {
  await D.run('INSERT OR REPLACE INTO tags (guild_id, name, content, created_at) VALUES (?, ?, ?, ?)', [guildId, name, content, Date.now()]);
}

export async function removeTag(guildId: string, name: string): Promise<boolean> {
  return Number((await D.run('DELETE FROM tags WHERE guild_id = ? AND name = ?', [guildId, name])).changes) > 0;
}

// ---------- suggestions ----------

export interface SuggestionRow {
  id: number;
  guild_id: string;
  channel_id: string | null;
  message_id: string | null;
  author_id: string;
  content: string;
  status: 'pending' | 'approved' | 'denied' | 'implemented';
  created_at: number;
}

export async function insertSuggestion(guildId: string, authorId: string, content: string): Promise<number> {
  const res = await D.run('INSERT INTO suggestions (guild_id, author_id, content, created_at) VALUES (?, ?, ?, ?)', [guildId, authorId, content, Date.now()]);
  return Number(res.lastId);
}

export async function setSuggestionMessage(id: number, channelId: string, messageId: string): Promise<void> {
  await D.run('UPDATE suggestions SET channel_id = ?, message_id = ? WHERE id = ?', [channelId, messageId, id,]);
}

export async function getSuggestion(id: number): Promise<SuggestionRow | undefined> {
  return await D.get('SELECT * FROM suggestions WHERE id = ?', [id]) as SuggestionRow | undefined;
}

export async function setSuggestionStatus(id: number, status: SuggestionRow['status']): Promise<void> {
  await D.run('UPDATE suggestions SET status = ? WHERE id = ?', [status, id]);
}

export async function getSuggestions(guildId: string, limit = 25): Promise<SuggestionRow[]> {
  return await D.all('SELECT * FROM suggestions WHERE guild_id = ? ORDER BY id DESC LIMIT ?', [guildId, limit]) as unknown as SuggestionRow[];
}

// ---------- votes (suggestions + polls) ----------

export async function setVote(subject: string, userId: string, choice: string): Promise<void> {
  await D.run('INSERT OR REPLACE INTO votes (subject, user_id, choice) VALUES (?, ?, ?)', [subject, userId, choice,]);
}

export async function removeVote(subject: string, userId: string): Promise<void> {
  await D.run('DELETE FROM votes WHERE subject = ? AND user_id = ?', [subject, userId]);
}

export async function getUserVote(subject: string, userId: string): Promise<string | null> {
  const row = await D.get('SELECT choice FROM votes WHERE subject = ? AND user_id = ?', [subject, userId]) as { choice: string } | undefined;
  return row?.choice ?? null;
}

export async function voteCounts(subject: string): Promise<Record<string, number>> {
  const rows = await D.all('SELECT choice, COUNT(*) AS c FROM votes WHERE subject = ? GROUP BY choice', [subject]) as { choice: string; c: number }[];
  return Object.fromEntries(rows.map((r) => [r.choice, r.c]));
}

// ---------- polls ----------

export interface PollRow {
  id: number;
  guild_id: string;
  channel_id: string | null;
  message_id: string | null;
  author_id: string;
  question: string;
  options: string; // JSON string[]
  closed: number;
  ends_at: number | null;
  created_at: number;
}

export async function insertPoll(
  guildId: string,
  authorId: string,
  question: string,
  options: string[],
  endsAt: number | null,
): Promise<number> {
  const res = await D.run('INSERT INTO polls (guild_id, author_id, question, options, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [guildId, authorId, question, JSON.stringify(options), endsAt, Date.now()]);
  return Number(res.lastId);
}

export async function setPollMessage(id: number, channelId: string, messageId: string): Promise<void> {
  await D.run('UPDATE polls SET channel_id = ?, message_id = ? WHERE id = ?', [channelId, messageId, id,]);
}

export async function getPoll(id: number): Promise<PollRow | undefined> {
  return await D.get('SELECT * FROM polls WHERE id = ?', [id]) as PollRow | undefined;
}

export async function closePollRow(id: number): Promise<void> {
  await D.run('UPDATE polls SET closed = 1 WHERE id = ?', [id]);
}

export async function expiredPolls(now: number): Promise<PollRow[]> {
  return await D.all('SELECT * FROM polls WHERE closed = 0 AND ends_at IS NOT NULL AND ends_at < ?', [now]) as unknown as PollRow[];
}

// ---------- warnings ----------

export interface WarningRow {
  id: number;
  guild_id: string;
  user_id: string;
  moderator_id: string;
  reason: string;
  created_at: number;
}

export async function addWarning(guildId: string, userId: string, modId: string, reason: string): Promise<void> {
  await D.run('INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)', [guildId, userId, modId, reason, Date.now()]);
}

export async function getWarnings(guildId: string, userId: string): Promise<WarningRow[]> {
  return await D.all('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC', [guildId, userId]) as unknown as WarningRow[];
}

export async function clearWarnings(guildId: string, userId: string): Promise<number> {
  return Number(
    (await D.run('DELETE FROM warnings WHERE guild_id = ? AND user_id = ?', [guildId, userId])).changes,
  );
}

// ---------- godmode: global blacklist + fleet ----------

export async function isGloballyBlacklisted(userId: string): Promise<boolean> {
  return !!await D.get('SELECT 1 FROM global_blacklist WHERE user_id = ?', [userId]);
}

export async function globalBlacklistAdd(userId: string, reason: string | null): Promise<void> {
  await D.run('INSERT OR REPLACE INTO global_blacklist (user_id, reason, created_at) VALUES (?, ?, ?)', [userId, reason, Date.now()]);
}

export async function globalBlacklistRemove(userId: string): Promise<boolean> {
  return Number((await D.run('DELETE FROM global_blacklist WHERE user_id = ?', [userId])).changes) > 0;
}

export async function globalBlacklistList(): Promise<{ user_id: string; reason: string | null; created_at: number }[]> {
  return await D.all('SELECT * FROM global_blacklist ORDER BY created_at DESC', []) as unknown as { user_id: string; reason: string | null; created_at: number }[];
}

export interface FleetRow extends GuildConfig {
  open_tickets: number;
  total_tickets: number;
  type_count: number;
}

export async function fleetStats(): Promise<FleetRow[]> {
  return await D.all(`SELECT gc.*,
         COALESCE(SUM(CASE WHEN t.status = 'open' THEN 1 ELSE 0 END), 0) AS open_tickets,
         COUNT(t.id) AS total_tickets,
         (SELECT COUNT(*) FROM ticket_types tt WHERE tt.guild_id = gc.guild_id) AS type_count
       FROM guild_config gc
       LEFT JOIN tickets t ON t.guild_id = gc.guild_id
       GROUP BY gc.guild_id`, []) as unknown as FleetRow[];
}

// ---------- reminders ----------

export interface ReminderRow {
  id: number;
  guild_id: string;
  user_id: string;
  channel_id: string;
  text: string;
  remind_at: number;
  created_at: number;
}

export async function addReminder(guildId: string, userId: string, channelId: string, text: string, at: number): Promise<number> {
  const res = await D.run('INSERT INTO reminders (guild_id, user_id, channel_id, text, remind_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [guildId, userId, channelId, text, at, Date.now()]);
  return Number(res.lastId);
}

export async function getReminders(guildId: string, userId: string): Promise<ReminderRow[]> {
  return await D.all('SELECT * FROM reminders WHERE guild_id = ? AND user_id = ? ORDER BY remind_at', [guildId, userId]) as unknown as ReminderRow[];
}

export async function dueReminders(now: number): Promise<ReminderRow[]> {
  return await D.all('SELECT * FROM reminders WHERE remind_at <= ?', [now]) as unknown as ReminderRow[];
}

export async function deleteReminder(id: number): Promise<boolean> {
  return Number((await D.run('DELETE FROM reminders WHERE id = ?', [id])).changes) > 0;
}

// ---------- giveaways ----------

export interface GiveawayRow {
  id: number;
  guild_id: string;
  channel_id: string | null;
  message_id: string | null;
  host_id: string;
  prize: string;
  winner_count: number;
  ends_at: number | null;
  closed: number;
  created_at: number;
}

export async function insertGiveaway(g: { guild_id: string; host_id: string; prize: string; winner_count: number; ends_at: number | null }): Promise<number> {
  const res = await D.run('INSERT INTO giveaways (guild_id, host_id, prize, winner_count, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [g.guild_id, g.host_id, g.prize, g.winner_count, g.ends_at, Date.now()]);
  return Number(res.lastId);
}

export async function setGiveawayMessage(id: number, channelId: string, messageId: string): Promise<void> {
  await D.run('UPDATE giveaways SET channel_id = ?, message_id = ? WHERE id = ?', [channelId, messageId, id]);
}

export async function getGiveaway(id: number): Promise<GiveawayRow | undefined> {
  return await D.get('SELECT * FROM giveaways WHERE id = ?', [id]) as GiveawayRow | undefined;
}

export async function activeGiveaways(guildId: string): Promise<GiveawayRow[]> {
  return await D.all('SELECT * FROM giveaways WHERE guild_id = ? AND closed = 0', [guildId]) as unknown as GiveawayRow[];
}

export async function expiredGiveaways(now: number): Promise<GiveawayRow[]> {
  return await D.all('SELECT * FROM giveaways WHERE closed = 0 AND ends_at IS NOT NULL AND ends_at <= ?', [now]) as unknown as GiveawayRow[];
}

export async function closeGiveaway(id: number): Promise<void> {
  await D.run('UPDATE giveaways SET closed = 1 WHERE id = ?', [id]);
}

export async function enterGiveaway(id: number, userId: string): Promise<'entered' | 'left'> {
  const existing = await D.get('SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?', [id, userId]);
  if (existing) {
    await D.run('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?', [id, userId]);
    return 'left';
  }
  await D.run('INSERT INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)', [id, userId]);
  return 'entered';
}

export async function giveawayEntries(id: number): Promise<string[]> {
  return (await D.all('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?', [id]) as { user_id: string }[]).map((r) => r.user_id);
}

export async function giveawayEntryCount(id: number): Promise<number> {
  return (await D.get('SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id = ?', [id]) as { c: number }).c;
}

// ---------- sticky ----------

export interface StickyRow {
  channel_id: string;
  guild_id: string;
  content: string;
  last_message_id: string | null;
  last_post_at: number | null;
}

export async function setSticky(guildId: string, channelId: string, content: string): Promise<void> {
  await D.run('INSERT OR REPLACE INTO sticky (channel_id, guild_id, content, last_message_id, last_post_at) VALUES (?, ?, ?, NULL, NULL)', [channelId, guildId, content]);
}

export async function getSticky(channelId: string): Promise<StickyRow | undefined> {
  return await D.get('SELECT * FROM sticky WHERE channel_id = ?', [channelId]) as StickyRow | undefined;
}

export async function removeSticky(channelId: string): Promise<boolean> {
  return Number((await D.run('DELETE FROM sticky WHERE channel_id = ?', [channelId])).changes) > 0;
}

export async function updateSticky(channelId: string, lastMessageId: string, at: number): Promise<void> {
  await D.run('UPDATE sticky SET last_message_id = ?, last_post_at = ? WHERE channel_id = ?', [lastMessageId, at, channelId]);
}

// ---------- reaction roles ----------

export interface ReactionRoleRow {
  guild_id: string;
  channel_id: string;
  message_id: string;
  emoji: string;
  role_id: string;
}

export async function bindReactionRole(guildId: string, channelId: string, messageId: string, emoji: string, roleId: string): Promise<void> {
  await D.run('INSERT OR REPLACE INTO reaction_roles (guild_id, channel_id, message_id, emoji, role_id) VALUES (?, ?, ?, ?, ?)', [guildId, channelId, messageId, emoji, roleId]);
}

export async function unbindReactionRole(messageId: string, emoji: string): Promise<boolean> {
  return Number((await D.run('DELETE FROM reaction_roles WHERE message_id = ? AND emoji = ?', [messageId, emoji])).changes) > 0;
}

export async function getReactionRole(messageId: string, emoji: string): Promise<ReactionRoleRow | undefined> {
  return await D.get('SELECT * FROM reaction_roles WHERE message_id = ? AND emoji = ?', [messageId, emoji]) as ReactionRoleRow | undefined;
}

export async function listReactionRoles(guildId: string): Promise<ReactionRoleRow[]> {
  return await D.all('SELECT * FROM reaction_roles WHERE guild_id = ?', [guildId]) as unknown as ReactionRoleRow[];
}

// ---------- afk ----------

export async function setAfk(guildId: string, userId: string, reason: string | null): Promise<void> {
  await D.run('INSERT OR REPLACE INTO afk (guild_id, user_id, reason, since) VALUES (?, ?, ?, ?)', [guildId, userId, reason, Date.now()]);
}

export async function getAfk(guildId: string, userId: string): Promise<{ reason: string | null; since: number } | undefined> {
  return await D.get('SELECT reason, since FROM afk WHERE guild_id = ? AND user_id = ?', [guildId, userId]) as { reason: string | null; since: number } | undefined;
}

export async function clearAfk(guildId: string, userId: string): Promise<boolean> {
  return Number((await D.run('DELETE FROM afk WHERE guild_id = ? AND user_id = ?', [guildId, userId])).changes) > 0;
}

// ---------- automod ----------

export async function getAutomodRule(guildId: string, kind: string): Promise<string | null> {
  const row = await D.get('SELECT rule_id FROM automod_rules WHERE guild_id = ? AND kind = ?', [guildId, kind]) as { rule_id: string } | undefined;
  return row?.rule_id ?? null;
}

export async function setAutomodRule(guildId: string, kind: string, ruleId: string): Promise<void> {
  await D.run('INSERT OR REPLACE INTO automod_rules (guild_id, kind, rule_id) VALUES (?, ?, ?)', [guildId, kind, ruleId]);
}

export async function deleteAutomodRule(guildId: string, kind: string): Promise<void> {
  await D.run('DELETE FROM automod_rules WHERE guild_id = ? AND kind = ?', [guildId, kind]);
}

export async function deleteAutomodRuleById(ruleId: string): Promise<void> {
  await D.run('DELETE FROM automod_rules WHERE rule_id = ?', [ruleId]);
}

// ---------- custom commands ----------

export interface CustomCommandRow {
  guild_id: string;
  name: string;
  response: string;
  uses: number;
  created_at: number;
}

export async function setCustomCommand(guildId: string, name: string, response: string): Promise<void> {
  await D.run(`INSERT INTO custom_commands (guild_id, name, response, uses, created_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(guild_id, name) DO UPDATE SET response = excluded.response`, [guildId, name, response, Date.now()]);
}

export async function getCustomCommand(guildId: string, name: string): Promise<CustomCommandRow | undefined> {
  return await D.get('SELECT * FROM custom_commands WHERE guild_id = ? AND name = ?', [guildId, name]) as CustomCommandRow | undefined;
}

export async function listCustomCommands(guildId: string): Promise<CustomCommandRow[]> {
  return await D.all('SELECT * FROM custom_commands WHERE guild_id = ? ORDER BY name', [guildId]) as unknown as CustomCommandRow[];
}

export async function removeCustomCommand(guildId: string, name: string): Promise<boolean> {
  return Number((await D.run('DELETE FROM custom_commands WHERE guild_id = ? AND name = ?', [guildId, name])).changes) > 0;
}

export async function bumpCustomCommand(guildId: string, name: string): Promise<void> {
  await D.run('UPDATE custom_commands SET uses = uses + 1 WHERE guild_id = ? AND name = ?', [guildId, name]);
}

// ---------- ticket form fields ----------

export interface FormFieldRow {
  id: number;
  guild_id: string;
  type_id: string;
  question: string;
  style: 'short' | 'paragraph';
  required: number;
  position: number;
}

export async function getFormFields(guildId: string, typeId: string): Promise<FormFieldRow[]> {
  return await D.all('SELECT * FROM form_fields WHERE guild_id = ? AND type_id = ? ORDER BY position, id', [guildId, typeId]) as unknown as FormFieldRow[];
}

export async function addFormField(guildId: string, typeId: string, question: string, style: string, required: boolean): Promise<number | null> {
  const count = (await getFormFields(guildId, typeId)).length;
  if (count >= 5) return null; // Discord modal cap
  const res = await D.run('INSERT INTO form_fields (guild_id, type_id, question, style, required, position) VALUES (?, ?, ?, ?, ?, ?)', [guildId, typeId, question, style === 'paragraph' ? 'paragraph' : 'short', required ? 1 : 0, count]);
  return Number(res.lastId);
}

export async function removeFormField(id: number, guildId: string): Promise<boolean> {
  return Number((await D.run('DELETE FROM form_fields WHERE id = ? AND guild_id = ?', [id, guildId])).changes) > 0;
}

export async function clearFormFields(guildId: string, typeId: string): Promise<number> {
  return Number((await D.run('DELETE FROM form_fields WHERE guild_id = ? AND type_id = ?', [guildId, typeId])).changes);
}

// ---------- misc list helpers (dashboard) ----------

export async function allGiveaways(guildId: string): Promise<GiveawayRow[]> {
  return await D.all('SELECT * FROM giveaways WHERE guild_id = ? ORDER BY id DESC LIMIT 50', [guildId]) as unknown as GiveawayRow[];
}

export async function listStickies(guildId: string): Promise<StickyRow[]> {
  return await D.all('SELECT * FROM sticky WHERE guild_id = ?', [guildId]) as unknown as StickyRow[];
}

// ---------- audit log ----------

export interface AuditRow {
  id: number;
  actor_id: string;
  guild_id: string | null;
  action: string;
  detail: string | null;
  created_at: number;
}

export async function logAudit(actorId: string, action: string, guildId?: string | null, detail?: string | null): Promise<void> {
  await D.run('INSERT INTO audit_log (actor_id, guild_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)', [actorId, guildId ?? null, action, detail ?? null, Date.now()]);
}

export async function getAuditLog(guildId?: string, limit = 50): Promise<AuditRow[]> {
  if (guildId) {
    return await D.all('SELECT * FROM audit_log WHERE guild_id = ? ORDER BY id DESC LIMIT ?', [guildId, limit]) as unknown as AuditRow[];
  }
  return await D.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [limit]) as unknown as AuditRow[];
}

// ---------- starboard ----------

export interface StarboardRow {
  message_id: string;
  guild_id: string;
  channel_id: string;
  star_message_id: string | null;
  stars: number;
}

export async function getStarEntry(messageId: string): Promise<StarboardRow | undefined> {
  return await D.get('SELECT * FROM starboard WHERE message_id = ?', [messageId]) as StarboardRow | undefined;
}

export async function upsertStarEntry(messageId: string, guildId: string, channelId: string, starMessageId: string | null, stars: number): Promise<void> {
  await D.run('INSERT OR REPLACE INTO starboard (message_id, guild_id, channel_id, star_message_id, stars) VALUES (?, ?, ?, ?, ?)', [messageId, guildId, channelId, starMessageId, stars]);
}

// ---------- temp voice ----------

export async function addTempVoice(channelId: string, guildId: string, ownerId: string): Promise<void> {
  await D.run('INSERT OR REPLACE INTO temp_voice (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?)', [channelId, guildId, ownerId, Date.now()]);
}

export async function isTempVoice(channelId: string): Promise<boolean> {
  return !!await D.get('SELECT 1 FROM temp_voice WHERE channel_id = ?', [channelId]);
}

export async function removeTempVoice(channelId: string): Promise<void> {
  await D.run('DELETE FROM temp_voice WHERE channel_id = ?', [channelId]);
}

// ---------- satellites (support funnel) ----------

export interface SatelliteRow {
  guild_id: string;
  hub_guild_id: string;
  hub_invite: string;
  channels: string; // JSON string[] — empty array = watch all channels
  reply_text: string | null;
  ai_enabled: number;
  enabled: number;
  rate_limit_minutes: number;
  created_at: number;
}

export async function getSatellite(guildId: string): Promise<SatelliteRow | undefined> {
  return await D.get('SELECT * FROM satellites WHERE guild_id = ?', [guildId]) as SatelliteRow | undefined;
}

export async function setSatellite(
  guildId: string,
  hubGuildId: string,
  hubInvite: string,
  opts: { channels?: string[]; reply_text?: string | null; ai_enabled?: number; enabled?: number; rate_limit_minutes?: number } = {},
): Promise<void> {
  const channels = JSON.stringify(opts.channels ?? []);
  await D.run(
    `INSERT OR REPLACE INTO satellites (guild_id, hub_guild_id, hub_invite, channels, reply_text, ai_enabled, enabled, rate_limit_minutes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      guildId, hubGuildId, hubInvite, channels, opts.reply_text ?? null,
      opts.ai_enabled ?? 1, opts.enabled ?? 1, opts.rate_limit_minutes ?? 60, Date.now(),
    ],
  );
}

export async function updateSatellite(
  guildId: string,
  patch: Partial<Pick<SatelliteRow, 'hub_invite' | 'reply_text' | 'ai_enabled' | 'enabled' | 'rate_limit_minutes'>> & { channels?: string[] },
): Promise<void> {
  const p: Record<string, unknown> = { ...patch };
  if (patch.channels) p.channels = JSON.stringify(patch.channels);
  const keys = Object.keys(p);
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = ?`).join(', ');
  await D.run(`UPDATE satellites SET ${set} WHERE guild_id = ?`, [...keys.map((k) => p[k]), guildId]);
}

export async function removeSatellite(guildId: string): Promise<boolean> {
  return Number((await D.run('DELETE FROM satellites WHERE guild_id = ?', [guildId])).changes) > 0;
}

export async function listSatellites(): Promise<SatelliteRow[]> {
  return await D.all('SELECT * FROM satellites ORDER BY created_at DESC', []) as unknown as SatelliteRow[];
}

// ---------- referrals ----------

export interface ReferralRow {
  id: number;
  satellite_guild_id: string;
  user_id: string;
  channel_id: string | null;
  message_id: string | null;
  referred_by: string | null;
  ticket_id: number | null;
  created_at: number;
  converted_at: number | null;
}

export async function addReferral(satGid: string, userId: string, channelId: string, messageId: string, referredBy?: string): Promise<number> {
  const res = await D.run(
    'INSERT INTO referrals (satellite_guild_id, user_id, channel_id, message_id, referred_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [satGid, userId, channelId, messageId, referredBy ?? null, Date.now()],
  );
  return res.lastId;
}

export async function getOpenReferral(userId: string): Promise<ReferralRow | undefined> {
  // "open" = not yet linked to a ticket — converted referrals still count,
  // otherwise join-time conversion would lose ticket attribution
  return await D.get(
    'SELECT * FROM referrals WHERE user_id = ? AND ticket_id IS NULL ORDER BY id DESC LIMIT 1',
    [userId],
  ) as ReferralRow | undefined;
}

export async function convertReferral(userId: string, hubGuildId: string): Promise<ReferralRow | undefined> {
  const ref = await D.get(
    `SELECT r.* FROM referrals r
     LEFT JOIN satellites s ON s.guild_id = r.satellite_guild_id
     LEFT JOIN user_profiles up ON up.user_id = r.referred_by
     WHERE r.user_id = ? AND r.converted_at IS NULL
       AND (s.hub_guild_id = ? OR up.hub_guild_id = ?)
     ORDER BY r.id DESC LIMIT 1`,
    [userId, hubGuildId, hubGuildId],
  ) as ReferralRow | undefined;
  if (ref) await D.run('UPDATE referrals SET converted_at = ? WHERE id = ?', [Date.now(), ref.id]);
  return ref;
}

// ---------- per-user hub profiles ----------

export interface UserProfile {
  user_id: string;
  hub_guild_id: string | null;
  hub_invite: string | null;
  updated_at: number;
}

export async function getUserProfile(userId: string): Promise<UserProfile | undefined> {
  return await D.get('SELECT * FROM user_profiles WHERE user_id = ?', [userId]) as
    | UserProfile
    | undefined;
}

export async function getProfilesByHubGuild(hubGid: string): Promise<UserProfile[]> {
  return await D.all(
    'SELECT * FROM user_profiles WHERE hub_guild_id = ? AND hub_invite IS NOT NULL',
    [hubGid],
  ) as unknown as UserProfile[];
}

export async function setUserProfile(
  userId: string,
  hubGuildId: string | null,
  hubInvite: string | null,
): Promise<void> {
  await D.run(
    'INSERT OR REPLACE INTO user_profiles (user_id, hub_guild_id, hub_invite, updated_at) VALUES (?, ?, ?, ?)',
    [userId, hubGuildId, hubInvite, Date.now()],
  );
}

export async function linkReferralTicket(userId: string, ticketId: number): Promise<void> {
  await D.run(
    'UPDATE referrals SET ticket_id = ? WHERE id = (SELECT id FROM referrals WHERE user_id = ? ORDER BY id DESC LIMIT 1)',
    [ticketId, userId],
  );
}

export async function referralsForGuild(satGid: string, limit = 50): Promise<ReferralRow[]> {
  return await D.all(
    'SELECT * FROM referrals WHERE satellite_guild_id = ? ORDER BY id DESC LIMIT ?',
    [satGid, limit],
  ) as unknown as ReferralRow[];
}

export async function referralsForHub(hubGid: string, limit = 50): Promise<ReferralRow[]> {
  return await D.all(
    `SELECT r.* FROM referrals r
     LEFT JOIN satellites s ON s.guild_id = r.satellite_guild_id
     LEFT JOIN user_profiles up ON up.user_id = r.referred_by
     WHERE s.hub_guild_id = ? OR up.hub_guild_id = ?
     ORDER BY r.id DESC LIMIT ?`,
    [hubGid, hubGid, limit],
  ) as unknown as ReferralRow[];
}

// ---------- coin discovery watchlist ----------

export interface WatchRow {
  id: number;
  added_by: string;
  coin_id: string;
  symbol: string | null;
  name: string | null;
  discord_url: string | null;
  status: 'new' | 'contacted' | 'joined' | 'rejected';
  notes: string | null;
  guild_id: string | null;
  invite_code: string | null;
  created_at: number;
}

export async function addWatch(addedBy: string, coinId: string, symbol: string | null, name: string | null, discordUrl: string | null): Promise<number> {
  const res = await D.run(
    'INSERT INTO watchlist (added_by, coin_id, symbol, name, discord_url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [addedBy, coinId, symbol, name, discordUrl, Date.now()],
  );
  return res.lastId;
}

/** Watchlist entry for a manually-added coin *server* (no CoinGecko coin). */
export async function addWatchGuild(
  addedBy: string, guildId: string, name: string, inviteCode: string, discordUrl: string,
): Promise<number> {
  const res = await D.run(
    'INSERT INTO watchlist (added_by, coin_id, name, discord_url, guild_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [addedBy, `server:${guildId}`, name.slice(0, 80), discordUrl.slice(0, 200), guildId, inviteCode, Date.now()],
  );
  return res.lastId;
}

export async function findWatchByGuild(guildId: string): Promise<WatchRow | undefined> {
  return await D.get('SELECT * FROM watchlist WHERE guild_id = ? ORDER BY id DESC LIMIT 1', [guildId]) as WatchRow | undefined;
}

export async function getWatch(id: number): Promise<WatchRow | undefined> {
  return await D.get('SELECT * FROM watchlist WHERE id = ?', [id]) as WatchRow | undefined;
}

// userId = filter to entries that user added; undefined = all (godmode)
export async function listWatch(userId?: string): Promise<WatchRow[]> {
  if (userId) {
    return await D.all('SELECT * FROM watchlist WHERE added_by = ? ORDER BY id DESC LIMIT 200', [userId]) as unknown as WatchRow[];
  }
  return await D.all('SELECT * FROM watchlist ORDER BY id DESC LIMIT 200', []) as unknown as WatchRow[];
}

export async function updateWatch(id: number, patch: { status?: string; notes?: string; discord_url?: string }): Promise<boolean> {
  const keys = Object.keys(patch);
  if (!keys.length) return true;
  const set = keys.map((k) => `${k} = ?`).join(', ');
  const res = await D.run(`UPDATE watchlist SET ${set} WHERE id = ?`, [...keys.map((k) => (patch as Record<string, unknown>)[k]), id]);
  return Number(res.changes) > 0;
}

export async function removeWatch(id: number): Promise<boolean> {
  return Number((await D.run('DELETE FROM watchlist WHERE id = ?', [id])).changes) > 0;
}
