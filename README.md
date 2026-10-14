# Support Ticket Bot

A self-hosted, **multi-server** Discord support ticket bot — TypeScript + discord.js v14 + Postgres/SQLite, with an optional **web dashboard** (Discord OAuth2).

## Features

**Members**
- Ticket panel (`/panel`) — dropdown menu or per-type buttons
- Modal intake form (subject + description) before the channel opens
- Private ticket channels under a hidden category
- `/link show` — drops a configured links embed; `/link list` for a private preview
- Per-user open-ticket limit and cooldown

**Staff**
- Claim / unclaim (button or `/ticket claim`)
- Close → confirm → HTML transcript saved & posted + DM rating request to the owner
- Reopen / delete with confirmation
- `/ticket add|remove|rename|priority|move|note|notes|info|list`
- `/blacklist add|remove|list`
- `/link add|remove` — manage the links embed per-guild
- `/stats` — open/closed counts, average rating, per-type breakdown
- Event log channel for open/claim/close/reopen/delete/rating events
- Auto-close: warns after `autoclose_hours` of inactivity, closes 1h later

**Satellite / support funnel**
- `/satellite link invite:<hub invite>` — turns any server into a satellite of your support hub
- Auto-responder watches for complaints/questions/problems and replies with the hub invite
- AI intent detection catches vague questions (Neon AI Gateway / any OpenAI-compatible endpoint — optional, falls back to keywords)
- Per-user rate limit + per-channel floor so it never feels spammy
- Referral tracking: who was routed, when they joined the hub, which ticket they opened — visible in Discord logs, the dashboard, and as a note on their ticket
- Dashboard "Satellite" tab for full config without touching Discord

**Admin**
- `/setup` — one command: creates `Tickets` + `Closed Tickets` categories (hidden from `@everyone`), stores support/admin roles, log & transcript channels, limits
- `/types add|edit|remove|list` — **per-server** ticket categories (each guild manages its own)

**Community / hub features**
- `/suggest new` — suggestion box with 👍/👎 voting buttons; staff set status via `/suggest status` (pending → approved/denied/implemented)
- `/poll create` — button-voting polls, up to 5 options, optional auto-close timer + winner announcement
- `/tag` — canned replies for common questions (`send`/`add`/`remove`/`list`, autocomplete)
- `/announce` — styled embed to any channel with optional role ping
- `/mod` — warn (DB-persisted), warnings, clearwarnings, kick, ban, timeout, untimeout — DMs the user + logs
- Welcome messages (`{user}`/`{server}`/`{count}` placeholders) + autorole on join — **requires "Server Members Intent"** enabled in the dev portal
- Staff escalation — pings the support role if a ticket gets no staff reply within `escalation_minutes`
- `/giveaway create|end|reroll|list` — 🎉 button entry with live count, timed auto-end, winner picking
- `/remind set|list|cancel` — personal reminders (`10m`, `2h`, `1d`), delivered in-channel
- `/automod` — native Discord AutoMod: keyword block, spam, mention-spam, invite links (needs Manage Server)
- `/reactionrole create|bind|unbind|list` — react-to-get-role panels (unicode + custom emoji)
- `/sticky set|remove` — message re-pinned to the bottom of a channel after activity
- `/afk [reason]` — AFK status; auto-answers mentions, clears when you return
- `/userinfo`, `/serverinfo` — profile & server stat cards
- Audit logging — member leaves + message deletes/edits posted to the log channel (deleted-message content only when cached)
- `/cmd` — **custom commands**: staff define `/cmd run <name>` replies (`add`/`remove`/`list`, autocomplete, usage counter)
- `/form` — **custom intake forms**: up to 5 questions per ticket type replace the default modal (`add`/`list`/`remove`/`clear`, short/paragraph, required toggle)
- **Welcome cards** — generated PNG card (avatar + name + member count) on join; toggle via `/setup welcome_card` or dashboard
- **Starboard** — messages with enough ⭐/🌟/💫 reactions are reposted to a starboard channel, count kept live
- **Join-to-create voice** — set a voice hub; joining it spawns a personal room that auto-deletes when empty
- **Audit trail** — every dashboard admin action (config, blacklist, types, godmode) persisted; viewable in the Audit tab + godmode feed

**Multi-server**
- Every table is keyed by `guild_id` — one bot instance can serve many servers, each fully isolated (own types, links, roles, limits, stats)
- `config.json` provides the *default* ticket types/links seeded per-guild on first contact — afterwards each server edits its own via `/types`, `/link`, or the dashboard

**⚡ Godmode** (bot owners — `OWNER_IDS` in `.env`)
- Dashboard shows **every server** the bot is in, not just ones you admin
- **Fleet overview** — total servers, members, open/total tickets
- **Global blacklist** — restrict a user ID from opening tickets in *all* servers
- **Per-server kill switch** — disable the bot in a guild (all commands, panels, and tickets blocked)
- **Force-leave** — remove the bot from any server remotely
- Owner IDs implicitly count as staff in every server (Discord-side godmode too)

