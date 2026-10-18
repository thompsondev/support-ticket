const app = document.getElementById('app');
const userChip = document.getElementById('user-chip');
const state = { me: null, guild: null, overview: null, resources: null, tab: 'overview' };

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.csrf && opts.method && opts.method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
  const res = await fetch(path, { headers, ...opts });
  if (res.status === 401) {
    renderLogin();
    throw new Error('unauthenticated');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function notice(msg, ok = true) {
  const el = document.getElementById('notice');
  if (!el) return;
  el.className = `notice ${ok ? 'ok' : 'err'}`;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => (el.style.display = 'none'), 3500);
}

function renderLogin() {
  userChip.innerHTML = '';
  clearNav();
  app.innerHTML = `
    <div class="card center-card">
      <h1>🎫 Ticket Bot</h1>
      <p>Log in with Discord to manage ticket settings for your servers.</p>
      <a class="btn" href="/auth/discord">Login with Discord</a>
    </div>`;
}

function renderUserChip() {
  const u = state.me.user;
  const avatar = u.avatar
    ? `<img src="https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64">`
    : '';
  const accts = state.me.accounts ?? [];
  const switcher =
    accts.length > 1
      ? `<select id="acct-switch" title="Switch account">${accts
          .map((a) => `<option value="${a.id}" ${a.id === u.id ? 'selected' : ''}>@${esc(a.username)}</option>`)
          .join('')}</select>`
      : '';
  userChip.innerHTML = `<div class="user-chip">${state.me.isOwner ? '<span class="godmode-badge">⚡ GODMODE</span>' : ''}${avatar}${switcher || `<span>${esc(
    u.global_name || u.username,
  )}</span>`}<a class="btn small secondary" href="/auth/discord?add=1" title="Add another Discord account">+</a><a class="btn small secondary" href="/auth/logout">Logout</a></div>`;
  document.getElementById('acct-switch')?.addEventListener('change', async (e) => {
    await api('/api/accounts/switch', {
      method: 'POST',
      body: JSON.stringify({ accountId: e.target.value }),
    });
    state.me = await api('/api/me');
    renderUserChip();
    renderGuilds();
  });
}

function inviteUrl(gid) {
  return `https://discord.com/oauth2/authorize?client_id=${state.me.clientId}&scope=bot%20applications.commands&permissions=1099780071478&guild_id=${gid}&disable_guild_select=true`;
}

async function renderGuilds() {
  const gs = state.me.guilds;
  let godmodeHtml = '';
  if (state.me.isOwner) {
    let fleet = null;
    try { fleet = await api('/api/admin/fleet'); } catch {}
    let gbl = [];
    try { gbl = await api('/api/admin/blacklist'); } catch {}
    let auditRows = [];
    try { auditRows = (await api('/api/admin/audit')).slice(0, 15); } catch {}
    godmodeHtml = `
      <div class="card godmode-card">
        <h3>⚡ Godmode — fleet control</h3>
        ${fleet ? `<div class="stat-grid" style="margin:10px 0 16px">
          <div class="stat"><div class="num">${fleet.totalGuilds}</div><div class="lbl">Servers</div></div>
          <div class="stat"><div class="num">${fleet.totalMembers}</div><div class="lbl">Members</div></div>
          <div class="stat"><div class="num">${fleet.totalOpenTickets}</div><div class="lbl">Open tickets</div></div>
          <div class="stat"><div class="num">${fleet.totalTickets}</div><div class="lbl">Total tickets</div></div>
        </div>` : ''}
        <h3>🚫 Global blacklist <span class="muted">(blocked from tickets in every server)</span></h3>
        <table>
          ${gbl
            .map(
              (b) => `<tr data-uid="${b.user_id}">
              <td><code>${b.user_id}</code></td><td>${esc(b.reason ?? '—')}</td>
              <td>${new Date(b.created_at).toLocaleDateString()}</td>
              <td><button class="btn small danger gb-del">✕</button></td>
            </tr>`,
            )
            .join('') || '<tr><td colspan="4" class="muted">Global blacklist is empty.</td></tr>'}
        </table>
        <div class="inline-form">
          <div><label>User ID</label><input id="gb-id" placeholder="123456789012345678"></div>
          <div style="flex:2"><label>Reason</label><input id="gb-reason" placeholder="Abuse, spam, …"></div>
          <button class="btn" id="gb-add">Restrict user</button>
        </div>
        <h3 style="margin-top:20px">📜 Recent actions</h3>
        <table>
          ${auditRows
            .map(
              (a) => `<tr>
              <td><code>${a.actor_id}</code></td><td><b>${esc(a.action)}</b></td>
              <td>${esc(a.guild_id ?? '—')}</td><td>${esc(a.detail ?? '')}</td>
              <td>${new Date(a.created_at).toLocaleString()}</td>
            </tr>`,
            )
            .join('') || '<tr><td colspan="5" class="muted">No actions recorded yet.</td></tr>'}
        </table>
      </div>`;
  }
  setGlobalNav('servers');
  app.innerHTML = `
    <div class="page">
    ${godmodeHtml}
    <h2>${state.me.isOwner ? 'All servers' : 'Your servers'}</h2>
    <p class="muted" style="margin-bottom:16px">${
      state.me.isOwner
        ? 'Every server running the bot — click to manage.'
        : 'Servers where you have the Manage Server permission.'
    }</p>
    <div class="guild-grid">
      ${gs
        .map(
          (g) => `
        <div class="guild-card" data-gid="${g.id}" data-hasbot="${g.hasBot}">
          ${
            g.icon
              ? `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128">`
              : `<div class="no-icon">${esc(g.name[0] ?? '?')}</div>`
          }
          <div><b>${esc(g.name)}</b></div>
          <div class="muted" style="font-size:12px">${g.memberCount ?? '?'} members${g.disabled ? ' · <span class="pill closed">disabled</span>' : ''}</div>
          ${g.hasBot ? '' : `<div class="invite"><a href="${inviteUrl(g.id)}" target="_blank">Invite bot first ↗</a></div>`}
        </div>`,
        )
        .join('')}
    </div>
    ${!gs.length ? '<p class="muted">No servers found.</p>' : ''}
    </div>`;
  document.querySelectorAll('.guild-card').forEach((el) => {
    el.onclick = () => {
      if (el.dataset.hasbot === 'true') openGuild(el.dataset.gid);
    };
  });
  document.getElementById('gb-add')?.addEventListener('click', async () => {
    try {
      await api('/api/admin/blacklist', {
        method: 'POST',
        body: JSON.stringify({
          user_id: document.getElementById('gb-id').value.trim(),
          reason: document.getElementById('gb-reason').value.trim() || null,
        }),
      });
      renderGuilds();
    } catch (e) {
      alert(e.message);
    }
  });
  document.querySelectorAll('.gb-del').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/admin/blacklist/${b.closest('tr').dataset.uid}`, { method: 'DELETE' });
      renderGuilds();
    };
  });
}

async function openGuild(gid) {
  state.guild = state.me.guilds.find((g) => g.id === gid);
  app.innerHTML = '<div class="loading">Loading server…</div>';
  const [overview, resources] = await Promise.all([
    api(`/api/guilds/${gid}/overview`),
    api(`/api/guilds/${gid}/resources`),
  ]);
  state.overview = overview;
  state.resources = resources;
  renderGuild();
}

const NAV = [
  ['SUPPORT', [
    ['overview', 'Overview'],
    ['tickets', 'Tickets'],
    ['transcripts', 'Transcripts'],
    ['panel', 'Panel'],
    ['types', 'Ticket Types'],
    ['forms', 'Forms'],
  ]],
  ['COMMUNITY', [
    ['suggestions', 'Suggestions'],
    ['giveaways', 'Giveaways'],
    ['rroles', 'Reaction Roles'],
    ['sticky', 'Sticky'],
    ['links', 'Links'],
    ['tags', 'Tags'],
    ['commands', 'Commands'],
  ]],
  ['MODERATION', [
    ['automod', 'AutoMod'],
    ['blacklist', 'Blacklist'],
  ]],
  ['SYSTEM', [
    ['satellite', 'Satellite'],
    ['settings', 'Settings'],
    ['audit', 'Audit'],
  ]],
];

function clearNav() {
  document.getElementById('sidebar-nav').innerHTML = '';
}

// top-level nav (server list / discover) when no guild is open
function setGlobalNav(active) {
  document.getElementById('sidebar-nav').innerHTML = `
    <div class="nav-group">MENU</div>
    <div class="nav-item ${active === 'servers' ? 'active' : ''}" data-nav="servers">🖥 Servers</div>
    <div class="nav-item ${active === 'discover' ? 'active' : ''}" data-nav="discover">🔍 Coin discovery</div>`;
  document.querySelectorAll('[data-nav]').forEach(
    (el) => (el.onclick = () => (el.dataset.nav === 'discover' ? discover() : renderGuilds())),
  );
}

function renderGuild() {
  const g = state.guild;
  document.getElementById('sidebar-nav').innerHTML = `
    <div class="nav-back" id="back">← All servers</div>
    <div class="nav-guild">
      ${g.icon
        ? `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64" alt="">`
        : `<div class="nav-guild-initial">${esc(g.name[0] ?? '?')}</div>`}
      <div><div class="nav-guild-name">${esc(g.name)}</div><div class="muted" style="font-size:11px">${g.memberCount ?? '?'} members</div></div>
    </div>
    ${NAV.map(([grp, items]) => `
      <div class="nav-group">${grp}</div>
      ${items.map(([id, lbl]) => `<div class="nav-item ${state.tab === id ? 'active' : ''}" data-tab="${id}">${lbl}</div>`).join('')}
    `).join('')}`;
  app.innerHTML = `
    <div class="page">
      <div id="notice" class="notice" style="display:none"></div>
      <div id="tab-body"></div>
    </div>`;
  document.getElementById('back').onclick = () => { state.guild = null; renderGuilds(); };
  document.querySelectorAll('.nav-item').forEach(
    (t) => (t.onclick = () => { state.tab = t.dataset.tab; renderGuild(); }),
  );
  ({ overview, settings, types, forms, links, tags, suggestions, tickets, transcripts, giveaways, rroles, sticky, automod, commands, blacklist, audit, satellite, panel })[state.tab]();
}

// ---------- overview ----------

function overview() {
  const o = state.overview;
  const c = o.counts || {};
  document.getElementById('tab-body').innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="num">${c.open || 0}</div><div class="lbl">Open</div></div>
      <div class="stat"><div class="num">${c.closed || 0}</div><div class="lbl">Closed</div></div>
      <div class="stat"><div class="num">${c.deleted || 0}</div><div class="lbl">Deleted</div></div>
      <div class="stat"><div class="num">${o.avgRating ? o.avgRating.toFixed(1) + '★' : '—'}</div><div class="lbl">Avg rating</div></div>
      <div class="stat"><div class="num">${o.types.length}</div><div class="lbl">Ticket types</div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>Quick actions</h3>
      <button class="btn secondary" id="bootstrap">Create ticket categories</button>
      <span class="muted" style="margin-left:10px">Creates the "🎫 Tickets" and "Closed Tickets" categories if missing.</span>
    </div>
    ${
      state.me.isOwner
        ? `<div class="card godmode-card">
          <h3>⚡ Godmode</h3>
          <p class="muted">Owner-level controls for this server.</p>
          <div style="margin-top:10px;display:flex;gap:8px">
            <button class="btn ${o.config.disabled ? '' : 'danger'}" id="gm-toggle">
              ${o.config.disabled ? '✅ Enable bot here' : '🚫 Disable bot here'}
            </button>
            <button class="btn secondary" id="gm-leave">Make bot leave this server</button>
          </div>
        </div>`
        : ''
    }`;
  document.getElementById('bootstrap').onclick = async () => {
    await api(`/api/guilds/${state.guild.id}/bootstrap`, { method: 'POST', body: '{}' });
    state.overview = await api(`/api/guilds/${state.guild.id}/overview`);
    notice('Categories ready.');
    renderGuild();
  };

  if (state.me.isOwner) {
    document.getElementById('gm-toggle').onclick = async () => {
      const action = o.config.disabled ? 'enable' : 'disable';
      await api(`/api/guilds/${state.guild.id}/${action}`, { method: 'POST', body: '{}' });
      state.overview = await api(`/api/guilds/${state.guild.id}/overview`);
      notice(`Bot ${action}d in this server.`);
      renderGuild();
    };
    document.getElementById('gm-leave').onclick = async () => {
      if (!confirm('Remove the bot from this server?')) return;
      await api(`/api/guilds/${state.guild.id}/leave`, { method: 'POST', body: '{}' });
      state.me = await api('/api/me');
      renderGuilds();
    };
  }
}

