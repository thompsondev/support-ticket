import express, { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType, Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { env } from './env';
import {
  addFormField,
  addLink,
  addTicketType,
  allGiveaways,
  avgRating,
  bindReactionRole,
  blacklistAdd,
  blacklistList,
  blacklistRemove,
  dbAll,
  dbGet,
  dbRun,
  deleteAutomodRuleById,
  fleetStats,
  getConfig,
  getFormFields,
  getGiveaway,
  getLinks,
  getSticky,
  getSuggestions,
  addWatch,
  addWatchGuild,
  findWatchByGuild,
  getAuditLog,
  getSatellite,
  getUserProfile,
  getWatch,
  logAudit,
  getTags,
  getTicketTypes,
  giveawayEntryCount,
  globalBlacklistAdd,
  globalBlacklistList,
  globalBlacklistRemove,
  insertGiveaway,
  listCustomCommands,
  listReactionRoles,
  listSatellites,
  listStickies,
  listTickets,
  listWatch,
  referralsForGuild,
  referralsForHub,
  removeCustomCommand,
  removeFormField,
  removeLink,
  removeSatellite,
  removeSticky,
  removeTag,
  removeTicketType,
  removeWatch,
  saveConfig,
  setCustomCommand,
  setGiveawayMessage,
  setSatellite,
  setSticky,
  setUserProfile,
  setTag,
  unbindReactionRole,
  updateSatellite,
  updateSticky,
  updateTicketType,
  updateWatch,
  type GuildConfig,
} from './db';
import { endGiveaway, giveawayMessage } from './giveaways';
import { parseEmoji } from './commands/reactionrole';
import { COLORS } from './util';
import { panelMessage, type PanelStyle } from './panel';

const DISCORD_API = 'https://discord.com/api/v10';
const MANAGE_GUILD = 0x20n;

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string;
  avatar?: string;
}

interface DiscordGuild {
  id: string;
  name: string;
  icon?: string;
  owner: boolean;
  permissions: string;
}

declare module 'express-session' {
  interface SessionData {
    user?: DiscordUser;
    guilds?: DiscordGuild[];
    oauthState?: string;
    csrf?: string;
    accessToken?: string;
    pendingJoin?: string;
    // every Discord account authorized into this session — `user`/`guilds`/
    // `accessToken` are always the snapshot of the ACTIVE one
    accounts?: { id: string; username: string; avatar: string; accessToken: string }[];
  }
}

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const TRANSCRIPTS_DIR = fileURLToPath(new URL('../transcripts', import.meta.url));

// ---------- sqlite-backed session store (sessions survive restarts) ----------

interface SessionRow {
  sess: string;
  expires_at: number;
}

class SqliteSessionStore extends session.Store {
  get(sid: string, cb: (err?: unknown, sess?: session.SessionData | null) => void): void {
    dbGet<SessionRow>('SELECT sess, expires_at FROM sessions WHERE sid = ?', [sid])
      .then(async (row) => {
        if (!row) return cb(null, null);
        if (row.expires_at < Date.now()) {
          await dbRun('DELETE FROM sessions WHERE sid = ?', [sid]);
          return cb(null, null);
        }
        cb(null, JSON.parse(row.sess) as session.SessionData);
      })
      .catch((err) => cb(err));
  }

  set(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    const maxAge = (sess.cookie?.maxAge as number | undefined) ?? 24 * 3_600_000;
    dbRun('INSERT OR REPLACE INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)', [
      sid,
      JSON.stringify(sess),
      Date.now() + maxAge,
    ])
      .then(() => cb?.())
      .catch((err) => cb?.(err));
  }

  destroy(sid: string, cb?: (err?: unknown) => void): void {
    dbRun('DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => cb?.())
      .catch((err) => cb?.(err));
  }

  touch(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    this.set(sid, sess, cb);
  }
}

// ---------- simple in-memory rate limiter ----------

function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, 60_000);
  timer.unref();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const h = hits.get(key) ?? { n: 0, reset: now + windowMs };
    if (now > h.reset) {
      h.n = 0;
      h.reset = now + windowMs;
    }
    h.n += 1;
    hits.set(key, h);
    if (h.n > limit) return res.status(429).json({ error: 'rate_limited', retry_after_ms: h.reset - now });
    next();
  };
}

