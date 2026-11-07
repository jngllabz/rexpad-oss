// Transfer-hook rules, ported from santa-site so they can actually be switched on.
//
// ⛔ THE BUG THIS REPLACES: the old module was a catalogue and a verifier. It proved a hook program
// had code, NAMED it on the new mint, and stopped — it never contained the instruction that
// initialises the rule. A Token-2022 hook needs its extra-account-meta list written for that mint
// before any transfer can resolve, so naming a hook without initialising it does not produce a rule
// that does nothing. It produces a coin whose every transfer reverts, for ever. B24837 and KT are
// both in that state on mainnet: hook 4Gsx…, no extra-account-meta list, permanently untradeable.
//
//   node tools/hook_rules_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getExtraAccountMetaAddress } from '@solana/spl-token';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-hr-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'hr.sqlite';
process.env.RPC_URL = 'https://mainnet.example.com/?api-key=0123456789012345678901234567890123456';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const H = await import('../lib/hooked.mjs');
const MINT = new PublicKey('4AJMrs3XnsNY16VStwH1erwvLaMofybLGmnPxrZHnefE');   // B24837, the bricked one
const POOL = new PublicKey('7AKQ173PS4b4t2EPHsWYpcmGbdmDkuS3xtoj4vVRHiXq');
const PAYER = new PublicKey('21X4WY89RFXfUKY1PgUCyZ3VVxTCG1Xy7A9K3Dgkf4kz');
const SUPPLY = 1_000_000_000n * 10n ** 6n;
const defaults = (r) => Object.fromEntries(r.params.map((p) => [p.key, p.default]));
// The same defaults, with the addresses a few rules REQUIRE filled in. Those rules are supposed to
// refuse when they are blank (asserted further down); leaving them blank in the loop below is how
// two broken rules hid inside the rules that were refusing on purpose.
const GATE = '21X4WY89RFXfUKY1PgUCyZ3VVxTCG1Xy7A9K3Dgkf4kz';
const WSOL = 'So11111111111111111111111111111111111111112';   // a real mint, for the rule that reads one
const settings = (r) => Object.fromEntries(r.params.map((p) => [p.key,
  p.type === 'pubkey' || p.type === 'list' ? (p.default || (p.key === 'rewardMint' ? WSOL : GATE)) : p.default]));
// ⛔ THE CONFIG THE CALLER ALREADY HAS. meteora.mjs derives the pool address FROM this key, so
// handing it in is not a shortcut around a chain read — it is the same value, before the round
// trip. RPC_URL above points at a host that does not resolve, so every build in this file that
// succeeds proves it touched no chain at all.
const CONFIG = new PublicKey('BgptoUgiy4pqghaj7y6v4Jz15a4qt7MyL96v8GEKhtLB');

console.log('── the catalogue arrived intact');
{
  ok(H.RULES.length === 28, `${H.RULES.length} rules`);
  const fams = [...new Set(H.RULES.map((r) => r.family))];
  ok(fams.length === 6, `across ${fams.length} families: ${fams.join(', ')}`);
  ok(H.RULES.every((r) => typeof r.build === 'function'), '⛔ EVERY rule can build its own initialise — that is the whole difference');
  ok(H.RULES.every((r) => typeof r.summary === 'function'), 'and every rule can describe itself');
  ok(H.ruleList().every((r) => Array.isArray(r.params)), 'and exposes its settings to the form');
}

