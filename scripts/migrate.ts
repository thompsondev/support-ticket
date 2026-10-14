// One-shot migration: copy all data from the local SQLite file to Postgres.
//
//   DATABASE_URL="postgresql://..." npm run db:migrate
//
// Idempotent — rows are inserted with ON CONFLICT DO NOTHING, so reruns skip
// existing rows. Serial sequences are synced afterwards so new inserts don't
// collide with imported ids.
import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import pg from 'pg';

const SQLITE_PATH = process.env.SQLITE_PATH ?? 'data/tickets.db';
const DATABASE_URL = process.env.DATABASE_URL ?? '';

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (target Postgres connection).');
  process.exit(1);
}
if (!existsSync(SQLITE_PATH)) {
  console.error(`SQLite file not found: ${SQLITE_PATH} — nothing to migrate.`);
  process.exit(1);
}

// every table in the app schema, in dependency-friendly order
const TABLES = [
  'guild_config',
  'ticket_types',
  'tickets',
  'notes',
  'ratings',
  'links',
  'blacklist',
  'cooldowns',
  'tags',
  'suggestions',
  'votes',
  'polls',
  'warnings',
  'global_blacklist',
  'reminders',
  'giveaways',
  'giveaway_entries',
  'sticky',
  'reaction_roles',
  'afk',
  'automod_rules',
  'custom_commands',
  'form_fields',
  'sessions',
  'audit_log',
  'starboard',
  'temp_voice',
];

// tables with a serial id column whose sequence must be synced after import
const SERIAL_TABLES = [
  'tickets',
  'notes',
  'ratings',
  'links',
  'suggestions',
  'polls',
  'warnings',
  'reminders',
  'giveaways',
  'form_fields',
  'audit_log',
];

const sqlite = new DatabaseSync(SQLITE_PATH);
const pool = new pg.Pool({
  connectionString: DATABASE_URL.replace(/channel_binding=[^&]*&?/, ''),
  max: 2,
});
pg.types.setTypeParser(20, (v: string | null) => (v === null ? v : Number(v)));

function placeholders(n: number, offset = 0): string {
  return Array.from({ length: n }, (_, i) => `$${offset + i + 1}`).join(', ');
}

async function main(): Promise<void> {
  // importing the app db layer runs schema creation/migrations on the target
  const { dbRun } = await import('../src/db');
  await dbRun('SELECT 1', []);
  const client = await pool.connect();
  try {
    for (const table of TABLES) {
      let rows: Record<string, unknown>[];
      try {
        rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      } catch {
        console.log(`- ${table}: table missing in sqlite, skipped`);
        continue;
      }
      if (!rows.length) {
        console.log(`- ${table}: 0 rows`);
        continue;
      }
      let inserted = 0;
      for (const row of rows) {
        const cols = Object.keys(row);
        const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders(cols.length)}) ON CONFLICT DO NOTHING`;
        const res = await client.query(sql, cols.map((c) => row[c]));
        inserted += res.rowCount ?? 0;
      }
      console.log(`+ ${table}: ${inserted}/${rows.length} rows migrated`);
    }

    for (const table of SERIAL_TABLES) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`,
        [table],
      );
    }
    console.log('sequences synced');
    console.log('Migration complete.');
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
