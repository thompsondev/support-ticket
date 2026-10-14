import 'dotenv/config';

export const env = {
  token: process.env.DISCORD_TOKEN ?? '',
  clientId: process.env.CLIENT_ID ?? '',
  guildId: process.env.GUILD_ID ?? '',
  // dashboard (optional — bot works without these)
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET ?? '',
  sessionSecret: process.env.SESSION_SECRET ?? '',
  dashboardUrl: process.env.DASHBOARD_URL ?? 'http://localhost:3000',
  dashboardPort: Number(process.env.DASHBOARD_PORT ?? 3000),
  // Postgres connection — when set, replaces the local sqlite database.
  // DATABASE_URL_POOLED (e.g. Neon -pooler endpoint) is preferred at runtime
  // when present; DATABASE_URL remains the direct/migration connection.
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseUrlPooled: process.env.DATABASE_URL_POOLED ?? '',
  // AI gateway (OpenAI-compatible endpoint — e.g. Neon AI Gateway). Optional:
  // powers the satellite auto-responder intent detection and ticket triage.
  aiGatewayUrl: process.env.NEON_AI_GATEWAY_BASE_URL ?? '',
  aiGatewayToken: process.env.NEON_AI_GATEWAY_TOKEN ?? '',
  aiModel: process.env.AI_MODEL ?? 'gpt-4o-mini',
  // support hub guild — where referred users land. Enables the landing-page
  // "Get Support" one-click join (requires the guilds.join OAuth scope).
  hubGuildId: process.env.HUB_GUILD_ID ?? '',
  // godmode — comma-separated Discord user IDs of bot owners
  ownerIds: (process.env.OWNER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export function validateEnv(): void {
  const missing: string[] = [];
  if (!env.token) missing.push('DISCORD_TOKEN');
  if (!env.clientId) missing.push('CLIENT_ID');
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill in your bot credentials.');
    process.exit(1);
  }
}