// ---------- settings ----------

function settings() {
  const c = state.overview.config;
  const r = state.resources;
  const roleOpts = (sel) =>
    `<option value="">— none —</option>` +
    r.roles.map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const chanOpts = (sel) =>
    `<option value="">— none —</option>` +
    r.textChannels.map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>#${esc(x.name)}</option>`).join('');
  const catOpts = (sel) =>
    `<option value="">— none —</option>` +
    (r.categories ?? []).map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>📁 ${esc(x.name)}</option>`).join('');

  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>Roles & channels</h3>
      <div class="row">
        <div><label>Support role *</label><select id="f-support">${roleOpts(c.support_role_id)}</select></div>
        <div><label>Admin role</label><select id="f-admin">${roleOpts(c.admin_role_id)}</select></div>
        <div><label>Log channel</label><select id="f-log">${chanOpts(c.log_channel_id)}</select></div>
        <div><label>Transcript channel</label><select id="f-trans">${chanOpts(c.transcript_channel_id)}</select></div>
        <div><label>Open-ticket category</label><select id="f-opencat">${catOpts(c.open_category_id)}</select></div>
        <div><label>Closed-ticket category</label><select id="f-closedcat">${catOpts(c.closed_category_id)}</select></div>
      </div>
      <h3 style="margin-top:20px">Limits</h3>
      <div class="row">
        <div><label>Max open tickets / user</label><input id="f-max" type="number" min="1" max="10" value="${c.max_tickets}"></div>
        <div><label>Cooldown (seconds)</label><input id="f-cd" type="number" min="0" value="${c.cooldown_seconds}"></div>
        <div><label>Auto-close after idle hours (0 = off)</label><input id="f-ac" type="number" min="0" max="168" value="${c.autoclose_hours}"></div>
        <div><label>Staff escalation (min, 0 = off)</label><input id="f-esc" type="number" min="0" value="${c.escalation_minutes}"></div>
      </div>
      <h3 style="margin-top:20px">Community</h3>
      <div class="row">
        <div><label>Welcome channel</label><select id="f-welcome">${chanOpts(c.welcome_channel_id)}</select></div>
        <div><label>Suggestions channel</label><select id="f-sug">${chanOpts(c.suggestions_channel_id)}</select></div>
        <div><label>Autorole on join</label><select id="f-autorole">${roleOpts(c.autorole_id)}</select></div>
        <div><label>Welcome card image</label>
          <select id="f-wcard"><option value="0" ${c.welcome_card ? '' : 'selected'}>Off</option><option value="1" ${c.welcome_card ? 'selected' : ''}>On</option></select></div>
      </div>
      <label>Welcome message — {user} {server} {count}</label>
      <input id="f-wmsg" value="${esc(c.welcome_message ?? '')}" placeholder="Welcome {user} to {server}! You are member #{count}.">
      <h3 style="margin-top:20px">Starboard & voice</h3>
      <div class="row">
        <div><label>⭐ Starboard channel</label><select id="f-star">${chanOpts(c.starboard_channel_id)}</select></div>
        <div><label>Stars needed (0 = 3)</label><input id="f-starth" type="number" min="0" max="50" value="${c.starboard_threshold || 3}"></div>
        <div><label>🔊 Join-to-create voice hub</label>
          <select id="f-vhub"><option value="">— none —</option>${(r.voiceChannels ?? [])
            .map((x) => `<option value="${x.id}" ${x.id === c.voice_hub_channel_id ? 'selected' : ''}>🔊 ${esc(x.name)}</option>`)
            .join('')}</select></div>
      </div>
      <h3 style="margin-top:20px">Panel text</h3>
      <label>Panel title</label><input id="f-ptitle" value="${esc(c.panel_title ?? '')}" placeholder="Support Tickets">
      <label>Panel description</label><textarea id="f-pdesc" rows="3">${esc(c.panel_description ?? '')}</textarea>
      <div style="margin-top:16px"><button class="btn" id="save">Save settings</button></div>
    </div>`;

  document.getElementById('save').onclick = async () => {
    const body = {
      support_role_id: document.getElementById('f-support').value || null,
      admin_role_id: document.getElementById('f-admin').value || null,
      log_channel_id: document.getElementById('f-log').value || null,
      transcript_channel_id: document.getElementById('f-trans').value || null,
      open_category_id: document.getElementById('f-opencat').value || null,
      closed_category_id: document.getElementById('f-closedcat').value || null,
      max_tickets: Number(document.getElementById('f-max').value),
      cooldown_seconds: Number(document.getElementById('f-cd').value),
      autoclose_hours: Number(document.getElementById('f-ac').value),
      escalation_minutes: Number(document.getElementById('f-esc').value),
      welcome_channel_id: document.getElementById('f-welcome').value || null,
      welcome_message: document.getElementById('f-wmsg').value || null,
      autorole_id: document.getElementById('f-autorole').value || null,
      suggestions_channel_id: document.getElementById('f-sug').value || null,
      welcome_card: Number(document.getElementById('f-wcard').value),
      starboard_channel_id: document.getElementById('f-star').value || null,
      starboard_threshold: Number(document.getElementById('f-starth').value),
      voice_hub_channel_id: document.getElementById('f-vhub').value || null,
      panel_title: document.getElementById('f-ptitle').value || null,
      panel_description: document.getElementById('f-pdesc').value || null,
    };
    state.overview.config = (await api(`/api/guilds/${state.guild.id}/config`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })).config;
    notice('Settings saved.');
  };
}

// ---------- types ----------

