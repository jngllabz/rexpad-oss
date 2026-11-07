// Hostile HTTP testing of the launch route's NEW surface — the four fee fields and the Advanced
// controls — plus the injection and resource-exhaustion shapes a public form invites.
// Run against a SIM server with the gate off:
//   DATA_DIR=/tmp/rexqa SIM=1 PORT=8787 LAUNCH_HOLD_USD=0 node server.mjs
//   node tools/api_adversarial.mjs http://127.0.0.1:8787
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

async function raw(path, body, H = {}) {
  const r = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...H },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
const freshWallet = async () => {
  const a = await raw('/api/auth/demo', {});
  const H = { authorization: 'Bearer ' + a.body.token };
  await raw('/api/faucet', {}, H);
  return { H, wallet: a.body.wallet };
};
let n = 0;
const launch = async (extra, H) => raw('/api/tokens', { name: 'Adv ' + (++n), symbol: 'AD' + n, image: PNG, quote: 'SOL', fairOpenSecs: 0, holderBps: 200, creatorBps: 100, vaultBps: 100, burnBps: 0, ...extra }, H || (await freshWallet()).H);

console.log('\n── the fee fields reject every shape that is not a legal mix');
{
  // The invariant is not "every odd value is refused" — a missing field SHOULD fall back to the 1%
  // minimum, and JS parses "  200  " and even "0x64" to a number. What must hold is that anything
  // accepted is stored as a mix the contract would also accept.
  const junk = [null, 'abc', '1e999', NaN, -50, 10_000, 1e308, [], {}, true, '  200  ', '0x64'];
  for (const v of junk) {
    const r = await launch({ holderBps: v });
    if (r.status !== 200) { ok(true, `holderBps ${JSON.stringify(v)} → ${r.status} "${(r.body?.error || '').slice(0, 44)}"`); continue; }
    const f = (await raw(`/api/tokens/${r.body.token.mint}`)).body.token.fees;
    const legal = f.holderBps >= 100 && f.holderBps <= 300 && f.holderBps % 50 === 0
      && f.creatorBps <= 100 && f.vaultBps <= 100 && f.burnBps <= 100 && f.totalBps <= 400;
    ok(legal, `holderBps ${JSON.stringify(v)} → accepted, and stored as a legal ${f.holderBps / 100}/${f.creatorBps / 100}/${f.vaultBps / 100}/${f.burnBps / 100} (${f.totalBps / 100}%)`);
  }
  for (const [field, v] of [['creatorBps', 150], ['vaultBps', 250], ['burnBps', 150]]) {
    const r = await launch({ [field]: v, holderBps: 100, creatorBps: 0, vaultBps: 0, burnBps: 0, ...{ [field]: v } });
    ok(r.status === 400 && /ceiling/i.test(r.body?.error || ''), `${field} ${v / 100}% → 400 "${r.body?.error}"`);
  }
  const over = await launch({ holderBps: 300, creatorBps: 100, vaultBps: 100, burnBps: 100 });
  ok(over.status === 400 && /ceiling/.test(over.body.error || ''), `a 6% sum → 400 "${over.body.error}"`);
}

console.log('\n── the allowlist is a wallet list, not a free-text field');
{
  const xss = '<script>alert(1)</script>';
  const sqli = "'; DROP TABLE tokens; --";
  const r = await launch({ fairOpenSecs: 60, allowlist: `${xss}\n${sqli}\n11111111111111111111111111111111` });
  ok(r.status === 200, 'a launch with junk in the allowlist still succeeds');
  const d = await raw(`/api/tokens/${r.body.token.mint}`);
  ok(d.status === 200, 'and its page loads');
  const still = await raw('/api/health');
  ok(still.body?.ok === true && still.body.tokens > 0, 'the tokens table survived the SQL in the allowlist');
  // the stored list must contain only base58 wallets
  const feed = await raw('/api/tokens?limit=60');
  ok(!JSON.stringify(feed.body).includes('<script'), 'no script tag is echoed anywhere in the token feed');
  ok(!JSON.stringify(feed.body).includes('DROP TABLE'), 'and no SQL fragment survives into the API payload');
}

console.log('\n── oversized and absurd Advanced input');
{
  const huge = Array.from({ length: 5000 }, () => '11111111111111111111111111111111').join('\n');
  const r = await launch({ fairOpenSecs: 60, allowlist: huge });
  ok(r.status === 200 || r.status === 413, `a 5,000-wallet allowlist is handled (${r.status})`);
  for (const [k, v] of [['walletCap', 99], ['walletCap', -5], ['decayFeeBps', 99_999], ['decayFeeBps', -1], ['allowRexUsd', -1e9], ['decayTo', 'creator']]) {
    const x = await launch({ fairOpenSecs: 60, [k]: v });
    ok(x.status === 200, `${k}=${JSON.stringify(v)} is clamped rather than refused or crashing (${x.status})`);
    if (x.status === 200) {
      const t = (await raw(`/api/tokens/${x.body.token.mint}`)).body.token;
      if (k === 'walletCap') ok(!t.guard || t.guard.capPct <= 5, `  and the stored cap stays sane (${t.guard?.capPct ?? 0}%)`);
      if (k === 'decayFeeBps') ok(!t.guard || t.guard.decayBps <= 500, `  and the decaying fee stays under its ceiling (${t.guard?.decayBps ?? 0} bps)`);
      if (k === 'decayTo') ok(!t.guard || t.guard.to !== 'creator', '  and a decaying fee can never be routed to the dev');
    }
  }
}

