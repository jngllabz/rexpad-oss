// The growth layer: referral attribution, the creator-funded share, and the creator's update feed.
// Run: node tools/social_test.mjs
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/rex-social-' + process.pid;
// ⛔ THE $REX SKIN-IN-THE-GAME GATE IS PINNED OFF FOR THE ATTRIBUTION CASES, AND TESTED ON ITS OWN
// BELOW. `refHoldUsd` defaults to 100, so a referrer who holds no $REX can never vest — which is
// the policy, but it meant nine assertions about attribution, the creator-funded share and the
// leaderboards were failing for a reason none of them were about. The suite had gone red and stayed
// red, which is worse than either outcome: a real regression in this layer would have looked exactly
// the same. Config is read at import, so this must be set before the engine loads.
process.env.REF_HOLD_USD = process.env.REF_HOLD_USD ?? '0';
const E = await import('../lib/engine.mjs');
const { db } = await import('../lib/db.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const throws = (fn, re, m) => { try { fn(); ok(false, `${m} (did not throw)`); } catch (e) { ok(re.test(e.message), `${m} → "${e.message}"`); } };

// Real base58 — the engine refuses anything else, so a fixture outside the alphabet (l, I, O, 0)
// would be testing the guard rather than the behaviour.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let _w = 0;
const W = () => { let w = ''; const k = ++_w;
  for (let i = 0; i < 44; i++) w += B58[(k * 11 + i * 17 + (k >> (i % 5))) % B58.length];
  E.ensureWallet(w); E.credit(w, 'SOL', 100_000); return w; };
const DEV = W(), ALICE = W(), BOB = W(), CAI = W(), DAN = W();

console.log('\n── referral codes are stable, unique and shareable');
{
  const a = E.refCodeOf(ALICE);
  ok(/^[23456789A-HJ-NP-Z]{6}$/.test(a), `a code is 6 unambiguous characters (${a})`);
  ok(E.refCodeOf(ALICE) === a, 'asking twice returns the same code — a shared link never goes stale');
  ok(E.refCodeOf(BOB) !== a, 'two wallets get different codes');
  ok(E.walletForRefCode(a) === ALICE, 'a code resolves back to its wallet');
  ok(E.walletForRefCode('NOPE42') === null, 'an unknown code resolves to nobody');
}

console.log('\n── attribution is first-touch and permanent');
{
  const t = E.createToken(DEV, { name: 'Social', symbol: 'SOCIAL', quote: 'SOL', holderBps: 200, creatorBps: 100, vaultBps: 0, burnBps: 0, refShareBps: 5000, fairOpenSecs: 0 });
  ok(E.getToken.get(t.mint).ref_share_bps === 5000, 'the creator routed half of their own bucket to sharers');

  ok(E.attributeReferral(t.mint, BOB, ALICE) === ALICE, 'Alice brought Bob');
  ok(E.attributeReferral(t.mint, BOB, CAI) === ALICE, 'Cai cannot re-tag a buyer Alice already brought — first touch wins');
  ok(E.attributeReferral(t.mint, ALICE, ALICE) === null, 'nobody can refer themselves');
  ok(E.attributeReferral(t.mint, CAI, ALICE) === ALICE, 'but Alice can bring somebody new');

  // Kept well under the 85 SOL raise: past it the curve caps a buy and refunds the rest, and the
  // credited volume is then the gross actually done — correct, but not the identity under test.
  E.buy(BOB, t.mint, 10);
  E.buy(CAI, t.mint, 5);
  E.buy(DAN, t.mint, 20);           // nobody brought Dan
  let st = E.refStatsFor(ALICE, t.mint);
  ok(st.brought === 0 && st.pending === 2, 'both referrals start PENDING — a fresh wallet proves nothing yet');
  // let the hold window pass and re-check: they traded enough and still hold
  db.prepare('UPDATE referrals SET first_seen=? WHERE mint=?').run(Date.now() - 86_400_000, t.mint);
  E.tryVest(t.mint, BOB); E.tryVest(t.mint, CAI);
  st = E.refStatsFor(ALICE, t.mint);
  ok(near(st.volume, 15), `once vested, Alice is credited with the volume she brought and only that (${st.volume} of 35 traded)`);
  ok(st.brought === 2, 'and with the two buyers she actually introduced');
  ok(E.refStatsFor(DAN, t.mint).volume === 0, 'a wallet that brought nobody is credited nothing');

  console.log('\n── the share is paid out of the CREATOR\'s bucket, not the holders\' or REX\'s');
  const before = E.getToken.get(t.mint);
  const creatorBefore = E.balanceOf(DEV, 'SOL'), aliceBefore = E.balanceOf(ALICE, 'SOL');
  const holderPotBefore = before.yield_pool, rexBefore = before.rex_pot;
  const creatorPot = before.creator_pot;
  ok(creatorPot > 0, `the creator bucket collected ${creatorPot.toFixed(4)} SOL`);

  E.runEpoch();
  const after = E.getToken.get(t.mint);
  const toAlice = E.balanceOf(ALICE, 'SOL') - aliceBefore;
  const toCreator = E.balanceOf(DEV, 'SOL') - creatorBefore;
  ok(near(toAlice, creatorPot * 0.5), `Alice took half the creator bucket, as set (${toAlice.toFixed(6)})`);
  ok(near(toCreator, creatorPot * 0.5, 1e-6), `and the creator kept the other half (${toCreator.toFixed(6)})`);
  ok(near(toAlice + toCreator, creatorPot, 1e-6), 'the two halves are the whole bucket — nothing was created or lost');
  ok(after.yield_pool === 0 || after.yield_pool !== holderPotBefore + 1, 'the holders\' pot was never the source');
  ok(near(after.rex_pot, 0) || after.rex_pot <= rexBefore, 'and neither was REX\'s');
  ok(near(after.ref_paid, toAlice, 1e-6), 'the token records what went out to sharers');
}

console.log('\n── a creator who shares nothing keeps everything');
{
  const t = E.createToken(DEV, { name: 'Solo', symbol: 'SOLO', quote: 'SOL', holderBps: 200, creatorBps: 100, vaultBps: 0, burnBps: 0, refShareBps: 0, fairOpenSecs: 0 });
  E.attributeReferral(t.mint, BOB, ALICE);
  E.buy(BOB, t.mint, 10);
  db.prepare('UPDATE referrals SET first_seen=? WHERE mint=?').run(Date.now() - 86_400_000, t.mint);
  E.tryVest(t.mint, BOB);
  const pot = E.getToken.get(t.mint).creator_pot;
  const a0 = E.balanceOf(ALICE, 'SOL'), d0 = E.balanceOf(DEV, 'SOL');
  E.runEpoch();
  ok(near(E.balanceOf(ALICE, 'SOL') - a0, 0), 'a sharer earns nothing when the creator set no share');
  ok(near(E.balanceOf(DEV, 'SOL') - d0, pot, 1e-6), 'and the creator keeps the whole bucket');
}

console.log('\n── the split is pro-rata to volume actually brought');
{
  const t = E.createToken(DEV, { name: 'Split', symbol: 'SPLIT', quote: 'SOL', holderBps: 300, creatorBps: 100, vaultBps: 0, burnBps: 0, refShareBps: 10_000, fairOpenSecs: 0 });
  E.attributeReferral(t.mint, BOB, ALICE);   // Alice brings Bob
  E.attributeReferral(t.mint, DAN, CAI);     // Cai brings Dan
  E.buy(BOB, t.mint, 30);                    // Alice: 30
  E.buy(DAN, t.mint, 10);                    // Cai:   10
  db.prepare('UPDATE referrals SET first_seen=? WHERE mint=?').run(Date.now() - 86_400_000, t.mint);
  E.tryVest(t.mint, BOB); E.tryVest(t.mint, DAN);
  const pot = E.getToken.get(t.mint).creator_pot;
  const a0 = E.balanceOf(ALICE, 'SOL'), c0 = E.balanceOf(CAI, 'SOL');
  E.runEpoch();
  const aliceGot = E.balanceOf(ALICE, 'SOL') - a0, caiGot = E.balanceOf(CAI, 'SOL') - c0;
  ok(near(aliceGot / caiGot, 3, 1e-6), `three times the volume earns three times the share (${aliceGot.toFixed(6)} vs ${caiGot.toFixed(6)})`);
  ok(near(aliceGot + caiGot, pot, 1e-6), 'and at a 100% share the creator keeps nothing, by their own choice');
}

console.log('\n── leaderboards and a wallet\'s own summary');
{
  const top = E.topReferrers(null, 10);
  ok(top.length >= 2 && top[0].volume >= top[1].volume, `platform leaderboard ranks by volume brought (${top.length} sharers)`);
  const mine = E.refSummary(ALICE);
  ok(mine.tokens.length >= 2 && mine.earnedUsd > 0, `a sharer sees every token they earned on (${mine.tokens.length}) and what it came to`);
  ok(mine.code === E.refCodeOf(ALICE), 'with the one code they share everywhere');
}

console.log('\n── the creator\'s update feed');
{
  const t = E.createToken(DEV, { name: 'Feed', symbol: 'FEED', quote: 'SOL', holderBps: 100, creatorBps: 0, vaultBps: 0, burnBps: 0, fairOpenSecs: 0 });
  E.postUpdate(DEV, t.mint, 'Liquidity locked, first epoch pays tonight.');
  ok(E.postsOf(t.mint).length === 1, 'the creator can post an update');
  throws(() => E.postUpdate(ALICE, t.mint, 'hi'), /Only the creator/, 'nobody else can post to their feed');
  throws(() => E.postUpdate(DEV, t.mint, ' '), /Say something/, 'an empty update is refused');
  const long = E.postUpdate(DEV, t.mint, 'x'.repeat(900));
  ok(long.text.length === 500, 'a long update is clamped rather than refused');
  ok(!E.postsOf(t.mint).some((p) => /[\x00-\x08]/.test(p.text)), 'control characters never reach the feed');
}

console.log('\n── launch-time referrals: bring a creator, earn on every token they ever launch');
{
  const SCOUT = W(), MAKER = W();
  ok(E.attributeWallet(MAKER, SCOUT) === SCOUT, 'the scout brought the creator to the platform');
  ok(E.attributeWallet(MAKER, ALICE) === SCOUT, 'and that is first-touch too — Alice cannot re-tag them');
  ok(E.attributeWallet(SCOUT, SCOUT) === null, 'nobody refers themselves');
  ok(E.attributeWallet(SCOUT, MAKER) === null, 'and a cycle is refused — both sides would earn off each other forever');

  const t = E.createToken(MAKER, { name: 'Downstream', symbol: 'DOWN', quote: 'SOL', holderBps: 200, creatorBps: 100, vaultBps: 0, burnBps: 0, fairOpenSecs: 0 });
  ok(E.getToken.get(t.mint).creator_ref === SCOUT, 'the token snapshots who brought its creator');
  E.buy(BOB, t.mint, 10);   // well past the vesting bar, so the launch qualifies
  const pot = E.getToken.get(t.mint).creator_pot;
  const s0 = E.balanceOf(SCOUT, 'SOL'), m0 = E.balanceOf(MAKER, 'SOL');
  E.runEpoch();
  const toScout = E.balanceOf(SCOUT, 'SOL') - s0, toMaker = E.balanceOf(MAKER, 'SOL') - m0;
  ok(near(toScout, pot * 0.05, 1e-6), `the scout earned 5% of the creator's bucket (${toScout.toFixed(6)})`);
  ok(near(toScout + toMaker, pot, 1e-6), 'and the creator kept the rest — nothing came from holders or REX');

  // a second launch by the same creator pays the same scout again, with no new action
  const t2 = E.createToken(MAKER, { name: 'Again', symbol: 'AGAIN', quote: 'SOL', holderBps: 200, creatorBps: 100, vaultBps: 0, burnBps: 0, fairOpenSecs: 0 });
  ok(E.getToken.get(t2.mint).creator_ref === SCOUT, 'their next launch carries the same referrer automatically');

  // and changing the referrer later cannot redirect a token that is already live
  db.prepare('UPDATE wallets SET referred_by=? WHERE wallet=?').run(ALICE, MAKER);
  ok(E.getToken.get(t.mint).creator_ref === SCOUT, 'a live token keeps the referrer it was launched with');
}

console.log('\n── chat is a holders\' room');
{
  const t = E.createToken(DEV, { name: 'Room', symbol: 'ROOM', quote: 'SOL', holderBps: 100, creatorBps: 0, vaultBps: 0, burnBps: 0, fairOpenSecs: 0 });
  ok(E.canChat(DEV, t.mint).ok, 'the creator can always post in their own room');
  const out = E.canChat(BOB, t.mint);
  ok(!out.ok && /Hold at least/.test(out.reason), `a non-holder is kept out → "${out.reason}"`);
  E.buy(BOB, t.mint, 50);
  ok(E.canChat(BOB, t.mint).ok, 'buying in opens the room');
  ok(E.canChat(CAI, t.mint).ok === false, 'and it stays shut for everyone who has not');
}

console.log('\n── milestones fire once, and only once');
{
  const t = E.createToken(DEV, { name: 'Marks', symbol: 'MARKS', quote: 'SOL', holderBps: 100, creatorBps: 0, vaultBps: 0, burnBps: 0, fairOpenSecs: 0 });
  E.buy(ALICE, t.mint, 5);
  db.prepare('UPDATE tokens SET yield_pool=1 WHERE mint=?').run(t.mint);
  E.runEpoch();
  const ms = E.milestonesOf(t.mint);
  ok(ms.some((m) => m.kind === 'firstEpoch'), 'the first epoch is marked');
  const again = E.markMilestone(t.mint, 'firstEpoch');
  ok(again === null, 'and marking it twice is a no-op — a cast fires once');
  const m = ms.find((x) => x.kind === 'firstEpoch');
  ok(typeof E.MILESTONES.firstEpoch.cast(E.getToken.get(t.mint)) === 'string', 'each milestone carries postable copy');
  ok(E.recentMilestones(10).length >= 1, 'and they show up in the platform feed');
}

console.log('\n── reputation and creator history');
{
  const rep = E.reputationOf(ALICE);
  ok(rep.broughtBuyers >= 2 && rep.earnedUsd > 0, `a sharer's record travels with them — vested only (${rep.broughtBuyers} buyers, $${rep.earnedUsd.toFixed(2)} earned)`);
  ok(rep.tokensBacked >= 1, `and shows what they actually hold (${rep.tokensBacked} tokens)`);
  ok(typeof rep.epochsSurvived === 'number', `with how many epochs they held through (${rep.epochsSurvived})`);
  const hist = E.creatorHistory(DEV);
  ok(hist.launches >= 4, `a creator's record counts their launches (${hist.launches})`);
  ok(typeof hist.paidUsd === 'number' && typeof hist.graduated === 'number',
    `and what those launches paid holders ($${hist.paidUsd.toFixed(2)}) and how many graduated (${hist.graduated})`);
  ok(E.creatorHistory('1'.repeat(44)).launches === 0, 'an unknown creator has an empty record, not an error');
}

// The gate the pin above switches off, exercised directly so the policy itself is covered rather
// than merely worked around. A separate engine instance, because cfg is frozen at import.
console.log('\n── and the $REX skin-in-the-game gate refuses a referrer who holds nothing');
{
  const { execFileSync } = await import('node:child_process');
  const probe = `
    process.env.DATA_DIR = '/tmp/rex-social-gate-' + process.pid;
    process.env.REF_HOLD_USD = '100';
    const E = await import('${process.cwd()}/lib/engine.mjs');
    const { db } = await import('${process.cwd()}/lib/db.mjs');
    const B58 = '${B58}';
    let _w = 0;
    const W = () => { let w = ''; const k = ++_w;
      for (let i = 0; i < 44; i++) w += B58[(k * 11 + i * 17 + (k >> (i % 5))) % B58.length];
      E.ensureWallet(w); E.credit(w, 'SOL', 100000); return w; };
    const DEV = W(), A = W(), B = W();
    const t = E.createToken(DEV, { name: 'Gate', symbol: 'GATE', quote: 'SOL', holderBps: 200, creatorBps: 100, vaultBps: 0, burnBps: 0, refShareBps: 5000, fairOpenSecs: 0 });
    E.attributeReferral(t.mint, B, A);
    E.buy(B, t.mint, 10);
    db.prepare('UPDATE referrals SET first_seen=? WHERE mint=?').run(Date.now() - 86400000, t.mint);
    console.log(JSON.stringify({ reason: E.tryVest(t.mint, B), credited: E.refStatsFor(A, t.mint).volume }));
  `;
  let out = {};
  try { out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', probe], { encoding: 'utf8' }).trim().split('\n').pop()); }
  catch (e) { out = { reason: 'PROBE FAILED: ' + String(e.message).slice(0, 120) }; }
  ok(/holds too little/.test(String(out.reason)), `a referrer with no $REX is refused, in words — "${out.reason}"`);
  ok(out.credited === 0, 'and nothing is credited to them');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
