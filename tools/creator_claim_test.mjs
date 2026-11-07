// ⛔ A MONEY FIGURE A CALLER SUPPLIES IS A MONEY FIGURE A CALLER CAN INVENT.
//
// /api/chain/creator/claimed used to record `body.amount` verbatim. STNKOG's dashboard therefore
// reported 344.69 STONK of creator fees claimed against the 0.345 that actually moved — the figure
// was computed in a browser holding the quote at 6 decimals when the mint says 9.
//
// Nothing stopped a caller posting any number at all, either. The signature names a transaction
// whose own balance deltas say what the creator received, so there is no reason to accept a figure.
//
//   node tools/creator_claim_test.mjs [base-url]
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const post = async (body) => {
  const r = await fetch(`${BASE}/api/chain/creator/claimed`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { /* empty body is a fine answer to assert on */ }
  return { status: r.status, j };
};

console.log('── however it is called, no caller-supplied figure is ever recorded');
{
  // ⛔ BE HONEST ABOUT WHAT THIS PROVES. With SIM=1 the chain routes are refused before the handler
  // runs, so these only establish that an invented amount never comes back as recorded — the real
  // check on the handler's behaviour is the source assertions below, which do not need a chain.
  const a = await post({ wallet: 'x', mint: 'nope', amount: 999_999_999 });
  ok(a.status !== 200, `an amount with no signature does not succeed (${a.status})`);
  ok(!/999999999/.test(JSON.stringify(a.j || {})), 'and the invented figure is never echoed as recorded');
  for (const sig of ['', 'short', 'not-a-signature', '0'.repeat(88)]) {
    const r = await post({ wallet: 'x', mint: 'nope', sig, amount: 123456 });
    ok(r.status !== 200, `nor alongside a bad signature ${JSON.stringify(sig.slice(0, 10))} (${r.status})`);
  }
}

console.log('\n── the server source no longer reads an amount off the body');
{
  const fs = await import('node:fs');
  const src = (await import('node:fs')).readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const i = src.indexOf("sub === 'creator/claimed'");
  ok(i > 0, 'the route is there');
  const block = src.slice(i, i + 2200);
  ok(!/recordCreatorClaim\([^)]*body\.amount/.test(block), 'recordCreatorClaim is not handed body.amount');
  ok(/getTransaction\(/.test(block), 'it reads the transaction');
  ok(/postTokenBalances/.test(block) && /preTokenBalances/.test(block), 'and takes the figure from the balance delta');
  ok(/quote === 'SOL'/.test(block), '⛔ with the lamport case covered — a SOL pool pays in native SOL, which has no token balance entry');
}

console.log('\n── and the client sends a signature, not a number');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../public/pages.js', import.meta.url), 'utf8');
  const i = src.indexOf("api('/api/chain/creator/claimed'");
  ok(i > 0, 'the call is there');
  const call = src.slice(i, src.indexOf(')', src.indexOf('}', i)) + 1);
  ok(/sig:/.test(call), `the call carries sig — ${call.replace(/\s+/g, ' ').slice(0, 110)}`);
  ok(!/\bamount:/.test(call), 'and carries no amount of its own');
}

// ── the reads behind the Claim button are retried, not single-shot ─────────────────────────────
//
// ⛔ THE UNIT TEST FOR readWithRetry PROVES THE HELPER, NOT THE WIRING. MiKOL's claim failed on a
// single refused read while the money — 72.71 DOGE — sat in the pool the whole time, so what
// matters is that every read a claim depends on actually goes through it. A helper nothing calls
// is the same bug with extra steps.
console.log('\n── every read behind a Claim goes through the retry');
{
  const src = (await import('node:fs')).readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  for (const call of ['creatorFeesOf', 'partnerFeesOf', 'feeClaimerOf']) {
    // The claim builders must not call these bare; find any occurrence not wrapped in the retry.
    const bare = new RegExp(`await MET\\.${call}\\(`, 'g');
    const wrapped = new RegExp(`readWithRetry\\(\\(\\) => MET\\.${call}\\(`, 'g');
    const nBare = (src.match(bare) || []).length;
    const nWrapped = (src.match(wrapped) || []).length;
    ok(nWrapped >= 1, `${call} is read through readWithRetry (${nWrapped} site(s))`);
    // ⛔ THE BACKGROUND SWEEP IS ALLOWED TO CALL IT BARE, and should: nobody is waiting on it and
    // the next tick comes round in seconds, so retrying there would only spend reads the breaker
    // has already said it cannot serve. Every bare call must therefore sit inside refreshDbcPools.
    const sweep = src.slice(src.indexOf('async function refreshDbcPools()'), src.indexOf('// ---------- helpers'));
    const bareOutsideSweep = nBare - ((sweep.match(bare) || []).length);
    ok(bareOutsideSweep === 0,
      `   and the only bare call is the background sweep (${nBare} bare, ${nBare - bareOutsideSweep} of them in refreshDbcPools)`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