**Web dashboard** (optional)
- Landing page at `/` — hero, feature grid, command overview, invite + dashboard CTAs
- Dashboard app at `/dashboard` — Discord OAuth2 login; you only see servers where you have *Manage Server* **and** the bot is installed
- Tabs: Overview (stats + one-click category bootstrap), Settings (roles/channels/limits/welcome/suggestions/escalation/starboard/voice-hub/panel text), Ticket Types, **Forms** (per-type intake questions), Links, Tags, Suggestions, Tickets, **Transcripts** (browse/download saved HTML), **Giveaways** (create/end), **Reaction Roles** (panel + bind), **Sticky**, **AutoMod** (toggle/delete rules), **Commands** (custom command CRUD), Blacklist, **Audit** (per-guild action log), Panel
- Owners get an extra Godmode layer: fleet stats, global blacklist, per-server disable/enable/leave
- Runs inside the bot process — shares the same DB and Discord client

**Dashboard security:** sessions persist in SQLite (survive restarts), CSRF tokens required on all mutating API calls, rate limiting (120 req/min API, 20 req/min auth), JSON body cap 100kb.

## Setup

### 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**
2. **Bot** → **Reset Token** → copy it
3. **General Information** → copy the **Application ID**
4. **Bot** → enable **Server Members Intent** (needed for welcome messages + autorole; everything else works without it)

### 2. Invite the bot

Replace `CLIENT_ID` and open:

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=1099780071478
```

(permissions: Manage Server — for `/automod` rules — Kick, Ban, Moderate Members, Manage Channels, Send Messages, Manage Messages, Embed Links, Attach Files, Read Message History)

### 3. Configure & run

```bash
cp .env.example .env      # fill in DISCORD_TOKEN, CLIENT_ID, GUILD_ID (dev server = instant commands)
npm install
npm start                 # or: npm run dev  (watch mode)
```

### Database

Two modes, auto-selected at boot:

- **Postgres** (production) — set `DATABASE_URL` in `.env`. The full schema is created automatically on first boot. Works with Neon, Supabase, Railway, or any Postgres 12+. For pooled providers (e.g. Neon `-pooler`), set `DATABASE_URL_POOLED` — the app prefers it at runtime while `DATABASE_URL` stays the direct connection used by migrations. `channel_binding=` params are stripped automatically (node-postgres doesn't support them yet).
- **SQLite** (default) — no config needed; data lives in `data/tickets.db`. Fine for local dev and small bots.

**Migrate existing SQLite data → Postgres:**

```
DATABASE_URL="postgresql://..." npm run db:migrate
```

Idempotent (`ON CONFLICT DO NOTHING`) — safe to rerun. Imported `id` sequences are synced so new rows don't collide. The `sessions` table migrates too, so logged-in dashboard users stay logged in.

### 4. In Discord

1. `/setup support_role:@Support log_channel:#logs transcript_channel:#transcripts`
2. `/panel` in a public channel → members pick a category → fill the modal → ticket opens
3. Staff claim/answer/close inside the ticket channel
4. `/types` to customise this server's ticket categories (or use the dashboard)

## Web dashboard

1. Discord dev portal → **OAuth2** → copy **Client Secret** into `.env` as `OAUTH_CLIENT_SECRET`, set `SESSION_SECRET` to any random string
2. Under **OAuth2 → Redirects** add `http://localhost:3000/auth/callback` (or `${DASHBOARD_URL}/auth/callback` if changed)
3. `npm start` → open <http://localhost:3000> (landing page) → **Dashboard** → **Login with Discord** → you're returned to `/dashboard`
4. Pick a server → configure everything from the browser
5. **Godmode:** set `OWNER_IDS=your_discord_user_id` in `.env` — the dashboard then shows every server the bot is in plus fleet controls (global blacklist, disable/enable, force-leave)

Notes for production: put the dashboard behind HTTPS and set `DASHBOARD_URL` to the public origin; sessions persist in the database (SQLite or Postgres — whichever driver is active) so logins survive bot restarts.

## Satellite funnel & coin discovery

A compliant way to route users from partner communities into your ticket server:

