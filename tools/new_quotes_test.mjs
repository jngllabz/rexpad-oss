// ⛔ A QUOTE ASSET IS A MINT ADDRESS AND A DECIMAL COUNT, AND BOTH ARE UNFORGIVING.
//
// A wrong mint is a pool nobody can trade and a launch that fails after the user has signed. A
// wrong decimal count is a silent factor of a hundred or a thousand in every price the board
// shows — which is exactly what STONK at 6dp did to STNKOG's buckets.
//
// These are the figures read off mainnet on 10 Oct when the twenty quotes below were added, and
// the point of the file is that they cannot be edited later without someone re-reading the chain.
//
//   node tools/new_quotes_test.mjs
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const { QUOTES, QUOTE_TABS } = await import('../lib/prices.mjs');

// symbol: [mint, decimals, token program]  — every field verified on chain, not from a ticker search.
const VERIFIED = {
  CARDS: ['CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp', 6, 'legacy'],
  RACE:  ['RACEyWiM2ztEZcJx2AHXU2eWjhxU57x3vXn92b39dLD', 6, 't22'],
  MU:    ['MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1', 6, 't22'],
  SKHY:  ['SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3', 6, 't22'],
  DJT:   ['DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF', 6, 't22'],
  TTWO:  ['TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo', 6, 't22'],
  DKNG:  ['DKNGQFNGQmoBdXSRGKJ8tTu7uPDasw5JDcfMmWniNfow', 6, 't22'],
  HIMS:  ['HiMSSzzwkZkrXJ4PGVJRdtfLaANeAztjjcgk5Dxe7Lwx', 6, 't22'],
  NKE:   ['NKEda5nHhNGgjrE9nDdMvaEmkmJ96qqxzBVZEcKmjSg', 6, 't22'],
  NFLX:  ['NFLX7qV57zuVxCoHy3s1jiGZyALraLNwttbxdvmYJLJ', 6, 't22'],
  AMD:   ['AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES', 6, 't22'],
  MRNA:  ['MRNAzXzhNcaEXJPibHEn8cd4vyekCDiivTyEwswLUCT', 6, 't22'],
  SNDK:  ['SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH', 6, 't22'],
  QQQx:  ['Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', 8, 't22'],
  MSTRx: ['XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ', 8, 't22'],
  COINx: ['Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu', 8, 't22'],
  GMEx:  ['Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc', 8, 't22'],
  HOODx: ['XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg', 8, 't22'],
  MCDx:  ['XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2', 8, 't22'],
  PLTRx: ['XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4', 8, 't22'],
};

console.log('── every new quote matches what the chain said on 10 Oct');
{
  let bad = 0;
  for (const [sym, [mint, dec]] of Object.entries(VERIFIED)) {
    const q = QUOTES[sym];
    if (!q) { bad++; console.log(`   ⛔ ${sym} is missing`); continue; }
    if (q.mint !== mint) { bad++; console.log(`   ⛔ ${sym} mint ${q.mint} ≠ ${mint}`); continue; }
    if (q.decimals !== dec) { bad++; console.log(`   ⛔ ${sym} ${q.decimals}dp, chain says ${dec}dp`); }
  }
  ok(bad === 0, `all ${Object.keys(VERIFIED).length} mints and decimal counts match the chain`);
}

console.log('\n── ⛔ FERRARI IS THE BACKPACK MINT, NOT THE xSTOCK');
{
  // RACEx is the obvious hit for a ticker search and it is the wrong answer: zero liquidity, zero
  // volume, and no Meteora token badge, so DBC refuses it as a quote outright.
  const RACEX = 'XsefS5bmqC24xdsZMhuHVQKPExckM3kpwJWy4pJQitA';
  ok(!Object.values(QUOTES).some((q) => q.mint === RACEX), 'the badge-less Ferrari xStock is not in the table');
  ok(QUOTES.RACE?.mint?.startsWith('RACEy'), 'RACE is the Backpack mint that actually trades');
  ok(/NOT the Ferrari xStock/.test(QUOTES.RACE?.note || ''), 'and the note says why, so nobody "fixes" it to the xStock');
}

console.log('\n── no two quotes point at the same mint');
{
  const seen = new Map(); const dups = [];
  for (const [k, v] of Object.entries(QUOTES)) {
    if (seen.has(v.mint)) dups.push(`${k} = ${seen.get(v.mint)}`);
    seen.set(v.mint, k);
  }
  ok(dups.length === 0, dups.length ? `⛔ ${dups.join(', ')}` : `all ${Object.keys(QUOTES).length} quotes are distinct mints`);
}

