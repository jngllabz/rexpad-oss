// Hostile tests for the growth layer: sybil farms, self-dealing, double-counting, gate bypasses and
// the arithmetic identities the referral split has to hold under abuse.
// Run: node tools/social_adversarial.mjs
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/rex-sybil-' + process.pid;
const E = await import('../lib/engine.mjs');
const { db } = await import('../lib/db.mjs');
const { cfg } = await import('../lib/config.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
let n = 0;
// Must be real base58 — the engine now refuses anything else, and a test fixture that is not a
// valid address would be testing the guard rather than the behaviour.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const W = () => {
  let w = ''; const k = ++n;
  for (let i = 0; i < 44; i++) w += B58[(k * 7 + i * 13 + (k >> (i % 5))) % B58.length];
  E.ensureWallet(w); E.credit(w, 'SOL', 100_000); return w;
};
const age = (mint) => db.prepare('UPDATE referrals SET first_seen=? WHERE mint=?').run(Date.now() - 86_400_000, mint);
const mk = (creator, o = {}) => E.createToken(creator, { name: 'Adv' + (++n), symbol: 'AD' + n, quote: 'SOL', holderBps: 200, creatorBps: 100, vaultBps: 0, burnBps: 0, refShareBps: 10_000, fairOpenSecs: 0, ...o });

const DEV = W();

console.log('\n── a farm of fresh wallets earns nothing');
{
  const farmer = W(), t = mk(DEV);
  const alts = [W(), W(), W(), W(), W()];
  for (const a of alts) E.attributeReferral(t.mint, a, farmer);
  ok(E.refStatsFor(farmer, t.mint).brought === 0, 'five fresh wallets clicked the link and none counts yet');
  // dust buys: under the volume bar
  for (const a of alts) E.buy(a, t.mint, 0.01);
  age(t.mint); for (const a of alts) E.tryVest(t.mint, a);
  const st = E.refStatsFor(farmer, t.mint);
  ok(st.brought === 0 && st.volume === 0, `dust buys vest nothing (${st.pending} still pending)`);
  ok(E.reputationOf(farmer).broughtBuyers === 0, 'and the farmer\'s reputation is untouched');
  // the pool is untouched too, so honest referrers are not diluted
  const real = W();
  E.attributeReferral(t.mint, real, DEV);
}

console.log('\n── a referral only vests on real volume, held for real time');
{
  const r = W(), b = W(), t = mk(DEV);
  E.attributeReferral(t.mint, b, r);
  E.buy(b, t.mint, 10);                                   // well past the volume bar
  ok(E.tryVest(t.mint, b) === 'too soon', 'volume alone is not enough — the hold window has to pass');
  age(t.mint);
  ok(E.tryVest(t.mint, b) === null, 'with both, it vests');
  ok(E.refStatsFor(r, t.mint).brought === 1, 'and now it counts');
  ok(E.tryVest(t.mint, b) === null && E.refStatsFor(r, t.mint).volume === 10, 'vesting twice does not double the credit');
}

console.log('\n── buy, dump, and the referral never vests');
{
  const r = W(), b = W(), t = mk(DEV);
  E.attributeReferral(t.mint, b, r);
  E.buy(b, t.mint, 10);
  E.sell(b, t.mint, E.holdingOf(b, t.mint).amount);        // out before the window closes
  age(t.mint);
  ok(E.tryVest(t.mint, b) === 'referee no longer holds', 'a wallet that bought and dumped was never a real introduction');
  ok(E.refStatsFor(r, t.mint).brought === 0, 'so the referrer is credited nothing');
}