1. **Discover** — the dashboard's 🔍 Coin discovery view pulls trending / top-gaining / new listings from CoinGecko (free API, no key). Each coin gets a "Find Discord" lookup and a "+ Watch" button that adds it to the **outreach watchlist** (statuses: new → contacted → joined → rejected).
2. **Get invited** — a project's admin adds the bot via the OAuth2 URL (the dashboard's `/api/invite-url`, or the standard invite link). The bot cannot join servers on its own — Discord requires the server admin to authorize it.
3. **Link the satellite** — in their server: `/satellite link invite:https://discord.gg/<your-hub>` (or the Satellite dashboard tab). The bot now watches for support-looking messages.
4. **Auto-respond** — keyword hits reply instantly; with `NEON_AI_GATEWAY_*` configured, ambiguous messages go through an AI classifier first. Replies are rate-limited (per-user, default 60min) and embed the **plain, transparent hub invite** — no cloaking or link tricks, since opted-in admins can simply whitelist it in their own AutoMod.
5. **Convert** — the referred user joins your hub (manual invite click, or the landing-page **Get Support** button which uses Discord's `guilds.join` OAuth2 flow — set `HUB_GUILD_ID`). The join is logged, and when they open a ticket it's annotated "Referred from satellite server X" for staff.

AI config: `NEON_AI_GATEWAY_BASE_URL` + `NEON_AI_GATEWAY_TOKEN` (+ optional `AI_MODEL`). Without them, satellites still work on keyword matching; AI triage/drafting is skipped.

### "Route to Support" — user-installable context command

For servers where the bot is **not** installed, Discord's user-installable apps still give you a manual routing action. One-time setup:

1. Dev portal → your app → **Installation** → enable **User Install** (the bot also attempts this via the API at startup)
2. Set `HUB_INVITE` to your hub's public invite URL
3. On the bot's profile click **Add App** → **Use it everywhere**

Then in any server you're a member of: right-click a member's question/complaint → **Apps → Route to Support** → the app posts a public reply (AI-drafted when the gateway is configured) inviting them to your hub, and logs a referral. This is a user-triggered action — it does not monitor or auto-respond in guilds that never authorized the bot.

## Customization

`config.json` defines the **defaults seeded for each new guild**:

- `ticketTypes` — initial categories (each server can then change its own)
- `links` — initial `/link` entries
- `panel` — fallback panel title/description (overridable per-guild)

## Layout

```
src/
  index.ts          client boot, command registration, sweeps (tickets/polls/reminders/giveaways),
                    afk+sticky+reaction-role+audit event handlers
  db.ts             dual-driver database layer — Postgres when DATABASE_URL is set,
                    node:sqlite fallback. Schema + dialect translation + all queries
  tickets.ts        create/close/reopen/delete/claim/transcript/auto-close service
  interactions.ts   buttons, select menus, modals, DM rating flow, giveaway entry
  giveaways.ts      giveaway embed + winner selection/end lifecycle
  panel.ts          shared panel-message builder (Discord command + dashboard)
  votes.ts          suggestion/poll embeds, vote buttons, poll auto-close
  web.ts            Express dashboard: OAuth2, sessions, per-guild JSON API
  util.ts           embeds, control buttons, staff check
  commands/         setup, panel, ticket, types, link, blacklist, stats,
                    tag, suggest, poll, mod, announce, giveaway, remind,
                    automod, reactionrole, sticky, afk, info, cmd, form, help
public/             dashboard frontend (vanilla JS SPA)
data/tickets.db     sqlite database (auto-created; unused when DATABASE_URL is set)
scripts/migrate.ts  sqlite → postgres migration (`npm run db:migrate`)
transcripts/        HTML transcripts (auto-created, also posted to Discord)
```

## Command reference

| Command | Who | What |
|---|---|---|
| `/setup` | Manage Server | Configure roles, channels, categories, limits |
| `/panel` | Staff | Post the ticket panel (`style`: dropdown/buttons) |
| `/ticket <sub>` | Mixed | `close`(owner+staff) `claim` `unclaim` `add` `remove` `rename` `priority` `move` `note` `notes` `info` `list` `reopen` `delete` |
| `/link show` | Everyone | Drop the links embed (`private` option for ephemeral) |
| `/link add/remove/list` | Staff/Everyone* | Manage links (*`list` is public) |
| `/types <sub>` | Staff | `add` `edit` `remove` `list` — per-server ticket categories |
| `/blacklist <sub>` | Staff | `add` `remove` `list` |
| `/tag <sub>` | Mixed | `send`/`list` (all) · `add`/`remove` (staff) |
| `/suggest <sub>` | Mixed | `new` (all) · `status` (staff) |
| `/poll <sub>` | Staff | `create` `end` |
| `/announce` | Staff | Embed announcement to a channel |
| `/mod <sub>` | Staff | `warn` `warnings` `clearwarnings` `kick` `ban` `timeout` `untimeout` |
| `/giveaway <sub>` | Staff | `create` `end` `reroll` `list` |
| `/cmd <sub>` | Mixed | `run`/`list` (all) · `add`/`remove` (staff) — custom commands |
| `/form <sub>` | Staff | `add` `list` `remove` `clear` — per-type intake questions (max 5) |
| `/remind <sub>` | Everyone | `set` `list` `cancel` — durations like `10m`, `2h`, `1d` |
| `/automod <sub>` | Manage Server | `keywords` `spam` `mentions` `invites` `status` — native AutoMod rules |
| `/reactionrole <sub>` | Staff | `create` `bind` `unbind` `list` |
| `/sticky <sub>` | Staff | `set` `remove` |
| `/afk [reason]` | Everyone | Set/clear AFK |
| `/userinfo [user]` | Everyone | User card |
| `/serverinfo` | Everyone | Server card |
| `/stats` | Staff | Ticket metrics |
| `/help` | Everyone | Command overview |