function types() {
  const ts = state.overview.types;
  const catOpts = (sel) =>
    `<option value="">— default category —</option>` +
    (state.resources?.categories ?? [])
      .map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>📁 ${esc(x.name)}</option>`)
      .join('');
  const colorOpts = (sel) =>
    [['secondary', '⬜ Gray (default)'], ['primary', '🟦 Blurple'], ['success', '🟩 Green'], ['danger', '🟥 Red']]
      .map(([v, l]) => `<option value="${v}" ${v === (sel ?? 'secondary') ? 'selected' : ''}>${l}</option>`)
      .join('');
  const EMOJIS = ['🎫','💰','⚠️','🔒','🐛','💬','❓','🛠️','📦','🔄','💎','🎁','📈','🧾','🔗','🆘','✅','❌','🪙','🌉','⛽','🎯','📤','📥'];
  const emojiPick = (cls) =>
    `<select class="${cls}" style="width:70px"><option value="">😀</option>${EMOJIS.map((e) => `<option value="${e}">${e}</option>`).join('')}</select>`;
  const CRYPTO_PACK = [
    { id: 'migration', label: 'Migration Issues', desc: 'Migration-related issues', emoji: '🔄', color: 'primary' },
    { id: 'validate-wallet', label: 'Validate Wallet', desc: 'Wallet validation issues', emoji: '✅', color: 'success' },
    { id: 'asset-recovery', label: 'Assets/Token Recovery', desc: 'Assets recovery issues', emoji: '🛠️', color: 'primary' },
    { id: 'rectification', label: 'Rectification', desc: 'Rectify issues', emoji: '🧰', color: 'primary' },
    { id: 'gas-fees', label: 'High Gas Fees', desc: 'Gas fee-related issues', emoji: '⛽', color: 'primary' },
    { id: 'claim-reward', label: 'Claim Reward', desc: 'Reward-related issues', emoji: '🎁', color: 'success' },
    { id: 'withdrawals', label: 'Deposits & Withdrawals', desc: 'Withdrawal-related issues', emoji: '📤', color: 'primary' },
    { id: 'slippage', label: 'Slippage Error', desc: 'Slippage error during trade', emoji: '📉', color: 'primary' },
    { id: 'transaction-error', label: 'Transaction Error', desc: 'Transaction-related issues', emoji: '❌', color: 'danger' },
    { id: 'cross-chain', label: 'Cross Chain Transfer', desc: 'Cross-chain bridge issues', emoji: '🌉', color: 'primary' },
    { id: 'staking', label: 'Staking Issues', desc: 'Staking related issues', emoji: '🪙', color: 'primary' },
    { id: 'swap-exchange', label: 'Swap/Exchange', desc: 'Swap/exchange issues', emoji: '🔁', color: 'primary' },
    { id: 'dapps', label: 'Connect to Dapps', desc: 'Error while connecting to Dapps', emoji: '🔗', color: 'primary' },
    { id: 'login', label: 'Login Issues', desc: 'Issues while logging into your wallet', emoji: '🔑', color: 'primary' },
    { id: 'airdrop', label: 'Claim Airdrop', desc: 'Airdrop-related issues', emoji: '🪂', color: 'success' },
    { id: 'nfts', label: 'NFTs Issues', desc: 'NFTs minting/transfer-related issues', emoji: '🖼️', color: 'primary' },
    { id: 'missing-balance', label: 'Missing/Irregular Balance', desc: 'Recover lost/missing funds', emoji: '📊', color: 'danger' },
    { id: 'whitelist', label: 'Whitelist Issues', desc: 'Whitelist-related issues', emoji: '📋', color: 'primary' },
    { id: 'tx-delay', label: 'Transaction Delay', desc: 'Delayed transactions', emoji: '⏳', color: 'primary' },
    { id: 'locked-account', label: 'Locked/Blacklisted Account', desc: 'Account lock issues', emoji: '🔒', color: 'danger' },
    { id: 'trading-wallet', label: 'Trading Wallet Issues', desc: 'Problem with your trading account', emoji: '💼', color: 'primary' },
    { id: 'buy-coin', label: 'Unable to Buy Coin/Token', desc: 'Trade crypto — account must be trusted', emoji: '💳', color: 'primary' },
    { id: 'other', label: 'Other Issues', desc: "Can't find your issue? Click here", emoji: '❓', color: 'secondary' },
  ];
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>Ticket types</h3>
      <p class="muted">Shown in the panel picker and on tickets. Max 25. A type's <b>category</b> overrides the default open-ticket category. <b>Instant</b> opens immediately on click; <b>Ask first</b> shows the intake form. <b>Color</b> applies to button-style panels; emoji accepts unicode or a server emoji like <code>&lt;:name:123&gt;</code>.</p>
      <table>
        <tr><th></th><th>ID</th><th>Label</th><th>Emoji</th><th>Description</th><th>Category</th><th>Opens</th><th>Color</th><th></th></tr>
        ${ts
          .map(
            (t) => `<tr data-id="${esc(t.type_id)}">
            <td>${esc(t.emoji ?? '')}</td><td><code>${esc(t.type_id)}</code></td>
            <td><input class="t-label" value="${esc(t.label)}"></td>
            <td style="white-space:nowrap"><input class="t-emoji" value="${esc(t.emoji ?? '')}" style="width:60px"> ${emojiPick('t-emojipick')}</td>
            <td><input class="t-desc" value="${esc(t.description ?? '')}"></td>
            <td><select class="t-cat">${catOpts(t.category_id)}</select></td>
            <td><select class="t-instant"><option value="1" ${t.instant ? 'selected' : ''}>⚡ Instant</option><option value="0" ${t.instant ? '' : 'selected'}>📝 Ask first</option></select></td>
            <td><select class="t-color">${colorOpts(t.button_style)}</select></td>
            <td><button class="btn small secondary t-save">Save</button>
                <button class="btn small danger t-del">✕</button></td>
          </tr>`,
          )
          .join('')}
      </table>
      <div class="inline-form" style="margin-bottom:14px">
        <button class="btn secondary" id="pack-import">📥 Import crypto support pack (${CRYPTO_PACK.length} types)</button>
        <span class="muted">Adds all issue categories with emoji + colors — skips ones you already have.</span>
      </div>
      <div class="inline-form">
        <div><label>ID (a-z 0-9 -)</label><input id="n-id" placeholder="vip"></div>
        <div><label>Label</label><input id="n-label" placeholder="VIP Support"></div>
        <div><label>Emoji</label><input id="n-emoji" placeholder="💎" style="width:60px"> ${emojiPick('n-emojipick')}</div>
        <div><label>Description</label><input id="n-desc" placeholder="Priority help"></div>
        <div><label>Category</label><select id="n-cat">${catOpts(null)}</select></div>
        <div><label>Opens</label><select id="n-instant"><option value="1">⚡ Instant</option><option value="0">📝 Ask first</option></select></div>
        <div><label>Color</label><select id="n-color">${colorOpts(null)}</select></div>
        <button class="btn" id="n-add">Add</button>
      </div>
    </div>`;

  document.querySelectorAll('.t-save').forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest('tr');
      await api(`/api/guilds/${state.guild.id}/types/${tr.dataset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          label: tr.querySelector('.t-label').value,
          emoji: tr.querySelector('.t-emoji').value || null,
          description: tr.querySelector('.t-desc').value || null,
          category_id: tr.querySelector('.t-cat').value || null,
          instant: tr.querySelector('.t-instant').value === '1',
          button_style: tr.querySelector('.t-color').value || null,
        }),
      });
      await reloadOverview('types');
      notice('Type saved.');
    };
  });
  document.querySelectorAll('.t-del').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this type? Existing tickets keep working.')) return;
      await api(`/api/guilds/${state.guild.id}/types/${b.closest('tr').dataset.id}`, {
        method: 'DELETE',
      });
      await reloadOverview('types');
      notice('Type removed.');
    };
  });
  document.getElementById('pack-import').onclick = async () => {
    const b = document.getElementById('pack-import');
    b.disabled = true;
    try {
      const r = await api(`/api/guilds/${state.guild.id}/types/bulk`, {
        method: 'POST',
        body: JSON.stringify({ types: CRYPTO_PACK.map((t) => ({ ...t, button_style: t.color })) }),
      });
      await reloadOverview('types');
      notice(`Imported ${r.added} type(s)${r.skipped ? ` — skipped ${r.skipped} existing` : ''}.`);
    } catch (e) {
      notice(e.message, false);
      b.disabled = false;
    }
  };

  document.querySelectorAll('.t-emojipick').forEach((s) => {
    s.onchange = () => {
      const inp = s.closest('td').querySelector('.t-emoji');
      if (s.value) inp.value = s.value;
    };
  });
  document.getElementById('n-emojipick').onchange = (e) => {
    if (e.target.value) document.getElementById('n-emoji').value = e.target.value;
  };

  const idEl = document.getElementById('n-id');
  const labelEl = document.getElementById('n-label');
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  labelEl.oninput = () => {
    if (!idEl.dataset.touched) idEl.value = slug(labelEl.value);
  };
  idEl.oninput = () => {
    idEl.dataset.touched = '1';
    idEl.value = slug(idEl.value);
  };

  document.getElementById('n-add').onclick = async () => {
    try {
      const id = idEl.value.trim();
      if (!/^[a-z0-9-]{1,32}$/.test(id)) return notice('ID must be lowercase a-z, 0-9, dashes only.', false);
      if (ts.some((t) => t.type_id === id)) return notice(`"${id}" already exists — use a different ID.`, false);
      await api(`/api/guilds/${state.guild.id}/types`, {
        method: 'POST',
        body: JSON.stringify({
          id,
          label: labelEl.value.trim(),
          emoji: document.getElementById('n-emoji').value.trim() || null,
          description: document.getElementById('n-desc').value.trim() || null,
          category_id: document.getElementById('n-cat').value || null,
          instant: document.getElementById('n-instant').value === '1',
          button_style: document.getElementById('n-color').value || null,
        }),
      });
      await reloadOverview('types');
      notice('Type added.');
    } catch (e) {
      notice(e.message === 'max_types' ? 'Discord allows max 25 types per panel — remove one first.' : e.message, false);
    }
  };
}

// ---------- links ----------

function links() {
  const ls = state.overview.links;
  const EMOJIS = ['🔗','🎫','📖','🛡️','💰','🌐','📊','❓','🛠️','📈','🪙','🎁','✅','🆘','📚','💬','⚙️','🧭'];
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>Links</h3>
      <p class="muted">Posted by <code>/link show</code> or via <b>Post to channel</b> — each entry renders as a labeled button; users never see the raw URL.</p>
      <table>
        <tr><th>Label</th><th>Emoji</th><th>URL</th><th>Description</th><th></th></tr>
        ${ls
          .map(
            (l) => `<tr data-label="${esc(l.label)}">
            <td><b>${esc(l.label)}</b></td><td>${esc(l.emoji ?? '')}</td><td><a href="${esc(l.url)}" target="_blank">${esc(l.url)}</a></td>
            <td>${esc(l.description ?? '')}</td>
            <td><button class="btn small danger l-del">✕</button></td>
          </tr>`,
          )
          .join('')}
      </table>
      <div class="inline-form">
        <div><label>Label</label><input id="nl-label" placeholder="Docs"></div>
        <div><label>Emoji</label><input id="nl-emoji" placeholder="🔗" style="width:60px">
          <select id="nl-emojipick" style="width:70px"><option value="">😀</option>${EMOJIS.map((e) => `<option value="${e}">${e}</option>`).join('')}</select></div>
        <div><label>URL</label><input id="nl-url" placeholder="https://…"></div>
        <div><label>Description</label><input id="nl-desc" placeholder="optional"></div>
        <button class="btn" id="nl-add">Add</button>
      </div>
      <h3 style="margin-top:16px">Quick list — one link, many buttons</h3>
      <p class="muted">One shared URL for every entry. One per line: <code>Label | optional description</code></p>
      <div class="inline-form">
        <div style="flex:2"><label>Shared URL</label><input id="nl-bulk-url" placeholder="https://discord.gg/your-hub or your site"></div>
        <div><label>Emoji for all</label><input id="nl-bulk-emoji" placeholder="🔗" style="width:60px"></div>
      </div>
      <textarea id="nl-bulk" rows="6" placeholder="Migration Issues | migration-related issues&#10;Validate Wallet | wallet validation issues&#10;Claim Reward | reward-related issues" style="width:100%;margin-top:8px"></textarea>
      <button class="btn" id="nl-bulk-add" style="margin-top:8px">Add all →</button>
      <h3 style="margin-top:16px">Post to channel</h3>
      <div class="inline-form">
        <div style="flex:2"><select id="nl-channel"><option value="">— pick a channel —</option>${(state.resources?.textChannels ?? []).map((c) => `<option value="${c.id}">#${esc(c.name)}</option>`).join('')}</select></div>
        <button class="btn secondary" id="nl-post" ${ls.length ? '' : 'disabled'}>Post links panel</button>
      </div>
    </div>`;

  document.querySelectorAll('.l-del').forEach((b) => {
    b.onclick = async () => {
      await api(
        `/api/guilds/${state.guild.id}/links/${encodeURIComponent(b.closest('tr').dataset.label)}`,
        { method: 'DELETE' },
      );
      await reloadOverview('links');
      notice('Link removed.');
    };
  });
  document.getElementById('nl-emojipick').onchange = (e) => {
    if (e.target.value) document.getElementById('nl-emoji').value = e.target.value;
  };
  document.getElementById('nl-bulk-add').onclick = async () => {
    const url = document.getElementById('nl-bulk-url').value.trim();
    if (!url) return notice('Set the shared URL first.', false);
    const items = document.getElementById('nl-bulk').value
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [label, ...rest] = l.split('|');
        return { label: label.trim(), description: rest.join('|').trim() || undefined };
      });
    if (!items.length) return notice('Paste at least one label line.', false);
    try {
      const r = await api(`/api/guilds/${state.guild.id}/links/bulk`, {
        method: 'POST',
        body: JSON.stringify({ url, emoji: document.getElementById('nl-bulk-emoji').value.trim() || null, items }),
      });
      document.getElementById('nl-bulk').value = '';
      await reloadOverview('links');
      notice(`Added ${r.added} link(s)${r.skipped ? ` — skipped ${r.skipped}` : ''}.`);
    } catch (e) {
      notice(e.message, false);
    }
  };
  document.getElementById('nl-post').onclick = async () => {
    const cid = document.getElementById('nl-channel').value;
    if (!cid) return notice('Pick a channel first.', false);
    try {
      await api(`/api/guilds/${state.guild.id}/links/panel`, {
        method: 'POST',
        body: JSON.stringify({ channelId: cid }),
      });
      notice('Links panel posted.');
    } catch (e) {
      notice(e.message, false);
    }
  };
  document.getElementById('nl-add').onclick = async () => {
    try {
      await api(`/api/guilds/${state.guild.id}/links`, {
        method: 'POST',
        body: JSON.stringify({
          label: document.getElementById('nl-label').value.trim(),
          url: document.getElementById('nl-url').value.trim(),
          description: document.getElementById('nl-desc').value.trim() || null,
          emoji: document.getElementById('nl-emoji').value.trim() || null,
        }),
      });
      await reloadOverview('links');
      notice('Link added.');
    } catch (e) {
      notice(e.message, false);
    }
  };
}

// ---------- tags ----------

async function tags() {
  const rows = await api(`/api/guilds/${state.guild.id}/tags`);
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>Tags — canned replies</h3>
      <p class="muted">Posted with /tag send in Discord.</p>
      <table>
        <tr><th>Name</th><th>Content</th><th></th></tr>
        ${rows
          .map(
            (t) => `<tr data-name="${esc(t.name)}">
            <td><code>${esc(t.name)}</code></td>
            <td>${esc(t.content.slice(0, 80))}${t.content.length > 80 ? '…' : ''}</td>
            <td><button class="btn small danger tg-del">✕</button></td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="3" class="muted">No tags yet.</td></tr>'}
      </table>
      <div class="inline-form">
        <div><label>Name (a-z 0-9 - _)</label><input id="nt-name" placeholder="refund-policy"></div>
        <div style="flex:3"><label>Content</label><input id="nt-content" placeholder="Reply text…"></div>
        <button class="btn" id="nt-add">Add</button>
      </div>
    </div>`;
  document.querySelectorAll('.tg-del').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/guilds/${state.guild.id}/tags/${encodeURIComponent(b.closest('tr').dataset.name)}`, {
        method: 'DELETE',
      });
      tags();
      notice('Tag removed.');
    };
  });
  document.getElementById('nt-add').onclick = async () => {
    try {
      await api(`/api/guilds/${state.guild.id}/tags`, {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('nt-name').value.trim(),
          content: document.getElementById('nt-content').value,
        }),
      });
      tags();
      notice('Tag saved.');
    } catch (e) {
      notice(e.message, false);
    }
  };
}

