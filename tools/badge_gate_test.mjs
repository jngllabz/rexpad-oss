// A pair that cannot be launched must not be offered.
//
// ⛔ WHAT ELIO HIT, TWICE, AT THREE IN THE MORNING. He picked SUPER INU as the pair, filled in the
// whole launch form, pressed Launch and got a paragraph about Meteora token badges. Then he did it
// again with ALLINU. Both refusals were correct — DBC will not take a Token-2022 mint with a
// transfer fee as a quote without a badge Meteora has not issued — and both arrived at the last
// possible moment, from a form that had offered him the pair in the first place.
//
// The invariant: the greyed-out button in the form, the server's refusal, and the chain's own
// answer are three views of ONE fact, and they may never disagree.
//
//   node tools/badge_gate_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-badge-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'badge.sqlite';

const P = await import('../lib/prices.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

// Measured on mainnet 2026-10-06: four of the five META pairs carry a transfer fee and have no badge.
console.log('── the four pairs Elio could not launch start blocked');
for (const sym of ['ZCAT', 'SI', 'MASK', 'ALLINU']) ok(!!P.quoteBlock(sym), `${sym} is blocked out of the box`);
ok(!P.quoteBlock('STONK'), 'STONK, the clean META pair, stays open');
ok(!P.quoteBlock('REX'), 'REX stays open — metadata-only extensions take the permissionless path');
ok(!P.quoteBlock('NVDAx'), 'the xStocks stay open — Meteora HAS badged those');

console.log('\n── the reason travels to the browser, not just to the server');
{
  const q = P.quoteList().find((x) => x.symbol === 'ALLINU');
  ok(!!q.unavailable, 'quoteList marks it unavailable, which is what greys out the chip');
  ok(/token badge/i.test(q.unavailable), `and says why: "${String(q.unavailable).slice(0, 48)}…"`);
}

console.log('\n── the two kinds of block are told apart, because they read nothing alike');
{
  const q = P.quoteList().find((x) => x.symbol === 'ALLINU');
  ok(q.block?.kind === 'badge', 'a badge block is labelled as one, not as a cluster problem');
  // The form writes its tooltip around the reason. Fed a badge sentence into the cluster slot it
  // produced "Anonymous Cat exists on mainnet only — not on Meteora has not issued a token badge
  // for it", which is worse than no tooltip at all.
  ok(!/mainnet only/i.test(q.block.why), 'and its text is not phrased as a cluster reason');
  P.QUOTES.SI.unavailable = 'devnet';
  ok(P.quoteBlockKind('SI')?.kind === 'cluster', 'a cluster block is still labelled a cluster block');
  delete P.QUOTES.SI.unavailable;
}

console.log('\n── it is a seed, not a deny-list: the chain gets the last word');
{
  P.setBadgeBlocks({ ALLINU: null });
  ok(!P.quoteBlock('ALLINU'), 'a sweep that finds a badge OPENS the pair, with nobody editing a file');
  P.setBadgeBlocks({ ALLINU: 'badge gone' });
  ok(!!P.quoteBlock('ALLINU'), 'and a later sweep can close it again');
  // A symbol the sweep could not reach must keep whatever it had — an unreachable RPC must never
  // empty the launch form, which is the failure mode the persistence exists for.
  const before = P.quoteBlock('SI');
  P.setBadgeBlocks({ ALLINU: null });
  ok(P.quoteBlock('SI') === before, 'a symbol left out of a sweep is untouched');
}

console.log('\n── a cluster that has no stand-in mint still wins over a badge verdict');
{
  // On devnet the mint does not exist at all, so what Meteora has badged is beside the point.
  P.QUOTES.ALLINU.unavailable = 'devnet';
  P.setBadgeBlocks({ ALLINU: null });
  ok(P.quoteBlock('ALLINU') === 'devnet', 'the more fundamental reason is the one reported');
  delete P.QUOTES.ALLINU.unavailable;
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
