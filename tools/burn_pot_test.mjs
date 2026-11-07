// A zero from a failing upstream must never be shown as an empty pot.
//
// ⛔ THE THREE WAYS A FALSE ZERO LIES, all of which were live on the front page:
//
//   1. "$0.00 in the pot" is a statement about the chain, and the chain says 9,870.165 REX is
//      sitting in 2DaEMgd9… and always has been. The burn figures come from rex-rewards — a
//      separate service on the same exhausted RPC key — so when it cannot read the payer wallet it
//      reports zero, and the panel repeats it as fact.
//   2. The movement detector reads the 9,870 → 0 drop as the pot MOVING, so `potMovedAt` jumps to
//      now and the one honest signal on the panel — "no fees have reached it in twelve days" —
//      resets itself at exactly the moment it should be loudest.
//   3. A pot cannot empty without a burn. That is the invariant that tells a failed read from a
//      real one, and it needs no new data source to check.
//
//   node tools/burn_pot_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-pot-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'pot.sqlite';

const { __potForTest: potMovement } = await import('../lib/rewards.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
ok(typeof potMovement === 'function', 'the pot logic is reachable for testing');

const FULL = { potRex: 9870.16521, potSol: 0.0968669, lastBurn: { at: 1000 } };

// First sight of a pot is movement by definition — there is nothing to compare against.
const a = potMovement(FULL);
ok(a.potStaleMs === 0, 'the first reading starts the clock');

// Same figures again: the pot has NOT moved, however long the upstream cache says it is fresh.
const b = potMovement(FULL);
ok(b.potStaleMs >= 0 && b.potMovedAt === a.potMovedAt, 'an identical reading does not count as movement');

// The upstream fails and reports zeroes, with no new burn behind them.
const z = potMovement({ potRex: 0, potSol: 0, lastBurn: { at: 1000 } });
ok(z.potUnverified === true, 'a zero with no burn behind it is marked unverified, not believed');
ok(z.potRex === FULL.potRex && z.potSol === FULL.potSol, 'the last figures we were sure of are kept');
ok(z.potMovedAt === a.potMovedAt, '⛔ and the staleness clock is NOT reset by the false zero');

// It must not latch: once the upstream recovers, real figures win again.
const r = potMovement({ potRex: 12000, potSol: 0.2, lastBurn: { at: 1000 } });
ok(!r.potUnverified && r.potStaleMs === 0, 'a real change is believed again the moment it arrives');

// A zero that FOLLOWS a burn is the real thing — that is exactly what a burn does to the pot.
const burned = potMovement({ potRex: 0, potSol: 0, lastBurn: { at: Date.now() + 5000 } });
ok(!burned.potUnverified, 'a zero after a fresh burn is believed — an emptied pot is what a burn looks like');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
