// ⛔ A HAND-COPIED LIST OF ADDRESSES AND AMOUNTS GOES WRONG TWICE.
//
// Seven launchers could not claim fees they had already earned: a claim OPENS token accounts and
// their wallets could not cover the rent. The owner funded all seven by hand from a list I gave
// them — and six were still blocked, because my figure was the rent for ONE account when a claim
// opens two and the payer must also stay above its own rent-exempt floor.
//
// So the list is derived from the chain when the button is pressed, and the browser never names an
// address or an amount. This file pins the parts of that which are not about the chain.
//
//   node tools/topup_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, SystemProgram } from '@solana/web3.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-tu-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'tu.sqlite';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const addr = () => Keypair.generate().publicKey.toBase58();

const { db } = await import('../lib/db.mjs');
const TU = await import('../lib/topup.mjs');

const RENT = 1_513_840, FLOOR = 890_880;
const NEED = 2 * RENT + FLOOR + 10_000;      // two accounts, the payer's floor, and the fee

const BROKE = addr(), RICH = addr(), NOFEES = addr(), UNREADABLE = addr();
const mk = (creator, sym) => {
  const mint = addr();
  db.prepare(`INSERT INTO tokens(mint,name,symbol,creator,quote,quote_mint,status,venue,dbc_pool,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?)`).run(mint, sym, sym, creator, 'SOL', addr(), 'live', 'dbc', addr(), Date.now());
  return mint;
};
mk(BROKE, 'POOR'); mk(BROKE, 'POOR2'); mk(RICH, 'OK'); mk(NOFEES, 'NIL'); mk(UNREADABLE, 'HUH');

const balances = { [BROKE]: 2_990_000, [RICH]: 50_000_000, [NOFEES]: 0 };
const conn = {
  getMinimumBalanceForRentExemption: async (n) => (n === 0 ? FLOOR : RENT),
  getBalance: async (pk) => {
    const k = pk.toBase58();
    if (k === UNREADABLE) throw new Error('429');
    return balances[k] ?? 1_000_000_000;
  },
  getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58() }),
};
// Everyone has fees waiting except NOFEES; UNREADABLE's balance cannot be read.
/** A minimal real transaction, so the planner's simulation branch actually runs. */
const aTx = async (owner) => {
  const { Transaction, PublicKey, SystemProgram } = await import('@solana/web3.js');
  const { NATIVE_MINT } = await import('@solana/spl-token');
  const who = new PublicKey(owner);
  const t = new Transaction();
  t.add(SystemProgram.transfer({ fromPubkey: who, toPubkey: who, lamports: 1 }));
  t.feePayer = who; t.recentBlockhash = NATIVE_MINT.toBase58();
  return t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
};
// ⛔ creatorFeesOf(conn, pool) — the pool is the SECOND argument. A stub that takes it first is
// handed the connection, finds no row, and reports every launcher as having no fees.
const MET = {
  buildClaimCreatorTx: async ({ creator }) => ({ tx: await aTx(creator) }),
  // By default the claim is short of SOL, which is the state this whole feature exists for.
  inspectBeforeSending: async () => ({ checked: true, why: 'This claim opens 2 token accounts… it needs about 0.00393 SOL.' }),
  creatorFeesOf: async (_conn, pool) => {
  const row = db.prepare('SELECT creator FROM tokens WHERE dbc_pool=?').get(pool);
  return row?.creator === NOFEES ? { base: 0n, quote: 0n } : { base: 0n, quote: 1000n };
} };

console.log('── only wallets that are actually short are funded');
{
  const plan = await TU.topupPlan({ conn, db, MET });
  const got = plan.rows.map((r) => r.wallet);
  ok(got.includes(BROKE), 'the launcher who cannot cover the rent is in the list');
  ok(!got.includes(RICH), 'the one who can is not');
  ok(!got.includes(NOFEES), '⛔ nor one with no fees waiting — there is nothing for them to claim');
  ok(!got.includes(UNREADABLE), '⛔ nor one whose balance could not be READ — unknown is not broke');
  ok(plan.fine.some((r) => r.wallet === RICH), 'the funded one is still reported, so the button is not silently skipping people');
}