console.log('\n── the guard never reports more than was configured');
{
  const r = await launch({ fairOpenSecs: 300, decayFeeBps: 100, walletCap: 0.01 });
  const t = (await raw(`/api/tokens/${r.body.token.mint}`)).body.token;
  ok(!t.guard || (t.guard.decayBps <= 100 && t.guard.secsLeft <= 60),
    `inside a 5-minute open the guard still reads <= its own settings (${t.guard ? t.guard.decayBps + 'bps / ' + t.guard.secsLeft + 's' : 'inactive'})`);
}

console.log('\n── the quote asset must be one we actually list');
{
  // XRP earns its place on this list: it is the one alt Elio asked for that is NOT on Jupiter's
  // verified list, and a DexScreener search for it returns clones claiming $1.5B of liquidity
  // against $300K of volume. It must stay unlaunchable until a mint we trust exists.
  for (const q of ['XRP', '', null, 'SOL ', 'sol', '../../etc/passwd']) {
    const r = await launch({ quote: q });
    ok(r.status === 400, `quote ${JSON.stringify(q)} → 400 "${(r.body?.error || '').slice(0, 40)}"`);
  }
  for (const q of ['SOL', 'REX', 'USDC', 'GP', 'STONK', 'NVDAx', 'ZEC', 'DOGE']) {
    const r = await launch({ quote: q });
    ok(r.status === 200, `quote ${q} launches`);
  }
}

console.log('\n── a trade cannot be talked into a bad state');
{
  const { H } = await freshWallet();
  const t = (await launch({}, H)).body.token;
  for (const amt of [0, -1, 'abc', null, 1e308, '1e999']) {
    const r = await raw('/api/trade', { mint: t.mint, side: 'buy', amount: amt }, H);
    ok(r.status >= 400, `a ${JSON.stringify(amt)} buy → ${r.status}`);
  }
  const sell = await raw('/api/trade', { mint: t.mint, side: 'sell', amount: 1e12 }, H);
  ok(sell.status >= 400 || (sell.body?.trade && sell.body.trade.tokens >= 0), 'an oversized sell clamps or refuses — it never goes negative');
  const after = (await raw(`/api/tokens/${t.mint}`)).body.token;
  ok(after.price > 0 && after.mcapUsd >= 0, 'the pair is still priced sanely afterwards');
}

console.log('\n── the fee ceilings the client is given match the ones the server enforces');
{
  const st = (await raw('/api/state')).body;
  const f = st.fees;
  ok(f && f.capBps === 500 && f.holderMinBps === 100 && f.holderMaxBps === 300 && f.sideMaxBps === 100 && f.vaultMaxBps === 200 && f.stepBps === 50,
    `the served ceilings match the architecture (${f?.holderMinBps}-${f?.holderMaxBps} holders, ${f?.sideMaxBps} sides, ${f?.vaultMaxBps} vault, ${f?.capBps} ceiling, ${f?.stepBps} step)`);
  // anything the served ceilings call legal, the server must accept
  for (let h = f.holderMinBps; h <= f.holderMaxBps; h += f.stepBps) {
    const room = f.capBps - h;
    const side = Math.min(f.sideMaxBps, Math.max(0, Math.floor(room / f.stepBps / 3) * f.stepBps));
    const r = await launch({ holderBps: h, creatorBps: side, vaultBps: side, burnBps: side });
    ok(r.status === 200, `the UI's own ${h / 100}/${side / 100}/${side / 100}/${side / 100} is accepted by the server`);
  }
  ok(JSON.stringify(st.fairOpenChoices) === '[0,60,120,300]' && st.fairOpenDefault === 60, 'and the window choices served match the spec');
}