// ---------- suggestions ----------

async function suggestions() {
  const rows = await api(`/api/guilds/${state.guild.id}/suggestions`);
  const statusLabel = { pending: '⏳ Pending', approved: '✅ Approved', denied: '❌ Denied', implemented: '🚀 Implemented' };
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>Suggestions</h3>
      <p class="muted">Latest 50 — status is managed with /suggest status in Discord.</p>
      <table>
        <tr><th>#</th><th>Suggestion</th><th>Status</th><th>Date</th></tr>
        ${rows
          .map(
            (s) => `<tr>
            <td>${s.id}</td><td>${esc(s.content.slice(0, 80))}${s.content.length > 80 ? '…' : ''}</td>
            <td>${statusLabel[s.status] ?? s.status}</td>
            <td>${new Date(s.created_at).toLocaleDateString()}</td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="4" class="muted">No suggestions yet.</td></tr>'}
      </table>
    </div>`;
}

// ---------- tickets ----------

function tickets() {
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <div class="inline-form">
        <div style="max-width:200px"><label>Status</label>
          <select id="tk-status">
            <option value="open">Open</option><option value="closed">Closed</option>
            <option value="all">All</option>
          </select></div>
        <button class="btn secondary" id="tk-refresh">Refresh</button>
      </div>
      <div id="tk-table" style="margin-top:14px"></div>
    </div>`;
  const load = async () => {
    const status = document.getElementById('tk-status').value;
    const rows = await api(`/api/guilds/${state.guild.id}/tickets?status=${status}`);
    document.getElementById('tk-table').innerHTML = `
      <table>
        <tr><th>#</th><th>Type</th><th>Owner</th><th>Status</th><th>Claimed by</th><th>Priority</th><th>Created</th></tr>
        ${rows
          .map(
            (t) => `<tr>
            <td>${String(t.number).padStart(4, '0')}</td><td>${esc(t.type)}</td>
            <td><code>${t.owner_id}</code></td>
            <td><span class="pill ${t.status}">${t.status}</span></td>
            <td>${t.claimed_by ? `<code>${t.claimed_by}</code>` : '—'}</td>
            <td>${t.priority}</td>
            <td>${new Date(t.created_at).toLocaleDateString()}</td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="7" class="muted">No tickets.</td></tr>'}
      </table>`;
  };
  document.getElementById('tk-refresh').onclick = load;
  document.getElementById('tk-status').onchange = load;
  load();
}

// ---------- blacklist ----------

async function blacklist() {
  const rows = await api(`/api/guilds/${state.guild.id}/blacklist`);
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>Ticket blacklist</h3>
      <p class="muted">These users cannot open tickets in this server. Also manageable via /blacklist.</p>
      <table>
        <tr><th>User ID</th><th>Reason</th><th></th></tr>
        ${rows
          .map(
            (b) => `<tr data-uid="${b.user_id}">
            <td><code>${b.user_id}</code></td><td>${esc(b.reason ?? '—')}</td>
            <td><button class="btn small danger bl-del">✕</button></td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="3" class="muted">Blacklist is empty.</td></tr>'}
      </table>
      <div class="inline-form">
        <div><label>User ID</label><input id="bl-id" placeholder="123456789012345678"></div>
        <div style="flex:2"><label>Reason</label><input id="bl-reason" placeholder="optional"></div>
        <button class="btn" id="bl-add">Blacklist</button>
      </div>
    </div>`;
  document.querySelectorAll('.bl-del').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/guilds/${state.guild.id}/blacklist/${b.closest('tr').dataset.uid}`, {
        method: 'DELETE',
      });
      blacklist();
      notice('Removed from blacklist.');
    };
  });
  document.getElementById('bl-add').onclick = async () => {
    try {
      await api(`/api/guilds/${state.guild.id}/blacklist`, {
        method: 'POST',
        body: JSON.stringify({
          user_id: document.getElementById('bl-id').value.trim(),
          reason: document.getElementById('bl-reason').value.trim() || null,
        }),
      });
      blacklist();
      notice('User blacklisted.');
    } catch (e) {
      notice(e.message, false);
    }
  };
}

// ---------- panel ----------

function panel() {
  const r = state.resources;
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>Post a ticket panel</h3>
      <p class="muted">Posts the panel message to a channel — same as /panel in Discord.</p>
      <label>Channel</label>
      <select id="p-chan">${r.textChannels
        .map((c) => `<option value="${c.id}">#${esc(c.name)}</option>`)
        .join('')}</select>
      <label>Style</label>
      <select id="p-style"><option value="select">Dropdown menu</option><option value="buttons">Buttons</option></select>
      <div style="margin-top:14px"><button class="btn" id="p-post">Post panel</button></div>
    </div>`;
  document.getElementById('p-post').onclick = async () => {
    try {
      await api(`/api/guilds/${state.guild.id}/panel`, {
        method: 'POST',
        body: JSON.stringify({
          channelId: document.getElementById('p-chan').value,
          style: document.getElementById('p-style').value,
        }),
      });
      notice('Panel posted to Discord.');
    } catch (e) {
      notice(e.message, false);
    }
  };
}

// ---------- forms ----------

async function forms() {
  const ts = state.overview.types;
  const cards = await Promise.all(
    ts.map(async (t) => ({
      t,
      fields: await api(`/api/guilds/${state.guild.id}/types/${t.type_id}/fields`),
    })),
  );
  document.getElementById('tab-body').innerHTML = `
    <p class="muted" style="margin-bottom:14px">Custom intake questions replace the default subject+description modal. Max 5 per type (Discord limit).</p>
    ${cards
      .map(
        ({ t, fields }) => `
      <div class="card" data-type="${esc(t.type_id)}">
        <h3>${esc(t.emoji ?? '')} ${esc(t.label)} <span class="muted">(${fields.length}/5)</span></h3>
        <table>
          ${fields
            .map(
              (f, n) => `<tr data-fid="${f.id}">
              <td><b>${n + 1}.</b> ${esc(f.question)}</td>
              <td class="muted">${f.style}${f.required ? ', required' : ''}</td>
              <td><button class="btn small danger ff-del">✕</button></td>
            </tr>`,
            )
            .join('') || '<tr><td class="muted">Default modal (subject + description)</td></tr>'}
        </table>
        <div class="inline-form">
          <div style="flex:3"><label>Question</label><input class="ff-q" placeholder="e.g. What is your order ID?"></div>
          <div><label>Style</label><select class="ff-style"><option value="short">Short</option><option value="paragraph">Paragraph</option></select></div>
          <div><label>Required</label><select class="ff-req"><option value="true">Yes</option><option value="false">No</option></select></div>
          <button class="btn ff-add">Add</button>
        </div>
      </div>`,
      )
      .join('')}`;

  document.querySelectorAll('.ff-add').forEach((b) => {
    b.onclick = async () => {
      const card = b.closest('.card');
      try {
        await api(`/api/guilds/${state.guild.id}/types/${card.dataset.type}/fields`, {
          method: 'POST',
          body: JSON.stringify({
            question: card.querySelector('.ff-q').value,
            style: card.querySelector('.ff-style').value,
            required: card.querySelector('.ff-req').value === 'true',
          }),
        });
        forms();
      } catch (e) {
        notice(e.message, false);
      }
    };
  });
  document.querySelectorAll('.ff-del').forEach((b) => {
    b.onclick = async () => {
      const card = b.closest('.card');
      await api(`/api/guilds/${state.guild.id}/types/${card.dataset.type}/fields/${b.closest('tr').dataset.fid}`, {
        method: 'DELETE',
      });
      forms();
    };
  });
}

// ---------- transcripts ----------

async function transcripts() {
  const rows = await api(`/api/guilds/${state.guild.id}/transcripts`);
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>Transcripts</h3>
      <p class="muted">HTML transcripts saved when tickets close or are deleted. Click to open.</p>
      <table>
        <tr><th>Ticket</th><th>Type</th><th>Owner</th><th>Status</th><th></th></tr>
        ${rows
          .map(
            (t) => `<tr>
            <td>#${String(t.number).padStart(4, '0')}</td>
            <td>${esc(t.type ?? '—')}</td>
            <td>${t.owner_id ? `<code>${t.owner_id}</code>` : '—'}</td>
            <td>${t.status ? `<span class="pill ${t.status}">${t.status}</span>` : '—'}</td>
            <td><a class="btn small" href="/api/guilds/${state.guild.id}/transcripts/${esc(t.file)}" target="_blank">Open ↗</a></td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="5" class="muted">No transcripts yet.</td></tr>'}
      </table>
    </div>`;
}

// ---------- giveaways ----------

async function giveaways() {
  const rows = await api(`/api/guilds/${state.guild.id}/giveaways`);
  const r = state.resources;
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>Giveaways</h3>
      <table>
        <tr><th>#</th><th>Prize</th><th>Entries</th><th>Winners</th><th>Ends</th><th>Status</th><th></th></tr>
        ${rows
          .map(
            (g) => `<tr data-gid="${g.id}">
            <td>${g.id}</td><td><b>${esc(g.prize)}</b></td>
            <td>${g.entries}</td><td>${g.winner_count}</td>
            <td>${g.ends_at ? new Date(g.ends_at).toLocaleString() : '—'}</td>
            <td><span class="pill ${g.closed ? 'closed' : 'open'}">${g.closed ? 'ended' : 'active'}</span></td>
            <td>${g.closed ? '' : '<button class="btn small danger gw-end">End</button>'}</td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="7" class="muted">No giveaways yet.</td></tr>'}
      </table>
      <h3 style="margin-top:16px">Start a giveaway</h3>
      <div class="inline-form">
        <div style="flex:2"><label>Prize</label><input id="gw-prize" placeholder="Nitro, role, …"></div>
        <div><label>Minutes</label><input id="gw-min" type="number" min="1" value="60"></div>
        <div><label>Winners</label><input id="gw-w" type="number" min="1" max="20" value="1"></div>
        <div><label>Channel</label><select id="gw-chan">${r.textChannels
          .map((c) => `<option value="${c.id}">#${esc(c.name)}</option>`)
          .join('')}</select></div>
        <button class="btn" id="gw-add">Create</button>
      </div>
    </div>`;
  document.querySelectorAll('.gw-end').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/guilds/${state.guild.id}/giveaways/${b.closest('tr').dataset.gid}/end`, {
        method: 'POST', body: '{}',
      });
      giveaways();
      notice('Giveaway ended.');
    };
  });
  document.getElementById('gw-add').onclick = async () => {
    try {
      await api(`/api/guilds/${state.guild.id}/giveaways`, {
        method: 'POST',
        body: JSON.stringify({
          prize: document.getElementById('gw-prize').value,
          minutes: Number(document.getElementById('gw-min').value),
          winners: Number(document.getElementById('gw-w').value),
          channelId: document.getElementById('gw-chan').value,
        }),
      });
      giveaways();
      notice('Giveaway posted.');
    } catch (e) {
      notice(e.message, false);
    }
  };
}