console.log('\n── a symbol and its mint prefix agree, which is how a swapped row gets caught');
{
  // Both issuers use vanity mints: xStocks start Xs, Backpack's start with the ticker itself.
  const odd = [];
  for (const [sym, [mint]] of Object.entries(VERIFIED)) {
    if (sym.endsWith('x') && sym !== 'CARDS') { if (!mint.startsWith('Xs')) odd.push(`${sym} is an xStock but its mint does not start Xs`); }
    else if (sym !== 'CARDS' && !mint.toUpperCase().startsWith(sym.slice(0, 3).toUpperCase())) odd.push(`${sym} ≠ ${mint.slice(0, 5)}`);
  }
  ok(odd.length === 0, odd.length ? `⛔ ${odd.join('; ')}` : 'every mint carries its own ticker as a vanity prefix');
}

console.log('\n── ⚠️ the issuer-control warning is on the tab, where a launcher reads it');
{
  const tab = QUOTE_TABS.find((t) => t.key === 'stock');
  ok(/frozen|freeze/i.test(tab?.note || ''), 'the Stocks tab says the issuer can freeze');
  ok(/moved out of your wallet|moved out/i.test(tab?.note || '') || /paused/i.test(tab?.note || ''),
    'and that it can pause or seize');
  ok(!/frozen/i.test(QUOTE_TABS.find((t) => t.key === 'quote')?.note || ''),
    'the Quote tab does not carry a warning that does not apply to it');
  ok(QUOTES.CARDS.category === 'custom', 'CARDS sits in the Quote tab, not among the securities');
}

console.log('\n── the thin siblings are named, so nobody picks the wrong one');
{
  ok(/MRNAx/.test(QUOTES.MRNA?.note || ''), 'MRNA points away from MRNAx');
  ok(/xStock/.test(QUOTES.NFLX?.note || ''), 'NFLX points away from NFLXx');
  ok(/AMD xStock/.test(QUOTES.AMD?.note || ''), 'AMD points away from AMDx');
}

console.log('\n── every quote still has the fields the launch form reads');
{
  const missing = Object.entries(QUOTES).filter(([k, q]) =>
    !q.symbol || !q.name || !q.mint || !Number.isInteger(q.decimals) || !q.color || !q.category);
  ok(missing.length === 0, missing.length ? `⛔ incomplete: ${missing.map(([k]) => k).join(', ')}` : `all ${Object.keys(QUOTES).length} rows complete`);
  const badDec = Object.entries(QUOTES).filter(([, q]) => q.decimals < 0 || q.decimals > 18);
  ok(badDec.length === 0, 'and no decimal count is outside 0–18');
}

console.log('\n── ⛔ A TAXED MINT IS NOT A BADGE PROBLEM, AND SAYING SO SENDS PEOPLE TO THE WRONG PLACE');
{
  // I asked the program which error it actually returns, with a funded payer so validation ran:
  //   $GP, $SI, $MASK, $ALLINU -> 6081 QuoteMintHasNonZeroTransferFee (token.rs:232)
  //   extensions-only          -> 6080 InvalidTokenBadge
  // So for a taxed mint a badge changes NOTHING, and we told the owner for days that $GP was
  // waiting on one. It charges 3% per transfer; that is the whole refusal.
  const MET = await import('../lib/meteora.mjs');
  const src = (await import('node:fs')).readFileSync(new URL('../lib/meteora.mjs', import.meta.url), 'utf8');
  const sweep = /export async function badgeSweep[\s\S]*?\n\}/.exec(src)?.[0] || '';
  ok(/blockedByFee/.test(sweep), 'the sweep asks whether the FEE is the blocker, not just the badge');
  ok(/6081/.test(sweep), 'and cites the program error so the next person can check it');
  ok(/would NOT help/.test(sweep), '⛔ it says plainly that a badge would not fix a taxed mint');
  ok(/renounced/.test(sweep), 'and distinguishes a fee authority that can still act from one that cannot');

  const badge = /export async function badgeFor[\s\S]*?\n\}/.exec(src)?.[0] || '';
  ok(/getTransferFeeConfig/.test(badge), 'badgeFor reads the actual fee off the mint');
  ok(/olderTransferFee[\s\S]*newerTransferFee|Math\.max/.test(badge),
    '⛔ and takes the HIGHER of the two scheduled rates — the older one still applies until its epoch passes');
  ok(typeof MET.badgeFor === 'function', 'badgeFor is exported for the sweep and the launch guard');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