console.log('\n── every pair the launch screen offers must be tradeable end to end in the demo');
{
  const st = (await raw('/api/state')).body;
  for (const q of st.quotes) {
    const { H } = await freshWallet();
    const bal = (await raw('/api/state', undefined, H)).body?.me?.balances;
    const r = await launch({ quote: q.symbol, fairOpenSecs: 0 }, H);
    if (r.status !== 200) { ok(false, `${q.symbol}: launch failed — ${r.body?.error}`); continue; }
    const mint = r.body.token.mint;
    // a buy and a sell, through the same route the UI uses
    const b = await raw('/api/trade', { mint, side: 'buy', amount: (bal?.[q.symbol] || 0) * 0.1 }, H);
    if (b.status !== 200) { ok(false, `${q.symbol}: a buy failed — ${b.body?.error} (balance ${bal?.[q.symbol]})`); continue; }
    await new Promise((r) => setTimeout(r, 300));   // the trade route throttles a wallet to ~4/s
    const s2 = await raw('/api/trade', { mint, side: 'sell', amount: b.body.trade.tokens / 2 }, H);
    const t = (await raw(`/api/tokens/${mint}`)).body.token;
    ok(s2.status === 200 && t.buckets.holderPot > 0 && t.buckets.vaultPot > 0,
      `${q.symbol}: launch → buy → sell, buckets filled — sell ${s2.status}${s2.status !== 200 ? ' "' + (s2.body?.error || '') + '"' : ''}, holders ${t.buckets.holderPot.toPrecision(3)}, vault ${Number(t.buckets.vaultPot).toPrecision(3)}, creator ${Number(t.buckets.creatorPot).toPrecision(3)}`);
  }
}

// ---------------------------------------------------------------- profiles
// A profile is the one thing on this site that is pure user-supplied text shown to other people, so
// it is the one most worth attacking: impersonation, stored XSS, and wearing a badge you do not own.
{
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const { H, wallet } = await freshWallet();
  const post = async (b, hh = H) => { const r = await raw('/api/me/profile', b, hh); return r; };

  let p = (await raw('/api/me/profile', undefined, H)).body.profile;
  ok(p.setup === false, 'PR1 a wallet that has never saved a profile reports setup=false');

  p = (await post({ name: 'advr' + Math.random().toString(36).slice(2, 6), bio: 'hi', x: 'https://x.com/someone' })).body.profile;
  ok(p.setup === true, 'PR2 saving one flips setup, so the welcome screen never shows twice');
  ok(p.x === 'someone', 'PR3 a pasted profile URL is stored as the handle, not as a link');

  await nap(2100);
  const name = p.name;
  p = (await post({ bio: 'only the bio' })).body.profile;
  ok(p.name === name && p.x === 'someone', 'PR4 a partial update leaves the fields it did not send alone');

  await nap(2100);
  // Markup is stored verbatim ON PURPOSE and escaped at render, which is the correct place for it —
  // stripping at input would also eat a legitimate "a > b" or "<3". What must never survive is a
  // control character, which can break out of a context escaping does not cover.
  p = (await post({ bio: 'a > b <img src=x onerror=alert(1)>\u0000\u001b[31m' })).body.profile;
  ok(!/[\x00-\x1f\x7f]/.test(p.bio), 'PR5 a bio carries no control characters');
  ok(p.bio.includes('a > b'), 'PR5b and ordinary punctuation survives, because escaping happens at render');

  await nap(2100);
  p = (await post({ website: 'javascript:alert(1)' })).body.profile;
  ok(p.website === '', 'PR6 a javascript: website is refused, not stored');

  await nap(2100);
  // The random part goes FIRST: the clamp keeps the first 16 characters, so a suffix would be cut
  // off and every run would fight over the same handle.
  p = (await post({ name: Math.random().toString(36).slice(2, 8) + 'z'.repeat(80) + '!!<>' })).body.profile;
  ok(p.name.length <= 16 && /^[A-Za-z0-9_]*$/.test(p.name), 'PR7 a handle is clamped to 16 safe characters');

  const { H: H2 } = await freshWallet();
  // Read the handle as it stands NOW — the checks above renamed this wallet, and the handle it used
  // to hold is genuinely free again.
  const held = (await raw('/api/me/profile', undefined, H)).body.profile.name;
  ok((await post({ name: held.toUpperCase() }, H2)).status === 400, 'PR8 a handle cannot be taken from someone else by changing its case');

  await nap(2100);
  ok((await post({ avatarNft: wallet }, H2)).status === 400, 'PR9 an NFT profile picture is refused unless the wallet verifiably holds it');

  ok((await raw('/api/me/profile', { name: 'nope' })).status === 401, 'PR10 a profile cannot be written without signing in');

  const pub = (await raw(`/api/profile/${wallet}`, undefined)).body;
  ok(pub.balances === undefined && pub.bids === undefined, 'PR11 a public profile does not leak balances or bids');
  ok(pub.name === p.name, 'PR12 and does show the handle');

  // Reading a wallet needs no session — that is the point of the lookup. Owning one still does.
  ok(pub.points && typeof pub.points.total === 'number', 'PR13 an unauthenticated reader gets the points');
  ok(pub.record && 'neverSold' in pub.record, 'PR14 and the hold record');
  ok(pub.mine === false, 'PR15 and is told it is not their wallet, which is what offers the claim');
  const asOwner = (await raw(`/api/profile/${wallet}`, undefined, H)).body;
  ok(asOwner.mine === true, 'PR16 while the owner viewing it is told it IS theirs');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