console.log('\n── self-dealing through a funding cluster');
{
  const boss = W(), alt = W(), t = mk(DEV);
  E.recordFunding(alt, boss);                              // boss funded the alt
  ok(E.sameFundingCluster(boss, alt), 'the funding edge is seen');
  ok(E.attributeReferral(t.mint, alt, boss) === null, 'referring a wallet you funded is refused outright');

  // and a sibling: two alts funded by the same parent
  const altB = W(); E.recordFunding(altB, boss);
  ok(E.sameFundingCluster(alt, altB), 'two wallets funded by the same parent are one cluster');
  ok(E.attributeReferral(t.mint, altB, alt) === null, 'so they cannot refer each other either');

  // a cluster discovered AFTER the referral still blocks the payout
  const late = W(), u = mk(DEV);
  E.attributeReferral(u.mint, late, boss);
  E.buy(late, u.mint, 10);
  E.recordFunding(late, boss);                             // the link surfaces later
  age(u.mint);
  ok(E.tryVest(u.mint, late) === 'same funder', 'a cluster found later still blocks vesting');
  ok(E.refStatsFor(boss, u.mint).brought === 0, 'and nothing is ever credited');
}

console.log('\n── the daily cap stops a farm scaling');
{
  const farmer = W(), t = mk(DEV);
  const buyers = [];
  for (let i = 0; i < cfg.refMaxPerDay + 4; i++) { const b = W(); buyers.push(b); E.attributeReferral(t.mint, b, farmer); E.buy(b, t.mint, 10); }
  age(t.mint);
  let capped = 0;
  for (const b of buyers) { if (E.tryVest(t.mint, b) === 'referrer at the daily cap') capped++; }
  ok(capped >= 4, `past the daily cap of ${cfg.refMaxPerDay}, further referrals are refused (${capped} blocked)`);
  ok(E.refStatsFor(farmer, t.mint).brought === cfg.refMaxPerDay, `exactly the cap vested (${E.refStatsFor(farmer, t.mint).brought})`);
}

console.log('\n── the referral pool can never exceed what the creator set aside');
{
  const t = mk(DEV, { refShareBps: 10_000 });              // the creator gives sharers everything
  const refs = [];
  for (let i = 0; i < 4; i++) { const r = W(), b = W(); refs.push(r); E.attributeReferral(t.mint, b, r); E.buy(b, t.mint, 10); }
  age(t.mint);
  for (const row of db.prepare('SELECT referee FROM referrals WHERE mint=?').all(t.mint)) E.tryVest(t.mint, row.referee);
  const pot = E.getToken.get(t.mint).creator_pot;
  const before = refs.map((r) => E.balanceOf(r, 'SOL'));
  const devBefore = E.balanceOf(DEV, 'SOL');
  E.runEpoch();
  const paid = refs.reduce((s, r, i) => s + (E.balanceOf(r, 'SOL') - before[i]), 0);
  const row = E.getToken.get(t.mint);
  ok(paid <= pot + 1e-9, `sharers took no more than the bucket held (${paid.toFixed(6)} of ${pot.toFixed(6)})`);
  // DEV creates many tokens here and runEpoch settles them all, so the identity is checked on the
  // token's own books rather than on a wallet balance.
  ok(near(row.ref_paid + row.creator_paid + (row.creator_ref_paid || 0), pot),
    `the bucket is exactly accounted for on the token's books (${(row.ref_paid + row.creator_paid).toFixed(6)} of ${pot.toFixed(6)})`);
  ok(E.getToken.get(t.mint).creator_pot === 0, 'the bucket is drained, not left with a remainder');
}

console.log('\n── a creator cannot farm their own launches');
{
  const solo = W();
  E.attributeWallet(solo, solo);
  ok(E.referrerOf(solo) === null, 'a creator cannot refer themselves to the platform');
  const scout = W();
  E.recordFunding(solo, scout);
  E.attributeWallet(solo, scout);
  const t = mk(solo);
  E.buy(W(), t.mint, 10);
  const s0 = E.balanceOf(scout, 'SOL');
  E.runEpoch();
  ok(near(E.balanceOf(scout, 'SOL') - s0, 0), 'and a scout who funded that creator earns nothing from their launches');
}

console.log('\n── a junk launch pays its referrer nothing');
{
  const scout = W(), maker = W();
  E.attributeWallet(maker, scout);
  const t = mk(maker);                                     // launched, never traded
  const s0 = E.balanceOf(scout, 'SOL');
  db.prepare('UPDATE tokens SET creator_pot=1 WHERE mint=?').run(t.mint);
  E.runEpoch();
  ok(near(E.balanceOf(scout, 'SOL') - s0, 0), 'spinning up alt creators who never trade earns nothing');
  E.buy(W(), t.mint, 20);                               // now it is a real launch
  const s1 = E.balanceOf(scout, 'SOL');
  E.runEpoch();
  ok(E.balanceOf(scout, 'SOL') - s1 > 0, 'but a launch that actually trades does pay them');
}

