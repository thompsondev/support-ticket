// Smoke: satellite/referral/watchlist DB + responder intent + ai fallback
// leave DATABASE_URL as-is — caller decides sqlite (unset) vs pg (set)
const db = await import('./src/db');
const sat = await import('./src/satellites');
const ai = await import('./src/ai');

const SAT = '900001', HUB = '900002', USER = 'u1';
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); };

// --- satellites CRUD ---
await db.setSatellite(SAT, HUB, 'https://discord.gg/hub', { channels: ['c1', 'c2'], reply_text: 'custom reply', rate_limit_minutes: 30 });
let s = await db.getSatellite(SAT);
ok('setSatellite/getSatellite', s?.hub_guild_id === HUB && s.enabled === 1 && s.rate_limit_minutes === 30);
ok('channels json', JSON.parse(s!.channels).length === 2);
await db.updateSatellite(SAT, { enabled: 0, channels: ['c1'] });
s = await db.getSatellite(SAT);
ok('updateSatellite', s?.enabled === 0 && JSON.parse(s!.channels)[0] === 'c1');
ok('listSatellites', (await db.listSatellites()).some((x) => x.guild_id === SAT));

// --- referrals lifecycle ---
const rid = await db.addReferral(SAT, USER, 'c1', 'm1');
ok('addReferral id', rid > 0);
ok('getOpenReferral', (await db.getOpenReferral(USER))?.satellite_guild_id === SAT);
// not converted yet: user joins a different guild — no match
ok('convertReferral wrong hub', !(await db.convertReferral(USER, '999')));
const conv = await db.convertReferral(USER, HUB);
ok('convertReferral hub match', conv?.satellite_guild_id === SAT);
ok('open referral cleared', !(await db.getOpenReferral(USER)));
await db.linkReferralTicket(USER, 42);
const refs = await db.referralsForGuild(SAT);
ok('referralsForGuild ticket linked', refs[0]?.ticket_id === 42 && !!refs[0]?.converted_at);
ok('referralsForHub', (await db.referralsForHub(HUB))[0]?.user_id === USER);

// --- watchlist ---
const wid = await db.addWatch(USER, 'bitcoin', 'BTC', 'Bitcoin', 'https://discord.gg/btc');
ok('addWatch', wid > 0);
ok('listWatch', (await db.listWatch()).some((w) => w.coin_id === 'bitcoin'));
ok('updateWatch status', await db.updateWatch(wid, { status: 'contacted', notes: 'dm sent' }));
ok('removeWatch', await db.removeWatch(wid));
ok('updateSatellite disabled removes nothing', (await db.getSatellite(SAT)) !== undefined);
ok('removeSatellite', await db.removeSatellite(SAT));

// --- responder intent (AI disabled → keyword path only) ---
ok('ai disabled without keys', !ai.aiEnabled());
const kwSat = { ai_enabled: 1 }; // ai_enabled on but gateway unconfigured → keyword path
ok('keyword: complaint', await sat.isSupportMessage(kwSat, 'my transaction failed and i cant claim', 'test'));
ok('keyword: question', await sat.isSupportMessage(kwSat, 'how do i migrate my tokens?', 'test'));
ok('negative: chatter', !(await sat.isSupportMessage(kwSat, 'gm everyone, price to the moon', 'test')));
ok('negative: too short', !(await sat.isSupportMessage(kwSat, 'lol', 'test')));

// reply text: default template + invite appended
const txt = await sat.satelliteReplyText(
  { hub_invite: 'https://discord.gg/hub', reply_text: null, ai_enabled: 0 },
  'help me',
  'test',
);
ok('reply contains invite', txt.includes('https://discord.gg/hub'));

console.log(`\n${pass} passed, ${fail} failed — driver: ${db.DB_KIND}`);
process.exit(fail ? 1 : 0);