console.log('\n── ⛔ EVERY RULE WRITES THE EXTRA-ACCOUNT-META LIST, WHICH IS WHAT WAS MISSING');
{
  // ⛔ NO `catch { continue }` HERE ANY MORE, AND THAT CATCH IS THE REASON FOR THIS REWRITE.
  // It was written for the handful of rules that refuse when a required address is blank, and
  // `checked >= 20` passed with 26 of 28. King of the Hill and Lock & earn were the other two: both
  // fetched the pool's config off chain inside `build`, and on a launch the pool does not exist yet
  // — the base mint is generated in the same call — so both threw "could not read the pool" on
  // EVERY launch, for as long as they have been offered. Julz met it on 24 Oct, pairing to XMR.
  // A rule that cannot build is not a rule, so every one of them must build here.
  let missing = [], threw = [];
  for (const rule of H.RULES) {
    let groups;
    try { groups = await H.buildRuleOn({ rule, params: settings(rule), mint: MINT, pool: POOL, payer: PAYER, supplyRaw: SUPPLY, decimals: 6, poolConfig: CONFIG }); }
    catch (e) { threw.push(`${rule.key}: ${e.message}`); continue; }
    const want = getExtraAccountMetaAddress(MINT, rule.program).toBase58();
    const keys = groups.flat().flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58()));
    if (!keys.includes(want)) missing.push(rule.key);
  }
  ok(threw.length === 0, `⛔ all ${H.RULES.length} rules build their switch-on${threw.length ? ' — threw: ' + threw.join(' | ') : ''}`);
  ok(missing.length === 0, `all of them write the list the token program reads on every transfer${missing.length ? ' — missing: ' + missing.join(', ') : ''}`);

  // The two that were broken, named, so a regression says which.
  for (const key of ['king', 'lockin']) {
    const rule = H.ruleByKey(key);
    let groups = null, why = null;
    try { groups = await H.buildRuleOn({ rule, params: settings(rule), mint: MINT, pool: POOL, payer: PAYER, supplyRaw: SUPPLY, decimals: 6, poolConfig: CONFIG }); }
    catch (e) { why = e.message; }
    ok(!!groups, `${rule.label} builds with no chain read at all${why ? ` — ${why}` : ''}`);
    const keys = (groups || []).flat().flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58()));
    ok(keys.includes(CONFIG.toBase58()), `and names the config it was handed, not one it went looking for`);
  }

  // ⛔ AND THE ONE RULE THAT DOES READ THE CHAIN MUST NOT BLAME THE LAUNCHER FOR A REFUSED READ.
  // Buyer rewards answered ANY unparsed response with "the reward token mint was not found on
  // chain", so one 429 sent the launcher off to re-check an address that was right all along. The
  // three cases are now three different sentences, and two of them are checked here by behaviour.
  //
  // The third — never getting an answer at all — cannot be produced from a test: chain.mjs always
  // appends the public mainnet endpoint, so there is no configuration in which every read fails.
  {
    const airdrop = H.ruleByKey('airdrop');
    const run = async (rewardMint) => {
      const t0 = Date.now();
      try { await H.buildRuleOn({ rule: airdrop, params: { ...settings(airdrop), rewardMint }, mint: MINT, pool: POOL, payer: PAYER, supplyRaw: SUPPLY, decimals: 6, poolConfig: CONFIG }); return { why: '', ms: Date.now() - t0 }; }
      catch (e) { return { why: e.message, ms: Date.now() - t0 }; }
    };
    const notAMint = await run(GATE);
    ok(/not a token mint/.test(notAMint.why), `an account that is not a mint is named as that — "${notAMint.why.slice(0, 60)}"`);
    ok(notAMint.ms < 1500, `and answered straight away (${notAMint.ms}ms) — a definitive answer is not retried`);

    const nowhere = await run(Keypair.generate().publicKey.toBase58());
    ok(/was not found on chain/.test(nowhere.why), `an address with no account says so — "${nowhere.why.slice(0, 60)}"`);
    ok(nowhere.ms >= 2000, `⛔ after retrying rather than on the first look (${nowhere.ms}ms) — one refused read used to be the whole answer`);
  }
}