console.log('\n── gates cannot be talked around');
{
  const t = mk(DEV), out = W();
  ok(!E.canChat(out, t.mint).ok, 'a non-holder cannot post');
  ok(!E.canChat('', t.mint).ok, 'an empty wallet cannot post');
  ok(!E.canChat(out, 'nope').ok, 'an unknown token is refused, not crashed');
  E.buy(out, t.mint, 50); ok(E.canChat(out, t.mint).ok, 'a real holder can');
  E.sell(out, t.mint, E.holdingOf(out, t.mint).amount);
  ok(!E.canChat(out, t.mint).ok, 'and loses the room when they sell out');
  // posting
  const stranger = W();
  try { E.postUpdate(stranger, t.mint, 'x'); ok(false, 'a stranger posted an update'); } catch { ok(true, 'only the creator posts updates'); }
}

console.log('\n── junk into every social entry point');
{
  const t = mk(DEV);
  for (const bad of [null, undefined, '', 0, {}, [], 'x'.repeat(500)]) {
    ok(E.attributeReferral(t.mint, bad, DEV) === null || typeof E.attributeReferral(t.mint, bad, DEV) === 'string', `referee ${JSON.stringify(bad)?.slice(0, 12)} handled`);
    ok(E.walletForRefCode(bad) === null, `code ${JSON.stringify(bad)?.slice(0, 12)} resolves to nobody`);
  }
  ok(E.refStatsFor(W(), t.mint).brought === 0, 'a wallet with no history reads clean, not undefined');
  ok(E.reputationOf('1'.repeat(44)).broughtBuyers === 0, 'an unknown wallet has an empty record');
  ok(E.milestonesOf('nope').length === 0, 'milestones for an unknown token is empty, not an error');
  ok(E.markMilestone('nope', 'graduated') === null, 'marking an unknown token is a no-op');
  ok(E.markMilestone(t.mint, 'notARealKind') === null, 'an unknown milestone kind is refused');
}

console.log('\n── the $REX hold is a continuing requirement, not a one-time gate');
{
  const r = W(), b = W(), t = mk(DEV, { refShareBps: 10_000 });
  E.attributeReferral(t.mint, b, r);
  E.buy(b, t.mint, 10);
  age(t.mint);
  ok(E.tryVest(t.mint, b) === null, `a referrer holding $REX vests normally (holds $${E.rexHeldUsd(r).toFixed(0)})`);

  // now strip their $REX and run a payout
  const held = E.balanceOf(r, 'REX');
  db.prepare("UPDATE balances SET amount=0 WHERE wallet=? AND asset='REX'").run(r);
  ok(E.rexHeldUsd(r) < cfg.refHoldUsd, 'they sell out of $REX');
  const before = E.balanceOf(r, 'SOL');
  E.runEpoch();
  ok(near(E.balanceOf(r, 'SOL') - before, 0), 'and stop earning on referrals they already vested');

  // put it back and they earn again
  E.credit(r, 'REX', held);
  E.buy(b, t.mint, 10);
  const mid = E.balanceOf(r, 'SOL');
  E.runEpoch();
  ok(E.balanceOf(r, 'SOL') - mid > 0, 'buying back in restores it — the gate is a hold, not a ban');
}

{
  // a referrer under the bar cannot vest at all
  const poor = W(), b2 = W(), t2 = mk(DEV);
  db.prepare("UPDATE balances SET amount=0 WHERE wallet=? AND asset='REX'").run(poor);
  E.attributeReferral(t2.mint, b2, poor);
  E.buy(b2, t2.mint, 10);
  age(t2.mint);
  ok(E.tryVest(t2.mint, b2) === 'referrer holds too little $REX', 'a referrer under the $REX bar never vests');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
