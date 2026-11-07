// A launch must be able to get its pair's decimals, and must never guess them.
//
// ⛔ WHAT HAPPENED. Fco, 24 Oct: "I cant launch pair w Dope" — the form answered "Could not read
// the pair token's decimals from the chain just now". The REFUSAL was right: guessing is the bug
// that whole path exists to prevent, because prices.mjs once had STONK and ZCAT at 6 when the chain
// says 9 and a launch priced on that opened at a $5 market cap. What was wrong is that the read
// gave up after ONE attempt, so a single 429 — and the breaker was opening and closing under
// background load all evening — was enough to refuse a launch.
//
// Two halves to the fix, and this file guards both: the read retries, and the decimals of every
// known quote are cached ahead of time so a launch does not depend on the RPC answering at the
// instant someone presses the button.
//
//   node tools/quote_decimals_test.mjs
import fs from 'node:fs';
import os from 'node:os';

const dir = fs.mkdtempSync(`${os.tmpdir()}/rex-qdec-`);
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'qdec.sqlite';
process.env.SIM = '1';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const LP = await import('../lib/lp.mjs');
const { QUOTES } = await import('../lib/prices.mjs');

const MINT = 'DoGEV7LASBkQbibMc5k5vKnTZoMg423GpJ5QtJEGfm7R';

// ---------- the read survives a transient failure ----------
{
  let calls = 0;
  const flaky = {                                   // fails twice, then answers — a 429 burst
    getParsedAccountInfo: async () => {
      calls++;
      if (calls < 3) throw new Error('429 Too Many Requests');
      return { value: { data: { parsed: { info: { decimals: 8 } } } } };
    },
  };
  const d = await LP.decimalsOf(flaky, MINT);
  ok(d === 8, `⛔ a read that 429s twice still resolves (got ${d} after ${calls} attempts)`);
  ok(calls >= 3, 'it actually retried rather than getting lucky');
}

// ---------- a genuinely unreadable mint still REFUSES, it does not guess ----------
{
  const dead = { getParsedAccountInfo: async () => { throw new Error('429 Too Many Requests'); } };
  const d = await LP.decimalsOf(dead, 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm');
  ok(d === null, '⛔ an unreadable mint returns null so the launch refuses — it never falls back to 6');
}

// ⛔ 0 IS A VALID DECIMALS AND MUST NOT BE RETRIED AWAY. `readWithRetry` in chain.mjs retries on any
// falsy value, which is why this path does its own loop: a zero-decimal mint would otherwise be
// tried four times and then reported as unreadable.
{
  let calls = 0;
  const zero = { getParsedAccountInfo: async () => { calls++; return { value: { data: { parsed: { info: { decimals: 0 } } } } }; } };
  const d = await LP.decimalsOf(zero, '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv');
  ok(d === 0 && calls === 1, `a zero-decimal mint resolves to 0 on the first attempt (got ${d} in ${calls})`);
}

// ---------- warming fills the cache, so a launch needs no live read ----------
{
  // ⛔ Valid base58, because `new PublicKey()` throws on anything else and the throw would be
  // mistaken for the failure under test. The connection is stubbed, so which mints these are is
  // irrelevant — only that they could be addresses.
  const mints = ['So11111111111111111111111111111111111111112', 'DoGEV7LASBkQbibMc5k5vKnTZoMg423GpJ5QtJEGfm7R'];
  const data = (d) => { const b = Buffer.alloc(82); b[44] = d; return b; };
  let batched = 0;
  const conn = {
    getMultipleAccountsInfo: async (keys) => { batched++; return keys.map((_, i) => ({ data: data(i === 0 ? 9 : 4) })); },
    getParsedAccountInfo: async () => { throw new Error('a warmed mint must not need a live read'); },
  };
  const n = await LP.warmDecimals(conn, mints);
  ok(n === 2, `warmDecimals cached both mints (${n})`);
  ok(batched === 1, '⛔ in ONE batched call, not one round trip per mint — a burst of single reads is how the 429s are earned');
  // The throwing getParsedAccountInfo is the assertion: resolving these must not touch the network.
  ok(await LP.decimalsOf(conn, mints[0]) === 9, 'the first resolves from cache with no live read');
  ok(await LP.decimalsOf(conn, mints[1]) === 4, 'and so does the second, at its own decimals');
}

// A mint the batch did not return is simply not cached — never cached as a guess.
{
  const conn = {
    getMultipleAccountsInfo: async () => [null],
    getParsedAccountInfo: async () => { throw new Error('429'); },
  };
  await LP.warmDecimals(conn, ['CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump']);
  ok(await LP.decimalsOf(conn, 'CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump') === null,
    '⛔ a mint that did not come back is left uncached, so the launch refuses rather than guessing');
}

// ---------- the launch route still refuses on an unreadable read ----------
{
  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  ok(/const quoteDecimals = await LPD\.decimalsOf\(/.test(srv), 'the launch route reads decimals off the chain');
  ok(/if \(!Number\.isInteger\(quoteDecimals\)\)[\s\S]{0,200}503/.test(srv),
    '⛔ and still refuses with a 503 when it cannot — the retry made that rarer, not optional');
  // ⛔ The comment above that line QUOTES the old bug verbatim ("it used to be
  // `Number(body.quoteDecimals) || 6`"), so a naive grep matches the warning rather than the code.
  // Strip comments first, or this asserts the opposite of what it reads like.
  const code = srv.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/body\.quoteDecimals/.test(code),
    '⛔ and never takes decimals from the caller, which is how a crafted request could mis-size any curve');
}

// ---------- every real quote agrees with the table ----------
// Not a network test: auditQuoteDecimals does that against the chain at boot. This asserts the
// table is internally sane, so a pair added by hand cannot ship without a decimals figure at all.
{
  const bad = Object.values(QUOTES).filter((q) => !Number.isInteger(q.decimals) || q.decimals < 0 || q.decimals > 18);
  ok(bad.length === 0, `every quote in the table carries a plausible decimals (${Object.keys(QUOTES).length} checked)`);
  const noMint = Object.values(QUOTES).filter((q) => !q.mint || String(q.mint).length < 32);
  ok(noMint.length === 0, 'and every one carries a mint that could be an address');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