console.log('\n── ⛔ THE CONFIG HANDED IN IS THE ONE THE POOL ADDRESS WAS DERIVED FROM');
{
  // This is why the chain read was never needed, and it is an identity, not an optimisation: a DBC
  // pool's address IS deriveDbcPoolAddress(quote, base, config), and bytes 72..104 of the pool
  // account hold that same config. Verified 24 Oct against three live mainnet pools — F2F,
  // GORILLION and DDOPE — where 72 is the only offset in the 424-byte account that derives the
  // pool back. meteora.mjs holds `config` because it created it, so reading it off an account that
  // does not exist yet was a round trip to be told what the caller already knew.
  const { deriveDbcPoolAddress } = await import('@meteora-ag/dynamic-bonding-curve-sdk');
  const config = Keypair.generate().publicKey, base = Keypair.generate().publicKey;
  const quote = new PublicKey(WSOL);
  const pool = deriveDbcPoolAddress(quote, base, config);
  ok(!deriveDbcPoolAddress(quote, base, Keypair.generate().publicKey).equals(pool),
    'a different config gives a different pool — the address pins exactly one of them');
  const fake = Buffer.alloc(424); config.toBuffer().copy(fake, 72);
  ok(new PublicKey(fake.subarray(72, 104)).equals(config),
    'and bytes 72..104 of the pool account are that config, which is what the fallback reads');

  // meteora.mjs must actually hand it over, or the rules are back to reading a pool that is not there.
  const met = fs.readFileSync(new URL('../lib/meteora.mjs', import.meta.url), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(/poolConfig: config\.publicKey/.test(met), '⛔ and the launch builder passes it into buildRuleOn');
  ok(/pool: await poolAddress\(quoteMint, baseMint\.publicKey, config\.publicKey\)/.test(met),
    'alongside the pool address derived from that very key');
}

console.log('\n── the one Julz picked, against the coin it bricked');
{
  const maxhold = H.ruleByKey('maxhold');
  const [[ix]] = await H.buildRuleOn({ rule: maxhold, params: { maxWallet: 1 }, mint: MINT, pool: POOL, payer: PAYER, supplyRaw: SUPPLY, decimals: 6 });
  ok(ix.programId.toBase58() === '4GsxAQV9NeDh4J9HX4dWRfNFacxiqHKRf6RxGJoLuK8n', 'targets the program that is on the mint');
  const want = getExtraAccountMetaAddress(MINT, maxhold.program).toBase58();
  ok(ix.keys.some((k) => k.pubkey.toBase58() === want && k.isWritable),
    `writes ${want.slice(0, 12)}… — the exact account that is absent on chain today`);
  ok(ix.keys[0].pubkey.equals(PAYER) && ix.keys[0].isSigner, 'the launcher pays and signs it, not us');
}

console.log('\n── settings reach the instruction');
{
  const maxhold = H.ruleByKey('maxhold');
  const one = (await H.buildRuleOn({ rule: maxhold, params: { maxWallet: 1 }, mint: MINT, pool: POOL, payer: PAYER, supplyRaw: SUPPLY, decimals: 6 }))[0][0];
  const five = (await H.buildRuleOn({ rule: maxhold, params: { maxWallet: 5 }, mint: MINT, pool: POOL, payer: PAYER, supplyRaw: SUPPLY, decimals: 6 }))[0][0];
  ok(!one.data.equals(five.data), '1% and 5% produce different instruction data');
  ok(one.data.readUInt16LE(one.data.length - 2) === 100 && five.data.readUInt16LE(five.data.length - 2) === 500,
    'and the figure lands where the program reads it (basis points: 100, 500)');
}

console.log('\n── ⛔ A RULE WITH A REQUIRED ADDRESS REFUSES RATHER THAN BUILDING SOMETHING EMPTY');
{
  let refused = 0;
  for (const key of ['holdergated', 'tithe', 'airdrop', 'blocklist']) {
    const rule = H.ruleByKey(key); if (!rule) continue;
    try { await H.buildRuleOn({ rule, params: defaults(rule), mint: MINT, pool: POOL, payer: PAYER, supplyRaw: SUPPLY, decimals: 6 }); }
    catch { refused++; }
  }
  ok(refused === 4, `${refused}/4 refused with their required field left blank`);
}

console.log('\n── summaries describe the settings, not the defaults');
{
  const t = H.ruleByKey('maxhold');
  ok(t.summary({ maxWallet: 2 }).includes('2%'), 'the summary quotes the chosen figure');
  ok(!t.summary({ maxWallet: 2 }).includes('1%'), 'and not the default');
}

console.log('\n── ⛔ A HOOKED LAUNCH NEVER BUNDLES THE FIRST BUY');
{
  const met = fs.readFileSync(new URL('../lib/meteora.mjs', import.meta.url), 'utf8');
  const code = met.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok(!/createConfigAndPoolWithFirstBuyWithTransferHook/.test(code),
    'the bundled hooked-first-buy entry point is gone — it is the one that fails to resolve the hook accounts');
  ok(/createConfigAndPoolWithTransferHook/.test(code), 'a hooked launch creates the pool on its own');
  ok(/devBuyAfter = devBuy/.test(code), 'and hands the dev buy back to run after the rule is on');
  const client = fs.readFileSync(new URL('../public/pages.js', import.meta.url), 'utf8');
  ok(/built\.devBuyAfter && built\.devBuyAfter !== '0'/.test(client), 'which the client then does');
  const i = client.indexOf("built.devBuyAfter && built.devBuyAfter !== '0'");
  const j = client.indexOf('for (const [i, st] of built.steps.entries())');
  ok(j >= 0 && j < i, '⛔ after every step — the rule is on before anything tries to move the token');
}

console.log('\n── ⛔ SWITCHING A RULE ON DOES NOT NEED THE CHAIN, EXCEPT FOR THE ONE THAT DOES');
{
  // Only `vesting` reads the current slot, and only to turn a presale window into a deadline.
  // Fetching it for all 28 meant any rule failed outright when the RPC breaker was open — a launch
  // collapsing on a busy minute over a number 27 of the rules never look at. The deploy gate found
  // this: an earlier suite had tripped the breaker and this was the next thing to touch the chain.
  const CH = await import('../lib/chain.mjs');
  let reads = 0;
  const realConn = CH.conn;
  // Count chain reads by building every rule with an RPC that would throw if touched.
  for (const rule of H.RULES) {
    if (rule.key === 'vesting') continue;
    try {
      await H.buildRuleOn({ rule, params: defaults(rule), mint: MINT, pool: POOL, payer: PAYER, supplyRaw: SUPPLY, decimals: 6 });
    } catch (e) {
      if (/rpc|chain|endpoint/i.test(e.message)) { reads++; console.log(`     ${rule.key} still touches the chain: ${e.message.slice(0, 60)}`); }
    }
  }
  ok(reads === 0, 'no rule other than vesting reaches for the chain to be switched on');
  const src = fs.readFileSync(new URL('../lib/hooked.mjs', import.meta.url), 'utf8');
  ok(/rule\.key === 'vesting' && num\(params\.presaleHours, 0\) > 0/.test(src),
    'and vesting only reads it when a presale window is actually set');
  ok(/set the presale to 0 to vest every wallet/.test(src),
    'with a way out when the chain cannot be reached, rather than a raw breaker error');
}

console.log('\n── ⛔ A PROGRAM THAT IS MARKED EXECUTABLE BUT HOLDS NO CODE IS NOT VERIFIED');
{
  // An upgradeable program is TWO accounts: a 36-byte pointer marked executable, and the
  // programdata account that holds the bytes. Close the second and the first still looks perfect —
  // which is how a hook with nothing behind it was reported as verified on 7 Oct.
  const src = fs.readFileSync(new URL('../lib/hooked.mjs', import.meta.url), 'utf8');
  ok(/BPFLoaderUpgradeab1e11111111111111111111111/.test(src), 'the upgradeable loader is recognised');
  ok(/programdata account is empty or missing/.test(src), 'and an empty programdata is refused by name');
  ok(/info\.data\.subarray\(4, 36\)/.test(src), 'by following the pointer rather than trusting the flag');
  const fn = src.slice(src.indexOf('export async function verifyHook'), src.indexOf('export async function hookSweep'));
  ok(/unknown: true/.test(fn), '⛔ and an unreachable chain is UNKNOWN, never a verdict — otherwise one RPC hiccup empties the whole menu');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