// ---------- reaction roles ----------

async function rroles() {
  const rows = await api(`/api/guilds/${state.guild.id}/reactionroles`);
  const r = state.resources;
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>Reaction roles</h3>
      <p class="muted">Reacting with the emoji on that message grants/removes the role.</p>
      <table>
        <tr><th>Message</th><th>Emoji</th><th>Role</th><th></th></tr>
        ${rows
          .map(
            (x) => `<tr data-mid="${x.message_id}" data-emoji="${esc(x.emoji)}">
            <td><code>${x.message_id}</code></td><td>${esc(x.emoji)}</td>
            <td><code>${x.role_id}</code></td>
            <td><button class="btn small danger rr-del">✕</button></td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="4" class="muted">No bindings yet.</td></tr>'}
      </table>
      <h3 style="margin-top:16px">Post a panel</h3>
      <div class="inline-form">
        <div><label>Channel</label><select id="rr-chan">${r.textChannels
          .map((c) => `<option value="${c.id}">#${esc(c.name)}</option>`)
          .join('')}</select></div>
        <div style="flex:2"><label>Title</label><input id="rr-title" placeholder="Pick your roles"></div>
        <button class="btn secondary" id="rr-panel">Post panel</button>
      </div>
      <h3 style="margin-top:16px">Bind emoji → role</h3>
      <div class="inline-form">
        <div><label>Message ID</label><input id="rr-mid" placeholder="right-click → Copy Message ID"></div>
        <div><label>Emoji</label><input id="rr-emoji" placeholder="👍 or <:name:id>"></div>
        <div><label>Role</label><select id="rr-role">${r.roles
          .map((x) => `<option value="${x.id}">${esc(x.name)}</option>`)
          .join('')}</select></div>
        <button class="btn" id="rr-bind">Bind</button>
      </div>
    </div>`;
  document.querySelectorAll('.rr-del').forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest('tr');
      await api(`/api/guilds/${state.guild.id}/reactionroles`, {
        method: 'DELETE',
        body: JSON.stringify({ messageId: tr.dataset.mid, emoji: tr.dataset.emoji }),
      });
      rroles();
    };
  });
  document.getElementById('rr-panel').onclick = async () => {
    try {
      const res = await api(`/api/guilds/${state.guild.id}/reactionroles/panel`, {
        method: 'POST',
        body: JSON.stringify({
          channelId: document.getElementById('rr-chan').value,
          title: document.getElementById('rr-title').value || 'Pick your roles',
        }),
      });
      document.getElementById('rr-mid').value = res.messageId;
      notice(`Panel posted — message ID ${res.messageId} filled in below.`);
    } catch (e) {
      notice(e.message, false);
    }
  };
  document.getElementById('rr-bind').onclick = async () => {
    try {
      await api(`/api/guilds/${state.guild.id}/reactionroles`, {
        method: 'POST',
        body: JSON.stringify({
          channelId: document.getElementById('rr-chan').value,
          messageId: document.getElementById('rr-mid').value.trim(),
          emoji: document.getElementById('rr-emoji').value.trim(),
          roleId: document.getElementById('rr-role').value,
        }),
      });
      rroles();
      notice('Binding saved — bot reacted on the message.');
    } catch (e) {
      notice(e.message, false);
    }
  };
}

// ---------- sticky ----------

async function sticky() {
  const rows = await api(`/api/guilds/${state.guild.id}/sticky`);
  const r = state.resources;
  const chanName = (id) => r.textChannels.find((c) => c.id === id)?.name ?? id;
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>Sticky messages</h3>
      <p class="muted">Re-pinned to the bottom of the channel after activity.</p>
      <table>
        <tr><th>Channel</th><th>Content</th><th></th></tr>
        ${rows
          .map(
            (s) => `<tr data-chan="${s.channel_id}">
            <td>#${esc(chanName(s.channel_id))}</td>
            <td>${esc(s.content.slice(0, 80))}${s.content.length > 80 ? '…' : ''}</td>
            <td><button class="btn small danger st-del">✕</button></td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="3" class="muted">No stickies.</td></tr>'}
      </table>
      <div class="inline-form">
        <div><label>Channel</label><select id="st-chan">${r.textChannels
          .map((c) => `<option value="${c.id}">#${esc(c.name)}</option>`)
          .join('')}</select></div>
        <div style="flex:3"><label>Message</label><input id="st-text" placeholder="Read the rules before posting!"></div>
        <button class="btn" id="st-add">Set sticky</button>
      </div>
    </div>`;
  document.querySelectorAll('.st-del').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/guilds/${state.guild.id}/sticky/${b.closest('tr').dataset.chan}`, {
        method: 'DELETE',
      });
      sticky();
    };
  });
  document.getElementById('st-add').onclick = async () => {
    try {
      await api(`/api/guilds/${state.guild.id}/sticky`, {
        method: 'POST',
        body: JSON.stringify({
          channelId: document.getElementById('st-chan').value,
          content: document.getElementById('st-text').value,
        }),
      });
      sticky();
      notice('Sticky posted.');
    } catch (e) {
      notice(e.message, false);
    }
  };
}