console.log('\n── ⛔ A LAUNCHER WHOSE CLAIM SIMULATES CLEAN IS NEVER FUNDED');
{
  // I got this arithmetic wrong three times: assuming two accounts, counting the (idempotent)
  // create instructions, and counting only the missing accounts — all three over-stated it,
  // because on a SOL-quoted claim the wrapper is opened and closed in the same transaction and its
  // rent comes straight back. HAMSTRESS and CLANK survived every version and were always fine.
  // The arithmetic does not decide who is listed any more; the chain does.
  const clean = { ...MET, inspectBeforeSending: async () => ({ checked: true, why: null }) };
  const plan = await TU.topupPlan({ conn, db, MET: clean });
  ok(plan.rows.length === 0, '⛔ nobody is funded when every claim already works');
  ok(plan.fine.length > 0, 'and they are reported as fine, not silently dropped');

  // Only a SOL shortfall counts. A claim failing for some other reason is a different problem and
  // sending it money would not fix it.
  const other = { ...MET, inspectBeforeSending: async () => ({ checked: true, why: 'One of the accounts this claim needs is not in the state the program expects.' }) };
  const p2 = await TU.topupPlan({ conn, db, MET: other });
  ok(p2.rows.length === 0, '⛔ a claim broken for a NON-money reason is not funded either');

  const skint = { ...MET, inspectBeforeSending: async () => ({ checked: true, why: 'This claim opens 2 token accounts… it needs about 0.00393 SOL.' }) };
  const p3 = await TU.topupPlan({ conn, db, MET: skint });
  ok(p3.rows.some((r) => r.wallet === BROKE), 'and a real SOL shortfall is');
}

console.log('\n── ⛔ "I COULD NOT CHECK" IS NOT "IT IS FINE"');
{
  // The owner pressed the button and was told "every launcher with fees waiting can already
  // claim — nothing to fund", with five blocked launchers listed on the screen above it. The
  // simulation had not run; its null was read as a clean result.
  const blind = { ...MET, inspectBeforeSending: async () => ({ checked: false, why: null }) };
  const plan = await TU.topupPlan({ conn, db, MET: blind });
  ok(plan.rows.some((r) => r.wallet === BROKE),
    '⛔ a launcher we could not check is still funded, not silently declared fine');
  ok(plan.rows.find((r) => r.wallet === BROKE)?.unverified === true,
    'and is marked unverified, so the reason is visible rather than guessed at');
  ok(!plan.fine.some((r) => r.wallet === BROKE), 'they are NOT in the already-funded list');

  // A MET with no inspect at all (an older deploy) must behave the same way.
  const { inspectBeforeSending, ...noInspect } = blind;
  const p2 = await TU.topupPlan({ conn, db, MET: noInspect });
  ok(p2.rows.some((r) => r.wallet === BROKE), 'and so is one where the check does not exist');
}

console.log('\n── ⛔ IT COUNTS THE ACCOUNTS THAT DO NOT EXIST, NOT THE INSTRUCTIONS');
{
  // Both creates in a claim are IDEMPOTENT: if the launcher already holds that token the
  // instruction is a no-op and costs no rent. Counting instructions over-states what they need and
  // lists people who can claim perfectly well — HAMSTRESS and CLANK read that way and were fine.
  const hasOne = { ...conn, getAccountInfo: async () => ({ data: Buffer.alloc(165) }) };  // both exist
  const plan = await TU.topupPlan({ conn: hasOne, db, MET });
  const r = plan.rows.find((x) => x.wallet === BROKE);
  ok(plan.rows.every((x) => x.creates === 0), 'a launcher who holds both already opens nothing');
  ok(!r, '⛔ and is NOT funded — 0.00299 already covers a claim that opens no accounts');
  ok(plan.fine.some((x) => x.wallet === BROKE), 'they are reported as fine rather than silently dropped');
}

console.log('\n── a missing account is counted, and an unreadable one is treated as missing');
{
  const none = { ...conn, getAccountInfo: async () => null };
  const plan = await TU.topupPlan({ conn: none, db, MET });
  const r = plan.rows.find((x) => x.wallet === BROKE);
  ok(r && r.creates === 2, 'two missing accounts means two rents');
  ok(r.need === NEED, `which is the full ${NEED}`);

  const blind = { ...conn, getAccountInfo: async () => { throw new Error('429'); } };
  const p2 = await TU.topupPlan({ conn: blind, db, MET });
  const r2 = p2.rows.find((x) => x.wallet === BROKE);
  ok(r2 && r2.creates === 2, '⛔ an unreadable account counts as missing — overfund rather than strand');
}