export function startWeb(client: Client): void {
  if (!env.oauthClientSecret) {
    console.log('Dashboard disabled — set OAUTH_CLIENT_SECRET and SESSION_SECRET in .env to enable it.');
    return;
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // purge expired sessions every 10 min
  const purge = setInterval(() => {
    dbRun('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]).catch(() => {});
  }, 600_000);
  purge.unref();

  app.use(
    session({
      store: new SqliteSessionStore(),
      secret: env.sessionSecret || randomBytes(32).toString('hex'),
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 24 * 3_600_000, sameSite: 'lax' },
    }),
  );

  // rate limits: 120 req/min on the API, 20 req/min on auth endpoints
  app.use('/api', rateLimit(120, 60_000));
  app.use('/auth', rateLimit(20, 60_000));

  // CSRF: every mutating API call must echo the session token
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!req.session.user) return next(); // unauthenticated mutating calls fail at `authed` anyway
    if (req.headers['x-csrf-token'] !== req.session.csrf) {
      return res.status(403).json({ error: 'bad_csrf' });
    }
    next();
  });
  app.use(express.static(PUBLIC_DIR, { index: false }));
  app.get('/', async (_req: Request, res) => res.sendFile('landing.html', { root: PUBLIC_DIR }));
  app.get('/dashboard', async (_req: Request, res) => res.sendFile('index.html', { root: PUBLIC_DIR }));

  // public info for the landing page (no auth)
  app.get('/api/public', async (_req: Request, res) =>
    res.json({ clientId: env.clientId, hubGuildId: env.hubGuildId || null }),
  );

  const redirectUri = `${env.dashboardUrl}/auth/callback`;

  // ---------- auth ----------

  app.get('/auth/discord', async (req: Request, res) => {
    const state = randomBytes(16).toString('hex');
    req.session.oauthState = state;
    if (req.query.join === '1' && env.hubGuildId) req.session.pendingJoin = env.hubGuildId;
    const url = new URL('https://discord.com/oauth2/authorize');
    const params: Record<string, string> = {
      client_id: env.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify guilds guilds.join',
      state,
    };
    // ?add=1 → force the authorize screen so the user can pick ANOTHER Discord account
    if (req.query.add === '1') params.prompt = 'consent';
    url.search = new URLSearchParams(params).toString();
    res.redirect(url.toString());
  });

  app.get('/auth/callback', async (req: Request, res) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state || state !== req.session.oauthState) {
      return res.status(400).send('Invalid OAuth state — try logging in again.');
    }
    delete req.session.oauthState;

    try {
      const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.clientId,
          client_secret: env.oauthClientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange: ${tokenRes.status}`);
      const { access_token } = (await tokenRes.json()) as { access_token: string };
      const headers = { Authorization: `Bearer ${access_token}` };

      const [user, guilds] = await Promise.all([
        fetch(`${DISCORD_API}/users/@me`, { headers }).then((r) => r.json() as Promise<DiscordUser>),
        fetch(`${DISCORD_API}/users/@me/guilds`, { headers }).then(
          (r) => r.json() as Promise<DiscordGuild[]>,
        ),
      ]);
      req.session.user = user;
      req.session.guilds = guilds;
      req.session.accessToken = access_token;
      req.session.csrf ??= randomBytes(16).toString('hex');
      // register/update this account in the session's account list
      const acct = { id: user.id, username: user.username, avatar: user.avatar ?? '', accessToken: access_token };
      const accts = (req.session.accounts ??= []);
      const idx = accts.findIndex((a) => a.id === acct.id);
      if (idx >= 0) accts[idx] = acct;
      else accts.push(acct);

      // one-click join: "Get Support" on the landing page drops the user into
      // the hub guild via guilds.join right after they authorize.
      const pending = req.session.pendingJoin;
      delete req.session.pendingJoin;
      if (pending && user?.id) {
        await fetch(`${DISCORD_API}/guilds/${pending}/members/${user.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bot ${env.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token }),
        }).catch(() => {});
      }
      res.redirect('/dashboard');
    } catch (err) {
      console.error('OAuth callback failed:', err);
      res.status(500).send('Discord login failed — check OAUTH_CLIENT_SECRET and redirect URI.');
    }
  });

  app.get('/auth/logout', async (req: Request, res) => {
    req.session.destroy(() => res.redirect('/'));
  });

  // ---------- guards ----------

  const authed = (req: Request, res: Response, next: NextFunction) =>
    req.session.user ? next() : res.status(401).json({ error: 'not_authenticated' });

  const isOwnerReq = (req: Request): boolean =>
    !!req.session.user && env.ownerIds.includes(req.session.user.id);

  const canManage = (req: Request, gid: string): boolean => {
    const g = req.session.guilds?.find((x) => x.id === gid);
    return !!g && (g.owner || !!(BigInt(g.permissions) & MANAGE_GUILD));
  };

  const guildAccess = async (req: Request, res: Response, next: NextFunction) => {
    const gid = req.params.gid as string;
    if (!isOwnerReq(req) && !canManage(req, gid)) {
      return res.status(403).json({ error: 'missing_manage_guild' });
    }
    if (!client.guilds.cache.has(gid)) {
      return res.status(404).json({ error: 'bot_not_in_guild', hint: 'Invite the bot first.' });
    }
    next();
  };

  const ownerOnly = (req: Request, res: Response, next: NextFunction) =>
    isOwnerReq(req) ? next() : res.status(403).json({ error: 'owner_only' });

  // ---------- api ----------

  app.get('/api/me', authed, async (req: Request, res) => {
    const owner = isOwnerReq(req);
    const seen = new Set<string>();
    const guilds: { id: string; name: string; icon?: string; hasBot: boolean; memberCount?: number; disabled: boolean }[] = [];

    // owners (godmode) see every guild the bot serves
    if (owner) {
      for (const g of client.guilds.cache.values()) {
        seen.add(g.id);
        guilds.push({
          id: g.id,
          name: g.name,
          icon: g.icon ?? undefined,
          hasBot: true,
          memberCount: g.memberCount,
          disabled: !!(await getConfig(g.id)).disabled,
        });
      }
    }
    for (const g of (req.session.guilds ?? []).filter((x) => canManage(req, x.id))) {
      if (seen.has(g.id)) continue;
      guilds.push({
        id: g.id,
        name: g.name,
        icon: g.icon,
        hasBot: client.guilds.cache.has(g.id),
        memberCount: client.guilds.cache.get(g.id)?.memberCount,
        disabled: client.guilds.cache.has(g.id) ? !!(await getConfig(g.id)).disabled : false,
      });
    }
    res.json({
      user: req.session.user,
      guilds,
      // every bot-installed guild the user is a MEMBER of (manage not required)
      // — used for the personal "My support hub" picker so support staff can
      // route referrals without holding Manage Server
      hubGuilds: (req.session.guilds ?? [])
        .filter((g) => client.guilds.cache.has(g.id))
        .map((g) => ({ id: g.id, name: g.name, icon: g.icon })),
      clientId: env.clientId,
      isOwner: owner,
      csrf: req.session.csrf,
      accounts: (req.session.accounts ?? []).map(({ id, username, avatar }) => ({ id, username, avatar })),
    });
  });

  // ---------- per-user support hub ("Route to Support" destination) ----------

  app.get('/api/me/hub', authed, async (req, res) => {
    const p = await getUserProfile(req.session.user!.id);
    const g = p?.hub_guild_id ? client.guilds.cache.get(p.hub_guild_id) : undefined;
    res.json({
      hub_guild_id: p?.hub_guild_id ?? null,
      hub_invite: p?.hub_invite ?? null,
      hub_name: g?.name ?? null,
      platform_default: env.hubInvite || null,
    });
  });

  app.put('/api/me/hub', authed, async (req, res) => {
    const gid = (req.body?.hub_guild_id ?? '').trim() || null;
    let invite = (req.body?.hub_invite ?? '').trim() || null;
    if (invite && !/^https?:\/\/(www\.)?(discord\.gg|discord\.com\/invite)\/\S+$/i.test(invite)) {
      return res.status(400).json({ error: 'invalid_invite' });
    }
    if (gid) {
      // any member of a bot-installed guild may point their personal hub at
      // it — referral attribution doesn't grant them any control over it
      if (!isOwnerReq(req) && !req.session.guilds?.some((g) => g.id === gid)) {
        return res.status(403).json({ error: 'not_a_member' });
      }
      if (!client.guilds.cache.has(gid)) {
        return res.status(404).json({ error: 'bot_not_in_guild', hint: 'Invite the bot there first.' });
      }
      // auto-mint an invite when the user only picked a guild
      if (!invite) {
        const g = client.guilds.cache.get(gid)!;
        const chan =
          g.systemChannel ??
          g.channels.cache.find(
            (c) =>
              c.type === ChannelType.GuildText &&
              c.permissionsFor(g.members.me!)?.has(PermissionFlagsBits.CreateInstantInvite),
          );
        const inv = chan && 'createInvite' in chan
          ? await chan.createInvite({ maxAge: 0, maxUses: 0, reason: 'user hub invite' }).catch(() => null)
          : null;
        if (!inv) {
          return res.status(400).json({ error: 'no_invite_channel', hint: 'Paste an invite URL manually.' });
        }
        invite = inv.url;
      }
    }
    if (!gid && !invite) return res.status(400).json({ error: 'nothing_to_save' });
    await setUserProfile(req.session.user!.id, gid, invite);
    res.json({ ok: true, hub_guild_id: gid, hub_invite: invite });
  });

  // post the caller's hub invite into a channel of a bot-installed guild they manage
  app.post('/api/guilds/:gid/post-invite', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const p = await getUserProfile(req.session.user!.id);
    const invite = p?.hub_invite || env.hubInvite;
    if (!invite) {
      return res.status(400).json({ error: 'no_hub', hint: 'Set your support hub first (Discover → My support hub).' });
    }
    const channelId = req.body?.channel_id;
    const ch = await client.guilds.cache
      .get(gid)
      ?.channels.fetch(String(channelId ?? ''))
      .catch(() => null);
    if (!ch?.isSendable() || ch.isDMBased()) {
      return res.status(400).json({ error: 'invalid_channel' });
    }
    await ch.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🎫 Need help? Join our support hub')
          .setColor(0x5865f2)
          .setDescription(`Open a ticket and our team will help you:\n👉 ${invite}`),
      ],
    });
    res.json({ ok: true });
  });

  // switch the session's active Discord identity to a previously-authorized account
  app.post('/api/accounts/switch', authed, async (req, res) => {
    const { accountId } = req.body ?? {};
    const acct = (req.session.accounts ?? []).find((a) => a.id === accountId);
    if (!acct) return res.status(404).json({ error: 'account_not_found' });
    const headers = { Authorization: `Bearer ${acct.accessToken}` };
    const [user, guilds] = await Promise.all([
      fetch(`${DISCORD_API}/users/@me`, { headers }).then((r) => r.json() as Promise<DiscordUser>),
      fetch(`${DISCORD_API}/users/@me/guilds`, { headers }).then((r) => r.json() as Promise<DiscordGuild[]>),
    ]);
    if (!user?.id) return res.status(502).json({ error: 'token_expired' });
    req.session.user = user;
    req.session.guilds = guilds;
    req.session.accessToken = acct.accessToken;
    res.json({ ok: true, user: { id: user.id, username: user.username } });
  });

  // ---------- godmode (owner) ----------

  app.get('/api/admin/fleet', authed, ownerOnly, async (_req, res) => {
    const stats = new Map((await fleetStats()).map((f) => [f.guild_id, f]));
    const fleet = await Promise.all(
      client.guilds.cache.map(async (g) => {
        const s = stats.get(g.id);
        return {
          id: g.id,
          name: g.name,
          icon: g.icon,
          memberCount: g.memberCount,
          disabled: s ? !!s.disabled : !!(await getConfig(g.id)).disabled,
          openTickets: s?.open_tickets ?? 0,
          totalTickets: s?.total_tickets ?? 0,
          typeCount: s?.type_count ?? 0,
        };
      }),
    );
    res.json({
      totalGuilds: fleet.length,
      totalOpenTickets: fleet.reduce((a, g) => a + g.openTickets, 0),
      totalTickets: fleet.reduce((a, g) => a + g.totalTickets, 0),
      totalMembers: fleet.reduce((a, g) => a + g.memberCount, 0),
      guilds: fleet,
    });
  });

  app.get('/api/admin/blacklist', authed, ownerOnly, async (_req, res) => {
    res.json(await globalBlacklistList());
  });

  app.post('/api/admin/blacklist', authed, ownerOnly, async (req, res) => {
    const { user_id, reason } = req.body ?? {};
    if (typeof user_id !== 'string' || !/^\d{17,20}$/.test(user_id)) {
      return res.status(400).json({ error: 'invalid_user_id' });
    }
    await globalBlacklistAdd(user_id, typeof reason === 'string' ? reason.slice(0, 300) : null);
    await logAudit(req.session.user!.id, 'global_blacklist_add', null, `${user_id} — ${reason ?? 'no reason'}`);
    res.json({ ok: true });
  });

  app.delete('/api/admin/blacklist/:uid', authed, ownerOnly, async (req, res) => {
    res.json({ ok: await globalBlacklistRemove(req.params.uid as string) });
    await logAudit(req.session.user!.id, 'global_blacklist_remove', null, req.params.uid as string);
  });

  app.post('/api/guilds/:gid/disable', authed, ownerOnly, async (req, res) => {
    const gid = req.params.gid as string;
    if (!client.guilds.cache.has(gid)) return res.status(404).json({ error: 'bot_not_in_guild' });
    await saveConfig(gid, { disabled: 1 });
    await logAudit(req.session.user!.id, 'guild_disable', gid, client.guilds.cache.get(gid)?.name);
    res.json({ ok: true });
  });

  app.post('/api/guilds/:gid/enable', authed, ownerOnly, async (req, res) => {
    const gid = req.params.gid as string;
    if (!client.guilds.cache.has(gid)) return res.status(404).json({ error: 'bot_not_in_guild' });
    await saveConfig(gid, { disabled: 0 });
    await logAudit(req.session.user!.id, 'guild_enable', gid, client.guilds.cache.get(gid)?.name);
    res.json({ ok: true });
  });

  app.post('/api/guilds/:gid/leave', authed, ownerOnly, async (req, res) => {
    const gid = req.params.gid as string;
    const guild = client.guilds.cache.get(gid);
    if (!guild) return res.status(404).json({ error: 'bot_not_in_guild' });
    await guild.leave();
    await logAudit(req.session.user!.id, 'guild_leave', gid, guild.name);
    res.json({ ok: true });
  });

  app.get('/api/guilds/:gid/overview', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const counts = await dbAll<{ status: string; c: number }>(
      'SELECT status, COUNT(*) AS c FROM tickets WHERE guild_id = ? GROUP BY status',
      [gid],
    );
    res.json({
      config: await getConfig(gid),
      types: await getTicketTypes(gid),
      links: await getLinks(gid),
      counts: Object.fromEntries(counts.map((r) => [r.status, r.c])),
      avgRating: await avgRating(gid),
    });
  });

  app.get('/api/guilds/:gid/resources', authed, guildAccess, async (req, res) => {
    const guild = await client.guilds.fetch(req.params.gid as string);
    const channels = (await guild.channels.fetch())
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({ id: c.id, name: c.name, type: c.type }));
    res.json({
      roles: guild.roles.cache
        .filter((r) => r.id !== guild.roles.everyone.id)
        .map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
      textChannels: channels.filter((c) => c.type === 0),
      voiceChannels: channels.filter((c) => c.type === 2),
      categories: channels.filter((c) => c.type === 4),
    });
  });

  app.patch('/api/guilds/:gid/config', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const b = req.body ?? {};
    const patch: Partial<GuildConfig> = {};
    const str = (v: unknown) => (typeof v === 'string' && /^\d{17,20}$/.test(v) ? v : v === null ? null : undefined);
    for (const k of [
      'support_role_id', 'admin_role_id', 'log_channel_id',
      'transcript_channel_id', 'open_category_id', 'closed_category_id',
      'welcome_channel_id', 'suggestions_channel_id', 'autorole_id',
      'starboard_channel_id', 'voice_hub_channel_id',
    ] as const) {
      const v = str(b[k]);
      if (v !== undefined) patch[k] = v;
    }
    const num = (v: unknown, min: number, max: number) =>
      Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : undefined;
    const ints: [keyof GuildConfig, number, number][] = [
      ['max_tickets', 1, 10],
      ['cooldown_seconds', 0, 86400],
      ['autoclose_hours', 0, 168],
      ['escalation_minutes', 0, 10080],
      ['starboard_threshold', 0, 50],
      ['welcome_card', 0, 1],
    ];
    for (const [k, min, max] of ints) {
      const v = num(b[k], min, max);
      if (v !== undefined) (patch as Record<string, number>)[k] = v;
    }
    for (const k of ['panel_title', 'panel_description', 'welcome_message'] as const) {
      if (typeof b[k] === 'string' || b[k] === null) patch[k] = b[k]?.slice(0, 1000) ?? null;
    }
    await saveConfig(gid, patch);
    await logAudit(req.session.user!.id, 'config_update', gid, Object.keys(patch).join(','));
    res.json({ ok: true, config: await getConfig(gid) });
  });

  const TYPE_ID_RE = /^[a-z0-9-]{1,32}$/;

  const validCategory = async (gid: string, v: unknown): Promise<string | null | 'invalid'> => {
    if (v === null || v === '') return null;
    if (typeof v !== 'string' || !/^\d{17,20}$/.test(v)) return 'invalid';
    const ch = await client.guilds.cache.get(gid)?.channels.fetch(v).catch(() => null);
    return ch?.type === ChannelType.GuildCategory ? v : 'invalid';
  };

  app.post('/api/guilds/:gid/types', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const { id, label, emoji, description, category_id, instant, button_style } = req.body ?? {};
    if (!TYPE_ID_RE.test(String(id)) || typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ error: 'invalid_type' });
    }
    if ((await getTicketTypes(gid)).length >= 25) return res.status(400).json({ error: 'max_types' });
    const cat = category_id === undefined ? null : await validCategory(gid, category_id);
    if (cat === 'invalid') return res.status(400).json({ error: 'invalid_category' });
    const ok = await addTicketType(gid, {
      type_id: id,
      label: label.slice(0, 100),
      emoji: typeof emoji === 'string' ? emoji.slice(0, 64) : null,
      description: typeof description === 'string' ? description.slice(0, 100) : null,
      category_id: cat,
      instant: typeof instant === 'boolean' ? (instant ? 1 : 0) : undefined,
      button_style: ['primary', 'secondary', 'success', 'danger'].includes(button_style)
        ? button_style
        : null,
    });
    if (ok) await logAudit(req.session.user!.id, 'type_add', req.params.gid as string, String(id));
    res.status(ok ? 200 : 409).json({ ok, error: ok ? undefined : 'exists' });
  });

  app.patch('/api/guilds/:gid/types/:typeId', authed, guildAccess, async (req, res) => {
    const { label, emoji, description, category_id, instant, button_style } = req.body ?? {};
    const patch: Record<string, string | number | null> = {};
    if (typeof label === 'string') patch.label = label.slice(0, 100);
    if (typeof instant === 'boolean') patch.instant = instant ? 1 : 0;
    if (button_style !== undefined) {
      patch.button_style = ['primary', 'secondary', 'success', 'danger'].includes(button_style)
        ? button_style
        : null;
    }
    if (typeof emoji === 'string' || emoji === null) patch.emoji = emoji?.slice(0, 64) ?? null;
    if (typeof description === 'string' || description === null) {
      patch.description = description?.slice(0, 100) ?? null;
    }
    if (category_id !== undefined) {
      const cat = await validCategory(req.params.gid as string, category_id);
      if (cat === 'invalid') return res.status(400).json({ error: 'invalid_category' });
      patch.category_id = cat;
    }
    res.json({ ok: await updateTicketType(req.params.gid as string, req.params.typeId as string, patch) });
  });

  app.delete('/api/guilds/:gid/types/:typeId', authed, guildAccess, async (req, res) => {
    res.json({ ok: await removeTicketType(req.params.gid as string, req.params.typeId as string) });
    await logAudit(req.session.user!.id, 'type_remove', req.params.gid as string, req.params.typeId as string);
  });

  app.post('/api/guilds/:gid/links', authed, guildAccess, async (req, res) => {
    const { label, url, description } = req.body ?? {};
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      return res.status(400).json({ error: 'invalid_url' });
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ error: 'invalid_link' });
    }
    const ok = await addLink(
      req.params.gid as string,
      label.slice(0, 80),
      url,
      typeof description === 'string' ? description.slice(0, 200) : null,
    );
    res.status(ok ? 200 : 409).json({ ok });
  });

  app.delete('/api/guilds/:gid/links/:label', authed, guildAccess, async (req, res) => {
    res.json({ ok: await removeLink(req.params.gid as string, req.params.label as string) });
  });

  app.get('/api/guilds/:gid/tickets', authed, guildAccess, async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(await listTickets(req.params.gid as string, status, undefined, limit));
  });

  const TAG_NAME_RE = /^[a-z0-9-_]{1,32}$/;

  app.get('/api/guilds/:gid/tags', authed, guildAccess, async (req, res) => {
    res.json(await getTags(req.params.gid as string));
  });

  app.post('/api/guilds/:gid/tags', authed, guildAccess, async (req, res) => {
    const { name, content } = req.body ?? {};
    const n = String(name ?? '').toLowerCase();
    if (!TAG_NAME_RE.test(n) || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'invalid_tag' });
    }
    await setTag(req.params.gid as string, n, content.slice(0, 2000));
    res.json({ ok: true });
  });

  app.delete('/api/guilds/:gid/tags/:name', authed, guildAccess, async (req, res) => {
    res.json({ ok: await removeTag(req.params.gid as string, req.params.name as string) });
  });

  app.get('/api/guilds/:gid/suggestions', authed, guildAccess, async (req, res) => {
    res.json(await getSuggestions(req.params.gid as string, 50));
  });

  app.get('/api/guilds/:gid/blacklist', authed, guildAccess, async (req, res) => {
    res.json(await blacklistList(req.params.gid as string));
  });

  app.post('/api/guilds/:gid/blacklist', authed, guildAccess, async (req, res) => {
    const { user_id, reason } = req.body ?? {};
    if (typeof user_id !== 'string' || !/^\d{17,20}$/.test(user_id)) {
      return res.status(400).json({ error: 'invalid_user_id' });
    }
    await blacklistAdd(req.params.gid as string, user_id, typeof reason === 'string' ? reason.slice(0, 300) : null);
    await logAudit(req.session.user!.id, 'blacklist_add', req.params.gid as string, `${user_id} — ${reason ?? 'no reason'}`);
    res.json({ ok: true });
  });

  app.delete('/api/guilds/:gid/blacklist/:uid', authed, guildAccess, async (req, res) => {
    res.json({ ok: await blacklistRemove(req.params.gid as string, req.params.uid as string) });
    await logAudit(req.session.user!.id, 'blacklist_remove', req.params.gid as string, req.params.uid as string);
  });

  app.post('/api/guilds/:gid/panel', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const { channelId, style } = req.body ?? {};
    if (!(await getTicketTypes(gid)).length) return res.status(400).json({ error: 'no_types' });
    const channel = await client.channels.fetch(String(channelId)).catch(() => null);
    if (!channel?.isSendable() || channel.isDMBased() || channel.guildId !== gid) {
      return res.status(400).json({ error: 'invalid_channel' });
    }
    await channel.send(await panelMessage(gid, { style: (style as PanelStyle) || 'select' }));
    res.json({ ok: true });
  });

  app.post('/api/guilds/:gid/bootstrap', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const guild = await client.guilds.fetch(gid);
    const cfg = await getConfig(gid);
    const everyone = guild.roles.everyone.id;
    const deny = [{ id: everyone, deny: [PermissionFlagsBits.ViewChannel] }];

    const result: Record<string, string> = {};
    if (!cfg.open_category_id || !guild.channels.cache.has(cfg.open_category_id)) {
      const cat = await guild.channels.create({
        name: '🎫 Tickets',
        type: ChannelType.GuildCategory,
        permissionOverwrites: deny,
      });
      result.open_category_id = cat.id;
      await saveConfig(gid, { open_category_id: cat.id });
    }
    if (!cfg.closed_category_id || !guild.channels.cache.has(cfg.closed_category_id)) {
      const cat = await guild.channels.create({
        name: 'Closed Tickets',
        type: ChannelType.GuildCategory,
        permissionOverwrites: deny,
      });
      result.closed_category_id = cat.id;
      await saveConfig(gid, { closed_category_id: cat.id });
    }
    res.json({ ok: true, created: result, config: await getConfig(gid) });
  });

  // ---------- giveaways ----------

  app.get('/api/guilds/:gid/giveaways', authed, guildAccess, async (req, res) => {
    res.json(
      await Promise.all(
        (await allGiveaways(req.params.gid as string)).map(async (g) => ({
          ...g,
          entries: await giveawayEntryCount(g.id),
        })),
      ),
    );
  });

  app.post('/api/guilds/:gid/giveaways', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const { prize, minutes, winners, channelId } = req.body ?? {};
    const ms = Number(minutes) * 60_000;
    if (typeof prize !== 'string' || !prize.trim() || !Number.isFinite(ms) || ms < 30_000 || ms > 30 * 86_400_000) {
      return res.status(400).json({ error: 'invalid_giveaway' });
    }
    const channel = await client.channels.fetch(String(channelId)).catch(() => null);
    if (!channel?.isSendable() || channel.isDMBased() || channel.guildId !== gid) {
      return res.status(400).json({ error: 'invalid_channel' });
    }
    const userId = req.session.user!.id;
    const endsAt = Date.now() + ms;
    const wc = Math.min(Math.max(Number(winners) || 1, 1), 20);
    const id = await insertGiveaway({
      guild_id: gid,
      host_id: userId,
      prize: prize.slice(0, 200),
      winner_count: wc,
      ends_at: endsAt,
    });
    const msg = await channel.send(
      await giveawayMessage({
        id, guild_id: gid, channel_id: channel.id, message_id: null, host_id: userId,
        prize: prize.slice(0, 200), winner_count: wc, ends_at: endsAt, closed: 0, created_at: Date.now(),
      }),
    );
    await setGiveawayMessage(id, channel.id, msg.id);
    res.json({ ok: true, id });
  });

  app.post('/api/guilds/:gid/giveaways/:id/end', authed, guildAccess, async (req, res) => {
    const g = await getGiveaway(Number(req.params.id));
    if (!g || g.guild_id !== (req.params.gid as string)) return res.status(404).json({ error: 'not_found' });
    if (g.closed) return res.json({ ok: true, winners: [] });
    const winners = await endGiveaway(client, g);
    res.json({ ok: true, winners });
  });

  // ---------- reaction roles ----------

  app.get('/api/guilds/:gid/reactionroles', authed, guildAccess, async (req, res) => {
    res.json(await listReactionRoles(req.params.gid as string));
  });

  app.post('/api/guilds/:gid/reactionroles/panel', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const { channelId, title, description } = req.body ?? {};
    if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'invalid_title' });
    const channel = await client.channels.fetch(String(channelId)).catch(() => null);
    if (!channel?.isSendable() || channel.isDMBased() || channel.guildId !== gid) {
      return res.status(400).json({ error: 'invalid_channel' });
    }
    const msg = await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(title.slice(0, 200))
          .setDescription(typeof description === 'string' && description ? description.slice(0, 1000) : 'React below to get a role.')
          .setColor(COLORS.info),
      ],
    });
    res.json({ ok: true, messageId: msg.id, channelId: channel.id });
  });

  app.post('/api/guilds/:gid/reactionroles', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const { channelId, messageId, emoji, roleId } = req.body ?? {};
    const em = parseEmoji(String(emoji ?? ''));
    if (!em || typeof messageId !== 'string' || typeof roleId !== 'string') {
      return res.status(400).json({ error: 'invalid_binding' });
    }
    const channel = await client.channels.fetch(String(channelId)).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== gid) {
      return res.status(400).json({ error: 'invalid_channel' });
    }
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (!msg) return res.status(400).json({ error: 'message_not_found' });
    await bindReactionRole(gid, channel.id, messageId, em.key, roleId);
    await msg.react(em.react).catch(() => {});
    res.json({ ok: true });
  });

  app.delete('/api/guilds/:gid/reactionroles', authed, guildAccess, async (req, res) => {
    const { messageId, emoji } = req.body ?? {};
    const em = parseEmoji(String(emoji ?? ''));
    if (!em || typeof messageId !== 'string') return res.status(400).json({ error: 'invalid_binding' });
    res.json({ ok: await unbindReactionRole(messageId, em.key) });
  });

  // ---------- sticky ----------

  app.get('/api/guilds/:gid/sticky', authed, guildAccess, async (req, res) => {
    res.json(await listStickies(req.params.gid as string));
  });

  app.post('/api/guilds/:gid/sticky', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const { channelId, content } = req.body ?? {};
    if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'invalid_content' });
    const channel = await client.channels.fetch(String(channelId)).catch(() => null);
    if (!channel?.isSendable() || channel.isDMBased() || channel.guildId !== gid) {
      return res.status(400).json({ error: 'invalid_channel' });
    }
    await setSticky(gid, channel.id, content.slice(0, 1500));
    const msg = await channel.send({
      embeds: [new EmbedBuilder().setDescription(`📌 ${content.slice(0, 1500)}`).setColor(COLORS.warn)],
    });
    await updateSticky(channel.id, msg.id, Date.now());
    res.json({ ok: true });
  });

  app.delete('/api/guilds/:gid/sticky/:channelId', authed, guildAccess, async (req, res) => {
    const st = await getSticky(req.params.channelId as string);
    if (st?.last_message_id) {
      const channel = await client.channels.fetch(st.channel_id).catch(() => null);
      if (channel && !channel.isDMBased() && channel.isTextBased()) {
        await channel.messages.delete(st.last_message_id).catch(() => {});
      }
    }
    res.json({ ok: await removeSticky(req.params.channelId as string) });
  });

  // ---------- automod ----------

  app.get('/api/guilds/:gid/automod', authed, guildAccess, async (req, res) => {
    const guild = await client.guilds.fetch(req.params.gid as string);
    const rules = await guild.autoModerationRules.fetch().catch(() => null);
    res.json(
      rules
        ? rules.map((r) => ({
            id: r.id,
            name: r.name,
            enabled: r.enabled,
            triggerType: r.triggerType,
          }))
        : [],
    );
  });

  app.post('/api/guilds/:gid/automod/:ruleId', authed, guildAccess, async (req, res) => {
    const guild = await client.guilds.fetch(req.params.gid as string);
    const rule = await guild.autoModerationRules.fetch(req.params.ruleId as string).catch(() => null);
    if (!rule) return res.status(404).json({ error: 'rule_not_found' });
    await rule.setEnabled(!!req.body?.enabled).catch(() => {});
    res.json({ ok: true });
  });

  app.delete('/api/guilds/:gid/automod/:ruleId', authed, guildAccess, async (req, res) => {
    const guild = await client.guilds.fetch(req.params.gid as string);
    const rule = await guild.autoModerationRules.fetch(req.params.ruleId as string).catch(() => null);
    if (rule) await rule.delete().catch(() => {});
    await deleteAutomodRuleById(req.params.ruleId as string);
    res.json({ ok: true });
  });

  // ---------- transcripts ----------

  app.get('/api/guilds/:gid/transcripts', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const dir = join(TRANSCRIPTS_DIR, gid);
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.html'));
    } catch {
      return res.json([]);
    }
    const tickets = await listTickets(gid, 'all', undefined, 200);
    const byNumber = new Map(tickets.map((t) => [t.number, t]));
    res.json(
      files
        .map((f) => {
          const num = Number(f.match(/(\d+)\.html$/)?.[1]);
          const t = Number.isFinite(num) ? byNumber.get(num) : undefined;
          return { file: f, number: num, type: t?.type, owner_id: t?.owner_id, status: t?.status };
        })
        .sort((a, b) => b.number - a.number),
    );
  });

  app.get('/api/guilds/:gid/transcripts/:file', authed, guildAccess, async (req, res) => {
    const file = String(req.params.file);
    if (!/^[a-z0-9-]+\.html$/i.test(file)) return res.status(400).json({ error: 'invalid_file' });
    res.sendFile(join(TRANSCRIPTS_DIR, req.params.gid as string, file));
  });

  // ---------- custom commands ----------

  app.get('/api/guilds/:gid/commands', authed, guildAccess, async (req, res) => {
    res.json(await listCustomCommands(req.params.gid as string));
  });

  app.post('/api/guilds/:gid/commands', authed, guildAccess, async (req, res) => {
    const { name, response } = req.body ?? {};
    const n = String(name ?? '').toLowerCase();
    if (!/^[a-z0-9-_]{1,32}$/.test(n) || typeof response !== 'string' || !response.trim()) {
      return res.status(400).json({ error: 'invalid_command' });
    }
    await setCustomCommand(req.params.gid as string, n, response.slice(0, 2000));
    res.json({ ok: true });
  });

  app.delete('/api/guilds/:gid/commands/:name', authed, guildAccess, async (req, res) => {
    res.json({ ok: await removeCustomCommand(req.params.gid as string, req.params.name as string) });
  });

  // ---------- form fields ----------

  app.get('/api/guilds/:gid/types/:typeId/fields', authed, guildAccess, async (req, res) => {
    res.json(await getFormFields(req.params.gid as string, req.params.typeId as string));
  });

  app.post('/api/guilds/:gid/types/:typeId/fields', authed, guildAccess, async (req, res) => {
    const { question, style, required } = req.body ?? {};
    if (typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'invalid_question' });
    }
    const id = await addFormField(
      req.params.gid as string,
      req.params.typeId as string,
      question.slice(0, 45),
      style === 'paragraph' ? 'paragraph' : 'short',
      required !== false,
    );
    if (id === null) return res.status(400).json({ error: 'max_fields' });
    res.json({ ok: true, id });
  });

  app.delete('/api/guilds/:gid/types/:typeId/fields/:fieldId', authed, guildAccess, async (req, res) => {
    res.json({ ok: await removeFormField(Number(req.params.fieldId), req.params.gid as string) });
  });

  // ---------- satellites & referrals ----------

  // satellite view — is THIS guild a satellite, and what it has sent
  app.get('/api/guilds/:gid/satellite', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const sat = await getSatellite(gid);
    res.json({
      satellite: sat ? { ...sat, channels: JSON.parse(sat.channels || '[]') } : null,
      referrals: sat ? await referralsForGuild(gid, 50) : [],
    });
  });

  // create or update the satellite link — `invite` resolves the hub guild via Discord
  app.post('/api/guilds/:gid/satellite', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const { invite, reply, channels, ai_enabled, enabled, rate_limit_minutes } = req.body ?? {};

    if (typeof invite === 'string' && invite.trim()) {
      const code = invite.trim().match(/(?:discord\.gg\/|discord\.com\/invite\/)([\w-]+)/i)?.[1] ?? invite.trim();
      const inv = await client.fetchInvite(code).catch(() => null);
      if (!inv?.guild) return res.status(400).json({ error: 'invalid_invite' });
      if (inv.guild.id === gid) return res.status(400).json({ error: 'self_invite' });
      const existing = await getSatellite(gid);
      await setSatellite(gid, inv.guild.id, `https://discord.gg/${inv.code}`, {
        channels:
          Array.isArray(channels) && channels.every((c) => typeof c === 'string')
            ? channels
            : existing
              ? (JSON.parse(existing.channels || '[]') as string[])
              : [],
        reply_text:
          typeof reply === 'string' && reply.trim() ? reply.slice(0, 500) : (existing?.reply_text ?? null),
        ai_enabled: typeof ai_enabled === 'boolean' ? (ai_enabled ? 1 : 0) : (existing?.ai_enabled ?? 1),
        rate_limit_minutes:
          typeof rate_limit_minutes === 'number'
            ? Math.min(Math.max(Math.round(rate_limit_minutes), 1), 1440)
            : (existing?.rate_limit_minutes ?? 60),
      });
      await logAudit(req.session.user!.id, gid, 'satellite.link', `hub=${inv.guild.id} invite=${inv.code}`);
      return res.json({ ok: true, hub: { id: inv.guild.id, name: inv.guild.name } });
    }

    const sat = await getSatellite(gid);
    if (!sat) return res.status(404).json({ error: 'not_linked' });
    const patch: Parameters<typeof updateSatellite>[1] = {};
    if (typeof reply === 'string') patch.reply_text = reply.trim() ? reply.slice(0, 500) : null;
    if (Array.isArray(channels) && channels.every((c) => typeof c === 'string')) patch.channels = channels;
    if (typeof ai_enabled === 'boolean') patch.ai_enabled = ai_enabled ? 1 : 0;
    if (typeof enabled === 'boolean') patch.enabled = enabled ? 1 : 0;
    if (typeof rate_limit_minutes === 'number')
      patch.rate_limit_minutes = Math.min(Math.max(Math.round(rate_limit_minutes), 1), 1440);
    await updateSatellite(gid, patch);
    await logAudit(req.session.user!.id, gid, 'satellite.update', JSON.stringify(patch).slice(0, 200));
    res.json({ ok: true });
  });

  app.delete('/api/guilds/:gid/satellite', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    await logAudit(req.session.user!.id, gid, 'satellite.unlink', null);
    res.json({ ok: await removeSatellite(gid) });
  });

  // hub view — which satellites point at THIS guild, plus incoming referrals
  app.get('/api/guilds/:gid/satellites', authed, guildAccess, async (req, res) => {
    const gid = req.params.gid as string;
    const all = await listSatellites();
    res.json({
      satellites: all.filter((s) => s.hub_guild_id === gid),
      referrals: await referralsForHub(gid, 50),
    });
  });

  // OAuth2 authorize URL to add the bot to an external (satellite) server —
  // the target server admin must click this; the bot cannot join on its own.
  app.get('/api/invite-url', authed, async (req, res) => {
    const gid =
      typeof req.query.guild_id === 'string' && /^\d{5,25}$/.test(req.query.guild_id)
        ? `&guild_id=${req.query.guild_id}&disable_guild_select=true`
        : '';
    res.json({
      url: `https://discord.com/oauth2/authorize?client_id=${env.clientId}&scope=bot%20applications.commands&permissions=1099780071478${gid}`,
    });
  });

  // ---------- coin discovery (CoinGecko, cached + rate-limit friendly) ----------

  const CG = 'https://api.coingecko.com/api/v3';
  const cgCache = new Map<string, { at: number; data: unknown }>();
  async function cgFetch(path: string): Promise<unknown> {
    const hit = cgCache.get(path);
    if (hit && Date.now() - hit.at < 300_000) return hit.data;
    const r = await fetch(`${CG}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`coingecko ${r.status}`);
    const data = await r.json();
    cgCache.set(path, { at: Date.now(), data });
    return data;
  }

  interface TrendingResp {
    coins?: { item: { id: string; name: string; symbol: string; thumb?: string; large?: string; market_cap_rank?: number; data?: { price_change_percentage_24h?: { usd?: number } } } }[];
  }
  interface MarketCoin {
    id: string; name: string; symbol: string; image: string;
    market_cap_rank: number | null; current_price: number | null;
    total_volume: number | null; price_change_percentage_24h: number | null;
  }

  app.get('/api/discover', authed, async (_req, res) => {
    try {
      const [trending, markets, newest] = (await Promise.all([
        cgFetch('/search/trending'),
        cgFetch('/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=1&price_change_percentage_24h'),
        cgFetch('/coins/markets?vs_currency=usd&order=id_desc&per_page=25&page=1&price_change_percentage_24h'),
      ])) as [TrendingResp, MarketCoin[], MarketCoin[]];

      const trend = (trending.coins ?? []).slice(0, 15).map(({ item }) => ({
        id: item.id, name: item.name, symbol: item.symbol,
        thumb: item.thumb ?? item.large ?? null, rank: item.market_cap_rank ?? null,
        change: item.data?.price_change_percentage_24h?.usd ?? null, price: null as number | null,
      }));
      const slim = (c: MarketCoin) => ({
        id: c.id, name: c.name, symbol: c.symbol, thumb: c.image, rank: c.market_cap_rank,
        change: c.price_change_percentage_24h, price: c.current_price, volume: c.total_volume,
      });
      const gainers = markets
        .filter((c) => (c.price_change_percentage_24h ?? 0) > 0)
        .sort((a, b) => (b.price_change_percentage_24h ?? 0) - (a.price_change_percentage_24h ?? 0))
        .slice(0, 15)
        .map(slim);

      res.json({
        trending: trend,
        gainers,
        newListings: newest.slice(0, 15).map(slim),
        watchlist: await listWatch(isOwnerReq(_req) ? undefined : _req.session.user!.id),
      });
    } catch {
      res.status(502).json({ error: 'provider_unavailable' });
    }
  });

  // fetch a coin's official Discord link (lazy — one call per coin, cached)
  app.get('/api/discover/discord/:coinId', authed, async (req, res) => {
    const coinId = req.params.coinId as string;
    if (!/^[a-z0-9-]{1,60}$/.test(coinId)) return res.status(400).json({ error: 'bad_id' });
    try {
      const data = (await cgFetch(
        `/coins/${coinId}?localization=false&tickers=false&market_data=false&community_data=true&developer_data=false&sparkline=false`,
      )) as { links?: { chat_url?: string[]; official_forum_url?: string[]; homepage?: string[] } };
      const links = data.links ?? {};
      const discord = [...(links.chat_url ?? []), ...(links.official_forum_url ?? [])].find((u) => /discord\.(gg|com)/i.test(u));
      res.json({ discord: discord ?? null, homepage: links.homepage?.[0] ?? null });
    } catch {
      res.status(502).json({ error: 'provider_unavailable' });
    }
  });

  // ---------- outreach watchlist ----------

  // watchlist is per-user — each account sees only its own; godmode sees all + who added each
  app.get('/api/watchlist', authed, async (req, res) =>
    res.json(await listWatch(isOwnerReq(req) ? undefined : req.session.user!.id)),
  );

  app.post('/api/watchlist', authed, async (req, res) => {
    const { coin_id, symbol, name, discord_url } = req.body ?? {};
    if (typeof coin_id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(coin_id)) {
      return res.status(400).json({ error: 'bad_coin' });
    }
    const id = await addWatch(
      req.session.user!.id, coin_id,
      typeof symbol === 'string' ? symbol.slice(0, 20) : null,
      typeof name === 'string' ? name.slice(0, 80) : null,
      typeof discord_url === 'string' && discord_url.trim() ? discord_url.slice(0, 200) : null,
    );
    res.json({ ok: true, id });
  });

  app.patch('/api/watchlist/:id', authed, async (req, res) => {
    const row = await getWatch(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (!isOwnerReq(req) && row.added_by !== req.session.user!.id) {
      return res.status(403).json({ error: 'not_yours' });
    }
    const { status, notes, discord_url } = req.body ?? {};
    const patch: { status?: string; notes?: string; discord_url?: string } = {};
    if (['new', 'contacted', 'joined', 'rejected'].includes(status)) patch.status = status;
    if (typeof notes === 'string') patch.notes = notes.slice(0, 500);
    if (typeof discord_url === 'string') patch.discord_url = discord_url.slice(0, 200);
    res.json({ ok: await updateWatch(Number(req.params.id), patch) });
  });

  app.delete('/api/watchlist/:id', authed, async (req, res) => {
    const row = await getWatch(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (!isOwnerReq(req) && row.added_by !== req.session.user!.id) {
      return res.status(403).json({ error: 'not_yours' });
    }
    res.json({ ok: await removeWatch(Number(req.params.id)) });
  });

  // paste a coin server's invite — the bot previews it (no join needed), tracks it
  // in the watchlist, and returns the authorize URL for whoever has Manage Server
  app.post('/api/watchlist/invite', authed, async (req, res) => {
    const { invite } = req.body ?? {};
    if (typeof invite !== 'string' || !invite.trim()) {
      return res.status(400).json({ error: 'bad_invite' });
    }
    const code =
      invite.trim().match(/(?:discord\.gg\/|discord\.com\/invite\/)([\w-]+)/i)?.[1] ?? invite.trim();
    const inv = await client.fetchInvite(code).catch(() => null);
    if (!inv?.guild) return res.status(400).json({ error: 'invalid_invite' });

    const installed = client.guilds.cache.has(inv.guild.id);
    if (!(await findWatchByGuild(inv.guild.id))) {
      const id = await addWatchGuild(
        req.session.user!.id, inv.guild.id, inv.guild.name, code, `https://discord.gg/${code}`,
      );
      if (installed) await updateWatch(id, { status: 'joined' });
    }
    res.json({
      ok: true,
      guild: { id: inv.guild.id, name: inv.guild.name, members: inv.memberCount ?? null },
      installed,
      authUrl:
        `https://discord.com/oauth2/authorize?client_id=${env.clientId}` +
        `&scope=bot%20applications.commands&permissions=1099780071478&guild_id=${inv.guild.id}&disable_guild_select=true`,
    });
  });

  // ---------- one-click join (guilds.join OAuth scope) ----------

  app.post('/api/join/:gid', authed, async (req, res) => {
    const gid = req.params.gid as string;
    const token = req.session.accessToken;
    if (!token) return res.status(403).json({ error: 'relogin', message: 'Log out and back in — join permission was added.' });
    if (!/^\d{5,25}$/.test(gid) || !client.guilds.cache.has(gid)) {
      return res.status(404).json({ error: 'not_a_hub' });
    }
    const r = await fetch(`${DISCORD_API}/guilds/${gid}/members/${req.session.user!.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${env.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
    });
    if (r.status === 201 || r.status === 204) return res.json({ ok: true });
    res.status(502).json({ error: 'discord_error', status: r.status });
  });

  // ---------- audit log ----------

  app.get('/api/admin/audit', authed, ownerOnly, async (_req, res) => {
    res.json(await getAuditLog(undefined, 100));
  });

  app.get('/api/guilds/:gid/audit', authed, guildAccess, async (req, res) => {
    res.json(await getAuditLog(req.params.gid as string, 50));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('web error:', err);
    res.status(500).json({ error: 'internal' });
  });

  app.listen(env.dashboardPort, () => {
    console.log(`Dashboard: ${env.dashboardUrl} (listening on :${env.dashboardPort})`);
    console.log(`OAuth redirect URI to register: ${redirectUri}`);
  });
}