// ---------- automod ----------

async function automod() {
  const rows = await api(`/api/guilds/${state.guild.id}/automod`);
  const triggers = { 1: 'Keyword', 3: 'Spam', 4: 'Keyword preset', 5: 'Mention spam', 6: 'Member profile' };
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>AutoMod rules</h3>
      <p class="muted">Native Discord rules — create/manage them with <code>/automod</code> in Discord; toggle or delete here.</p>
      <table>
        <tr><th>Rule</th><th>Type</th><th>Status</th><th></th></tr>
        ${rows
          .map(
            (x) => `<tr data-rid="${x.id}">
            <td><b>${esc(x.name)}</b></td><td>${triggers[x.triggerType] ?? x.triggerType}</td>
            <td><span class="pill ${x.enabled ? 'open' : 'closed'}">${x.enabled ? 'enabled' : 'paused'}</span></td>
            <td>
              <button class="btn small secondary am-toggle">${x.enabled ? 'Pause' : 'Enable'}</button>
              <button class="btn small danger am-del">✕</button>
            </td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="4" class="muted">No rules — use /automod in Discord to create one.</td></tr>'}
      </table>
    </div>`;
  document.querySelectorAll('.am-toggle').forEach((b) => {
    b.onclick = async () => {
      const rid = b.closest('tr').dataset.rid;
      const enable = b.textContent === 'Enable';
      await api(`/api/guilds/${state.guild.id}/automod/${rid}`, {
        method: 'POST',
        body: JSON.stringify({ enabled: enable }),
      });
      automod();
    };
  });
  document.querySelectorAll('.am-del').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this AutoMod rule?')) return;
      await api(`/api/guilds/${state.guild.id}/automod/${b.closest('tr').dataset.rid}`, {
        method: 'DELETE',
      });
      automod();
    };
  });
}

// ---------- custom commands ----------