console.log('\n── the amount is the real shortfall, not a round number');
{
  const plan = await TU.topupPlan({ conn, db, MET });
  const r = plan.rows.find((x) => x.wallet === BROKE);
  ok(r.need === NEED, `it needs two rents plus the payer floor (${r.need})`);
  ok(r.send >= NEED - 2_990_000, 'and is sent at least the shortfall');
  ok(r.send <= NEED - 2_990_000 + 300_000, `with only a little headroom (${r.send})`);
  ok(r.send < TU.MAX_PER_WALLET, '⛔ and never more than the per-wallet cap, whatever the arithmetic says');
  ok(r.coins.length === 2, 'both of their coins are named, so the owner knows what it unblocks');
}

console.log('\n── one launcher, one transfer, and the amounts are the plan\'s');
{
  const plan = await TU.topupPlan({ conn, db, MET });
  const from = addr();
  const { tx, total, count } = await TU.buildTopupTx({ conn, from, rows: plan.rows });
  ok(count === plan.rows.length, 'one transfer per blocked launcher');
  ok(tx.instructions.every((i) => i.programId.equals(SystemProgram.programId)), 'all of them system transfers');
  const sent = tx.instructions.reduce((a, i) => a + Number(i.data.readBigUInt64LE(4)), 0);
  ok(sent === total, `the transfers sum to exactly the plan (${sent})`);
  ok(tx.feePayer.toBase58() === from, 'paid by the signing wallet');
}

console.log('\n── it refuses rather than half-funding');
{
  const plan = await TU.topupPlan({ conn, db, MET });
  const poor = { ...conn, getBalance: async () => 1000 };
  let threw = null;
  await TU.buildTopupTx({ conn: poor, from: addr(), rows: plan.rows }).catch((e) => { threw = e.message; });
  ok(/holds/.test(threw || ''), `a payer who cannot cover it is told, not half-sent — "${String(threw).slice(0, 56)}…"`);
  let empty = null;
  await TU.buildTopupTx({ conn, from: addr(), rows: [] }).catch((e) => { empty = e.message; });
  ok(/nothing to fund/.test(empty || ''), 'and an empty list is refused rather than signed');
}

console.log('\n── ⛔ THE BROWSER CANNOT NAME AN ADDRESS OR AN AMOUNT');
{
  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const route = srv.slice(srv.indexOf("p === '/api/admin/topup' && m === 'POST'"), srv.indexOf("p === '/api/admin/topup' && m === 'POST'") + 1800);
  // ⛔ The GET may serve a two-minute-old cache; the POST may not. It is the one that spends.
  ok(/cachedTopupPlan\(\{ fresh: true \}\)/.test(route),
    'the POST re-derives the plan FRESH rather than trusting a cache or what was displayed');
  ok(!/body\.(amount|lamports|send)/.test(route), '⛔ no amount is read off the request');
  ok(/only\.has\(r\.wallet\)/.test(route), 'the caller may only NARROW the set, by address');
  ok(/adminOk\(\)/.test(route), 'and the whole thing is behind the admin gate');
  ok(/explainBeforeSending\(/.test(route), 'and it is simulated before the owner is asked to sign');
}

console.log('\n── ⛔ THE PANEL IS FILLED AFTER THE PAGE IS PAINTED, NOT BEFORE');
{
  // render() replaces root.innerHTML. A mount that runs before it finds no element, returns
  // silently, and leaves "Checking who cannot claim…" on screen for ever with no error anywhere.
  // That is what the owner saw: signed in, admin page rendered, both panels dead.
  const pg = fs.readFileSync(new URL('../public/pages.js', import.meta.url), 'utf8');
  const admin = pg.slice(pg.indexOf('export async function admin(root)'));
  const renderEnd = admin.indexOf('mountTopup();\n    mountLaunchLab();');
  ok(renderEnd > 0, 'the mounts are called from inside render()');
  const renderCall = admin.indexOf('\n  render();');
  ok(renderCall > renderEnd, '⛔ and render() is what triggers them, so the DOM exists first');
  ok(!/\n  mountTopup\(\);/.test(admin), 'there is no bare call before render()');
  ok(!/\n  mountLaunchLab\(\);/.test(admin), 'for either panel');
  ok(/if \(!body\) return;/.test(admin),
    'the mount still guards for a missing element — it just is not relied on to hide a bug');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