async function commands() {
  const rows = await api(`/api/guilds/${state.guild.id}/commands`);
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>Custom commands</h3>
      <p class="muted">Members run them with <code>/cmd run &lt;name&gt;</code>.</p>
      <table>
        <tr><th>Name</th><th>Response</th><th>Uses</th><th></th></tr>
        ${rows
          .map(
            (c) => `<tr data-name="${esc(c.name)}">
            <td><code>${esc(c.name)}</code></td>
            <td>${esc(c.response.slice(0, 70))}${c.response.length > 70 ? '…' : ''}</td>
            <td>${c.uses}</td>
            <td><button class="btn small danger cc-del">✕</button></td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="4" class="muted">No custom commands yet.</td></tr>'}
      </table>
      <div class="inline-form">
        <div><label>Name (a-z 0-9 - _)</label><input id="cc-name" placeholder="rules"></div>
        <div style="flex:3"><label>Response</label><input id="cc-resp" placeholder="Command reply text…"></div>
        <button class="btn" id="cc-add">Save</button>
      </div>
    </div>`;
  document.querySelectorAll('.cc-del').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/guilds/${state.guild.id}/commands/${encodeURIComponent(b.closest('tr').dataset.name)}`, {
        method: 'DELETE',
      });
      commands();
    };
  });
  document.getElementById('cc-add').onclick = async () => {
    try {
      await api(`/api/guilds/${state.guild.id}/commands`, {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('cc-name').value.trim(),
          response: document.getElementById('cc-resp').value,
        }),
      });
      commands();
      notice('Command saved.');
    } catch (e) {
      notice(e.message, false);
    }
  };
}

// ---------- audit ----------

async function audit() {
  const rows = await api(`/api/guilds/${state.guild.id}/audit`);
  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>Audit log</h3>
      <p class="muted">Administrative actions taken on this server via the dashboard.</p>
      <table>
        <tr><th>Actor</th><th>Action</th><th>Detail</th><th>When</th></tr>
        ${rows
          .map(
            (a) => `<tr>
            <td><code>${a.actor_id}</code></td>
            <td><b>${esc(a.action)}</b></td>
            <td>${esc(a.detail ?? '—')}</td>
            <td>${new Date(a.created_at).toLocaleString()}</td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="4" class="muted">No recorded actions yet.</td></tr>'}
      </table>
    </div>`;
}

// ---------- satellite (support funnel) ----------

async function satellite() {
  const gid = state.guild.id;
  const [self, hub] = await Promise.all([
    api(`/api/guilds/${gid}/satellite`),
    api(`/api/guilds/${gid}/satellites`),
  ]);
  const s = self.satellite;
  const watched = s?.channels ?? [];
  const chans = (state.resources?.textChannels ?? [])
    .map((c) => `<option value="${c.id}" ${watched.includes(c.id) ? 'selected' : ''}>#${esc(c.name)}</option>`)
    .join('');

  document.getElementById('tab-body').innerHTML = `
    <div class="card">
      <h3>🛰️ This server as a satellite</h3>
      <p class="muted">When members post support issues, the bot replies with the hub server's invite so they can open a ticket there. Keyword matching is instant; AI detection catches vague questions.</p>
      <div class="inline-form">
        <div style="flex:2"><label>Hub invite URL (discord.gg/…)</label>
          <input id="sat-invite" placeholder="https://discord.gg/your-hub" value="${esc(s?.hub_invite ?? '')}"></div>
        <div><label>Rate limit (min/user)</label>
          <input id="sat-rate" type="number" min="1" max="1440" value="${s?.rate_limit_minutes ?? 60}"></div>
      </div>
      <label>Watched channels <span class="muted">(empty = all channels — Ctrl/Cmd-click to multi-select)</span></label>
      <select id="sat-chans" multiple size="5">${chans}</select>
      <label style="margin-top:10px">Custom reply text <span class="muted">(invite appended automatically)</span></label>
      <input id="sat-reply" placeholder="Our support team handles this — open a ticket:" value="${esc(s?.reply_text ?? '')}">
      <div style="display:flex;gap:14px;margin-top:12px;flex-wrap:wrap;align-items:center">
        <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="sat-ai" ${s?.ai_enabled ? 'checked' : ''}> AI intent detection</label>
        <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="sat-on" ${s?.enabled ? 'checked' : ''}> Responder active</label>
        <button class="btn" id="sat-save">${s ? 'Save' : 'Link satellite'}</button>
        ${s ? '<button class="btn danger" id="sat-unlink">Unlink</button>' : ''}
      </div>
    </div>
    ${s ? `<div class="card">
      <h3>📨 Referrals sent (${self.referrals.length})</h3>
      <table>
        <tr><th>User</th><th>Channel</th><th>When</th><th>Joined hub</th></tr>
        ${self.referrals
          .map(
            (r) => `<tr>
            <td><code>${r.user_id}</code></td>
            <td>${r.channel_id ? `<#${r.channel_id}>` : '—'}</td>
            <td>${new Date(r.created_at).toLocaleString()}</td>
            <td>${r.converted_at ? `<span class="pill open">✓ ${new Date(r.converted_at).toLocaleDateString()}</span>` : '<span class="pill">—</span>'}</td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="4" class="muted">No referrals yet.</td></tr>'}
      </table>
    </div>` : ''}
    <div class="card">
      <h3>📥 Satellites routing INTO this server</h3>
      <p class="muted">Servers that linked this one as their support hub.</p>
      <table>
        <tr><th>Satellite server</th><th>Invite used</th><th>Status</th></tr>
        ${hub.satellites
          .map(
            (x) => `<tr>
            <td><code>${x.guild_id}</code></td>
            <td>${esc(x.hub_invite)}</td>
            <td><span class="pill ${x.enabled ? 'open' : 'closed'}">${x.enabled ? 'active' : 'paused'}</span></td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="3" class="muted">None yet — satellite admins link via /satellite or their dashboard.</td></tr>'}
      </table>
      <h3 style="margin-top:14px">Incoming referrals (${hub.referrals.length})</h3>
      <table>
        <tr><th>User</th><th>From server</th><th>Referred by</th><th>When</th><th>Ticket</th></tr>
        ${hub.referrals
          .map(
            (r) => `<tr>
            <td><code>${r.user_id}</code></td>
            <td><code>${r.satellite_guild_id}</code></td>
            <td>${r.referred_by ? `<@${r.referred_by}> <code class="muted">${r.referred_by}</code>` : '<span class="muted">auto-responder</span>'}</td>
            <td>${new Date(r.created_at).toLocaleString()}</td>
            <td>${r.ticket_id ? `#${r.ticket_id}` : '<span class="muted">—</span>'}</td>
          </tr>`,
          )
          .join('') || '<tr><td colspan="5" class="muted">No incoming referrals yet.</td></tr>'}
      </table>
    </div>`;

  const collectChans = () => [...document.getElementById('sat-chans').selectedOptions].map((o) => o.value);
  document.getElementById('sat-save').onclick = async () => {
    try {
      const res = await api(`/api/guilds/${gid}/satellite`, {
        method: 'POST',
        body: JSON.stringify({
          invite: document.getElementById('sat-invite').value.trim(),
          reply: document.getElementById('sat-reply').value.trim(),
          channels: collectChans(),
          ai_enabled: document.getElementById('sat-ai').checked,
          enabled: document.getElementById('sat-on').checked,
          rate_limit_minutes: Number(document.getElementById('sat-rate').value) || 60,
        }),
      });
      notice(res.hub ? `Linked → ${res.hub.name}` : 'Satellite settings saved.');
      satellite();
    } catch (e) {
      notice(e.message === 'invalid_invite' ? 'Invalid invite URL.' : e.message, false);
    }
  };
  document.getElementById('sat-unlink')?.addEventListener('click', async () => {
    if (!confirm('Remove satellite mode from this server?')) return;
    await api(`/api/guilds/${gid}/satellite`, { method: 'DELETE' });
    satellite();
  });
}

// ---------- coin discovery ----------

const STATUS_LABELS = { new: '🆕 new', contacted: '✉️ contacted', joined: '✅ joined', rejected: '❌ rejected' };

async function discover() {
  setGlobalNav('discover');
  app.innerHTML = `<div class="page"><span class="back" id="back">← Servers</span>
    <h2>🔍 Coin discovery</h2>
    <p class="muted">Trending coins from CoinGecko — find their Discord, pitch the bot, then track the outreach in the watchlist. Satellite mode takes over once the bot is in their server.</p>
    <div class="loading">Loading market data…</div>`;
  document.getElementById('back').onclick = renderGuilds;

  let d, hub;
  try {
    [d, hub] = await Promise.all([api('/api/discover'), api('/api/me/hub').catch(() => null)]);
  } catch {
    app.innerHTML += '<div class="card"><p class="muted">CoinGecko is rate-limited or unavailable — try again in a minute.</p></div>';
    return;
  }

  const pct = (v) =>
    v == null ? '—' : `<span style="color:${v >= 0 ? 'var(--green, #3ba55d)' : '#ed4245'}">${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%</span>`;
  const watchedIds = new Set((d.watchlist ?? []).map((w) => w.coin_id));
  const coinRow = (c) => `<tr data-coin="${c.id}" data-name="${esc(c.name)}" data-sym="${esc(c.symbol)}">
    <td style="white-space:nowrap">${c.thumb ? `<img src="${c.thumb}" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:6px">` : ''}<b>${esc(c.name)}</b> <span class="muted">${esc((c.symbol ?? '').toUpperCase())}</span></td>
    <td>${c.rank ? `#${c.rank}` : '—'}</td>
    <td>${pct(c.change)}</td>
    <td>${c.price != null ? '$' + Number(c.price).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'}</td>
    <td class="dc-cell muted">—</td>
    <td style="white-space:nowrap">
      <button class="btn small secondary dc-find">Discord?</button>
      ${watchedIds.has(c.id) ? '<button class="btn small secondary" disabled>✓ Watching</button>' : '<button class="btn small wl-add">+ Watch</button>'}
    </td>
  </tr>`;
  const section = (title, rows) => `
    <div class="card"><h3>${title}</h3>
      <table><tr><th>Coin</th><th>Rank</th><th>24h</th><th>Price</th><th>Discord</th><th></th></tr>${rows}</table>
    </div>`;

  app.innerHTML = `<div class="page"><span class="back" id="back">← Servers</span>
    <h2>🔍 Coin discovery</h2>
    <div class="card">
      <h3>🎯 My support hub</h3>
      <p class="muted">Where <b>Route to Support</b> (right-click any message → Apps) sends people — <b>your</b> server, not a global one. Pick a server you admin that has the bot installed, or paste an invite directly.</p>
      <div class="inline-form">
        <div style="flex:1"><select id="hub-guild"><option value="">— pick your hub server —</option>${(state.me.hubGuilds ?? state.me.guilds?.filter((g) => g.hasBot) ?? []).map((g) => `<option value="${g.id}" ${hub?.hub_guild_id === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
        <div style="flex:2"><input id="hub-invite" placeholder="https://discord.gg/your-hub (auto-generated if empty)" value="${esc(hub?.hub_invite ?? '')}"></div>
        <button class="btn" id="hub-save">Save</button>
      </div>
      <p class="muted" id="hub-status" style="margin-top:8px">${hub?.hub_invite ? `Active — routes to <b>${esc(hub.hub_name ?? 'your hub')}</b>: <a href="${esc(hub.hub_invite)}" target="_blank" style="color:var(--accent)">${esc(hub.hub_invite)}</a>` : `Not set${hub?.platform_default ? ' — falling back to the platform default invite' : ''}`}</p>
      <p class="muted" style="margin-top:8px">👉 First time? <a href="https://discord.com/oauth2/authorize?client_id=${state.me.clientId}&integration_type=1&scope=applications.commands" target="_blank" style="color:var(--accent)"><b>Install the app to your Discord account</b></a> — one click, then right-click any member's message in any server → Apps → <b>Route to Support</b>.</p>
      <div class="inline-form" style="margin-top:10px">
        <button class="btn secondary" id="hub-copy" ${hub?.hub_invite ? '' : 'disabled'}>📋 Copy my invite</button>
        <div style="flex:1"><select id="hub-post-guild"><option value="">— post invite to a server —</option>${(state.me.guilds ?? []).filter((g) => g.hasBot).map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></div>
        <div style="flex:1"><select id="hub-post-chan" disabled><option value="">pick a channel…</option></select></div>
        <button class="btn" id="hub-post" disabled>Send</button>
      </div>
    </div>
    <div class="card">
      <h3>➕ Add a coin server by invite</h3>
      <p class="muted">Paste a coin project's Discord invite. The bot previews the server (it doesn't join) — if you or their admins authorize it via the link below, satellite mode arms itself automatically.</p>
      <div class="inline-form">
        <div style="flex:2"><input id="srv-invite" placeholder="https://discord.gg/coinserver"></div>
        <button class="btn" id="srv-add">Track server</button>
      </div>
      <div id="srv-result" style="margin-top:10px"></div>
    </div>
    ${section('🔥 Trending', (d.trending ?? []).map(coinRow).join(''))}
    ${section('📈 Top gainers (24h)', (d.gainers ?? []).map(coinRow).join(''))}
    ${section('🆕 New listings', (d.newListings ?? []).map(coinRow).join(''))}
    <div class="card" id="wl-card"><h3>📋 Outreach watchlist (<span id="wl-count">${d.watchlist.length}</span>)${state.me.isOwner ? ' <span class="muted">— godmode: all users\' entries</span>' : ''}</h3>
      <p class="muted">Your outreach pipeline: <b>watch</b> a coin → <b>find its Discord</b> → get their admins to authorize the bot (or do it yourself if you're admin) → mark the <b>status</b>. When the bot lands in the server, satellite mode auto-arms and starts routing support questions to your hub.</p>
      <table><tr><th>Coin</th><th>Discord</th><th>Status</th><th>Notes</th>${state.me.isOwner ? '<th>Added by</th>' : ''}<th></th></tr><tbody id="wl-body"></tbody></table>
      <p class="muted" style="margin-top:10px"><b>join ↗</b> opens the invite in Discord (you complete any verification yourself); <b>1-click join</b> adds your account via OAuth once the bot is installed there.</p>
    </div></div>`;
  const wlRow = (w) => `<tr data-wid="${w.id}">
      <td><b>${esc(w.name ?? w.coin_id)}</b> <span class="muted">${esc((w.symbol ?? '').toUpperCase())}</span></td>
      <td style="white-space:nowrap">${w.discord_url ? `<a href="${esc(w.discord_url)}" target="_blank" style="color:var(--accent)">join ↗</a>` : '<span class="muted">—</span>'}${w.guild_id && w.status === 'joined' ? ` <button class="btn small secondary wl-join" data-g="${w.guild_id}" title="One-click join via OAuth">1-click join</button>` : ''}</td>
      <td><select class="wl-status">${Object.entries(STATUS_LABELS)
        .map(([v, l]) => `<option value="${v}" ${w.status === v ? 'selected' : ''}>${l}</option>`)
        .join('')}</select></td>
      <td><input class="wl-notes" value="${esc(w.notes ?? '')}" placeholder="notes…"></td>
      ${state.me.isOwner ? `<td><code>${w.added_by}</code></td>` : ''}
      <td><button class="btn small danger wl-del">✕</button></td>
    </tr>`;
  const bindWatchlistHandlers = () => {
    document.querySelectorAll('.wl-status').forEach((el) => {
      el.onchange = async () => {
        await api(`/api/watchlist/${el.closest('tr').dataset.wid}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: el.value }),
        });
        notice('Status updated.');
      };
    });
    document.querySelectorAll('.wl-notes').forEach((el) => {
      el.onchange = async () => {
        await api(`/api/watchlist/${el.closest('tr').dataset.wid}`, {
          method: 'PATCH',
          body: JSON.stringify({ notes: el.value }),
        });
      };
    });
    document.querySelectorAll('.wl-join').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/api/join/${b.dataset.g}`, { method: 'POST', body: '{}' });
          notice('Joined — check your Discord server list.');
        } catch (e) {
          notice(e.message === 'relogin' ? 'Log out and back in first — the join permission was added to OAuth.' : e.message, false);
        }
      };
    });
    document.querySelectorAll('.wl-del').forEach((b) => {
      b.onclick = async () => {
        await api(`/api/watchlist/${b.closest('tr').dataset.wid}`, { method: 'DELETE' });
        renderWatchlist(await api('/api/watchlist'));
      };
    });
  };
  const renderWatchlist = (items) => {
    document.getElementById('wl-count').textContent = items.length;
    document.getElementById('wl-body').innerHTML =
      items.map(wlRow).join('') ||
      '<tr><td colspan="6" class="muted">Watchlist is empty — click "+ Watch" on any coin above, or paste a server invite at the top.</td></tr>';
    bindWatchlistHandlers();
  };
  renderWatchlist(d.watchlist);
  document.getElementById('back').onclick = renderGuilds;

  document.getElementById('hub-save').onclick = async () => {
    const b = document.getElementById('hub-save');
    b.disabled = true;
    try {
      const r = await api('/api/me/hub', {
        method: 'PUT',
        body: JSON.stringify({
          hub_guild_id: document.getElementById('hub-guild').value,
          hub_invite: document.getElementById('hub-invite').value.trim(),
        }),
      });
      document.getElementById('hub-invite').value = r.hub_invite ?? '';
      document.getElementById('hub-status').innerHTML =
        `Saved — <b>Route to Support</b> now routes to ${esc(r.hub_invite)}. Referral conversions are tracked${r.hub_guild_id ? '' : ' once you pick a hub server'}.`;
      notice('Support hub saved.');
    } catch (e) {
      notice(e.message === 'bot_not_in_guild' ? 'Invite the bot to that server first.' : `Save failed: ${e.message}`, false);
    } finally {
      b.disabled = false;
    }
  };

  document.getElementById('hub-copy').onclick = async () => {
    const inv = document.getElementById('hub-invite').value.trim();
    if (!inv) return notice('Save your hub first.', false);
    await navigator.clipboard.writeText(inv);
    notice('Invite copied.');
  };
  document.getElementById('hub-post-guild').onchange = async (e) => {
    const sel = document.getElementById('hub-post-chan');
    document.getElementById('hub-post').disabled = true;
    if (!e.target.value) {
      sel.innerHTML = '<option value="">pick a channel…</option>';
      sel.disabled = true;
      return;
    }
    const r = await api(`/api/guilds/${e.target.value}/resources`).catch(() => null);
    sel.innerHTML =
      (r?.textChannels ?? []).map((c) => `<option value="${c.id}">#${esc(c.name)}</option>`).join('') ||
      '<option value="">no channels</option>';
    sel.disabled = !r?.textChannels?.length;
  };
  document.getElementById('hub-post-chan').onchange = (e) => {
    document.getElementById('hub-post').disabled = !e.target.value;
  };
  document.getElementById('hub-post').onclick = async () => {
    try {
      await api(`/api/guilds/${document.getElementById('hub-post-guild').value}/post-invite`, {
        method: 'POST',
        body: JSON.stringify({ channel_id: document.getElementById('hub-post-chan').value }),
      });
      notice('Hub invite posted.');
    } catch (e) {
      notice(e.message === 'no_hub' ? 'Save your support hub first.' : `Failed: ${e.message}`, false);
    }
  };

  document.getElementById('srv-add').onclick = async () => {
    const el = document.getElementById('srv-result');
    el.innerHTML = '<span class="muted">Checking invite…</span>';
    try {
      const r = await api('/api/watchlist/invite', {
        method: 'POST',
        body: JSON.stringify({ invite: document.getElementById('srv-invite').value.trim() }),
      });
      el.innerHTML = r.installed
        ? `<span class="pill open">✅ Bot is already in <b>${esc(r.guild.name)}</b></span> — open its dashboard → Satellite tab to link your hub.`
        : `Tracked <b>${esc(r.guild.name)}</b>${r.guild.members ? ` (${r.guild.members.toLocaleString()} members)` : ''}. ` +
          `Authorize the bot there (needs Manage Server — share this with their admins): ` +
          `<a href="${r.authUrl}" target="_blank" style="color:var(--accent)">authorize ↗</a> — once it lands, satellite mode auto-arms.`;
    } catch (e) {
      el.innerHTML = `<span class="pill closed">${esc(e.message === 'invalid_invite' ? 'Invalid or expired invite' : e.message)}</span>`;
    }
  };

  document.querySelectorAll('.dc-find').forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest('tr');
      const cell = tr.querySelector('.dc-cell');
      cell.textContent = '…';
      try {
        const r = await api(`/api/discover/discord/${tr.dataset.coin}`);
        cell.innerHTML = r.discord
          ? `<a href="${esc(r.discord)}" target="_blank" style="color:var(--accent)">found ↗</a>`
          : '<span class="muted">none listed</span>';
        if (r.discord) tr.dataset.dc = r.discord;
      } catch {
        cell.textContent = 'error';
      }
    };
  });
  document.querySelectorAll('.wl-add').forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest('tr');
      b.disabled = true;
      b.textContent = '…';
      try {
        await api('/api/watchlist', {
          method: 'POST',
          body: JSON.stringify({
            coin_id: tr.dataset.coin, name: tr.dataset.name,
            symbol: tr.dataset.sym, discord_url: tr.dataset.dc ?? null,
          }),
        });
        b.outerHTML = '<button class="btn small secondary" disabled>✓ Watching</button>';
        renderWatchlist(await api('/api/watchlist'));
        document.getElementById('wl-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
        notice(`${tr.dataset.name} added to your watchlist — track outreach below.`);
      } catch (e) {
        b.disabled = false;
        b.textContent = '+ Watch';
        notice(e.message, false);
      }
    };
  });
}

async function reloadOverview(tab) {
  state.overview = await api(`/api/guilds/${state.guild.id}/overview`);
  state.tab = tab;
  renderGuild();
}

async function boot() {
  try {
    state.me = await api('/api/me');
  } catch {
    return; // renderLogin already ran
  }
  state.csrf = state.me.csrf;
  renderUserChip();
  renderGuilds();
}

boot();
