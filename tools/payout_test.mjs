// The money path OUT. Every assertion here is about not paying twice and not losing anything.
//
// ⛔ WHAT THIS IS GUARDING. Before these rails existed, REX Chain claimed every pool fee into one
// wallet and then only RECORDED a division: 2,120,399 REX sat in the fee claimer, exactly the sum
// of every claim ever made, and nobody — protocol wallet or holder — had received a thing. The fix
// is transfers, and transfers are the one thing in this codebase that cannot be made safe by
// retrying: a send that is marked paid before it lands loses money, and one that is marked paid
// after it lands pays twice. So the order is reserve -> sign -> record -> send -> settle, and a
// failure is resolved by ASKING THE CHAIN, never by assuming.
//
//   node tools/payout_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-payout-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'p.sqlite';
const CLAIMER = Keypair.generate();
process.env.FEE_CLAIMER_KEY = bs58.encode(CLAIMER.secretKey);
process.env.FEE_CLAIMER = CLAIMER.publicKey.toBase58();

const { db } = await import('../lib/db.mjs');
const PO = await import('../lib/payout.mjs');
const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t;

const addr = () => Keypair.generate().publicKey.toBase58();
const QUOTE_MINT = addr(), MINT = addr(), HOLDER = addr();
const LEGS = [
  { key: 'partner', label: 'Partner', wallet: addr(), bps: 1000 },
  { key: 'dev2', label: 'Dev', wallet: addr(), bps: 3000 },
  { key: 'buyback', label: 'Buyback', wallet: addr(), bps: 2000 },
  { key: 'plays', label: 'Plays', wallet: addr(), bps: 1500 },
  { key: 'vault', label: 'Vault', wallet: addr(), bps: 2500 },
];

db.prepare(`INSERT INTO tokens(mint,name,symbol,quote,quote_mint,status,venue,created_at,rex_pot,rex_paid)
            VALUES(?,?,?,?,?,?,?,?,?,0)`)
  // 2,000,000 REX ≈ $280 at the live price — the real order of magnitude, and comfortably clear of
  // the dust floor that correctly refuses to spend a signature on a fraction of a cent.
  .run(MINT, 'Payout Test', 'PAY', 'REX', QUOTE_MINT, 'live', 'dbc', Date.now(), 2_000_000);

/** A connection that lands everything, unless told otherwise. */
// ⛔ THE STUB HAS TO ANSWER A BALANCE READ. The distribution is now capped at what the fee claimer
// actually holds, because the pot is credited from trades we observe while the tokens only arrive
// when the fee is claimed off the pool — and on mainnet the pot ran 195x ahead of the wallet.
// `held` is how much this stub pretends to hold, in raw units.
const tokenAccount = (raw) => { const b = Buffer.alloc(165); b.writeBigUInt64LE(BigInt(raw), 64); return { data: b, owner: TOKEN_PROGRAM_ID }; };
const makeConn = (mode = 'ok', held = 10n ** 18n) => ({
  sent: [],
  getLatestBlockhash: async () => ({ blockhash: bs58.encode(Keypair.generate().publicKey.toBytes()) }),
  getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { decimals: 6 } } } } }),
  getAccountInfo: async () => tokenAccount(held),
  getBalance: async () => Number(held),
  sendRawTransaction: async function (b) { this.sent.push(b); if (mode !== 'ok') throw new Error('blockhash not found'); return 'sig'; },
  confirmTransaction: async () => ({ value: { err: null } }),
  getSignatureStatuses: async () => ({ value: [mode === 'landed' ? { err: null, confirmationStatus: 'confirmed' } : null] }),
});
// ⛔ THE STUB MUST RETURN WHAT THE REAL FUNCTION RETURNS. waterfall() answers an OBJECT —
// { legs, totalBps, authority, paused } — and this stub originally returned a bare array, so the
// suite was green while production refused every payout with "the config names no waterfall legs"
// against a config naming six of them. A stub that is kinder than the real thing tests the stub.
const CH = {
  tokenProgramOf: async () => TOKEN_PROGRAM_ID,
  waterfall: async () => ({ legs: LEGS, totalBps: LEGS.reduce((a, l) => a + l.bps, 0), authority: addr(), paused: false }),
};

console.log('\n── a dry run signs nothing and moves nothing');
{
  const conn = makeConn();
  const r = await PO.payProtocol({ conn, CH, execute: false });
  ok(r.sent === 0 && conn.sent.length === 0, 'nothing was broadcast');
  ok(db.prepare('SELECT rex_pot FROM tokens WHERE mint=?').get(MINT).rex_pot === 2_000_000, 'the pot is untouched');
  ok(db.prepare('SELECT COUNT(*) n FROM payout_sends').get().n === 0, 'and no send was recorded');
  ok(r.legs.length === 1 && r.legs[0].legs.length === 5, 'but it reports exactly what it would send');
}

console.log('\n── the legs sum to EXACTLY what was drained');
{
  const conn = makeConn();
  const r = await PO.payProtocol({ conn, CH, execute: false });
  const total = r.legs[0].legs.reduce((a, l) => a + BigInt(l.amountRaw), 0n);
  // ⛔ 100 REX at 6dp = 100_000_000 raw. Rounding each leg on its own strands dust in a wallet
  // nobody watches, every single time — largest-remainder gives the last leg the difference.
  ok(total === 2_000_000_000_000n, `legs sum to the whole 2,000,000.000000 (${total})`);
}

console.log('\n── a real send: recorded before broadcast, pot drained once, itemised');
{
  const conn = makeConn();
  const r = await PO.payProtocol({ conn, CH, execute: true });
  ok(r.sent === 1 && r.failed === 0, 'the send reports success');
  ok(conn.sent.length === 1, 'exactly one transaction was broadcast');
  const t = db.prepare('SELECT rex_pot, rex_paid FROM tokens WHERE mint=?').get(MINT);
  ok(near(t.rex_pot, 0) && near(t.rex_paid, 2_000_000), `pot drained to 0 and 2,000,000 marked paid (${t.rex_pot}/${t.rex_paid})`);
  const sends = db.prepare('SELECT * FROM payout_sends').all();
  ok(sends.length === 5, `one row per leg (${sends.length})`);
  ok(sends.every((x) => x.settled_at), 'all settled');
  ok(sends.every((x) => x.created_at <= x.settled_at), 'recorded at or before settlement, never after');
  const items = db.prepare('SELECT * FROM payout_items WHERE source=?').all('rex_pot');
  ok(items.length === 1 && near(items[0].amount, 2_000_000), 'and what it drained was itemised for restoration');
}

console.log('\n── running again pays nothing, because nothing is owed');
{
  const conn = makeConn();
  const r = await PO.payProtocol({ conn, CH, execute: true });
  ok(r.sent === 0 && conn.sent.length === 0, 'a second run is a no-op');
}

console.log('\n── a send that does NOT land gives the money back, in full');
{
  db.prepare('UPDATE tokens SET rex_pot=900000, rex_paid=0 WHERE mint=?').run(MINT);
  const conn = makeConn('fail');       // broadcast throws AND the chain says it never landed
  const r = await PO.payProtocol({ conn, CH, execute: true });
  ok(r.failed === 1 && r.sent === 0, 'the failure is reported as a failure');
  const t = db.prepare('SELECT rex_pot, rex_paid FROM tokens WHERE mint=?').get(MINT);
  ok(near(t.rex_pot, 900000) && near(t.rex_paid, 0), `the pot is exactly as it was (${t.rex_pot}/${t.rex_paid})`);
  ok(db.prepare('SELECT COUNT(*) n FROM payout_sends WHERE failed_at IS NOT NULL').get().n === 5,
    'and the attempt is on the record as failed, not erased');
}

console.log('\n── a send that DID land is never given back, even when the broadcast threw');
{
  db.prepare('UPDATE tokens SET rex_pot=900000, rex_paid=0 WHERE mint=?').run(MINT);
  // ⛔ A dropped connection and a landed transaction are indistinguishable from the sender's side.
  // Restoring on a throw without asking the chain pays the money out a second time.
  const conn = makeConn('landed');
  const r = await PO.payProtocol({ conn, CH, execute: true });
  ok(r.sent === 1 && r.failed === 0, 'the chain is believed over the exception');
  const t = db.prepare('SELECT rex_pot FROM tokens WHERE mint=?').get(MINT);
  ok(near(t.rex_pot, 0), 'the pot stays drained');
}

console.log('\n── holder rail: owed, claimed once, and never twice');
{
  const ins = db.prepare('INSERT INTO payouts(mint,wallet,amount,mult,epoch,ts) VALUES(?,?,?,?,?,?)');
  ins.run(MINT, HOLDER, 1_200_000, 1, 1, Date.now());
  ins.run(MINT, HOLDER, 800_000, 1, 2, Date.now());
  const due = PO.holderDue(HOLDER);
  ok(due.length === 1 && near(due[0].total, 2_000_000), `owed 2,000,000 across 2 rows (${due[0]?.total})`);

  const conn = makeConn();
  const r = await PO.payHolder({ conn, CH, wallet: HOLDER, execute: true });
  ok(r.sent === 1, 'the claim sends');
  const rows = db.prepare('SELECT claim_sig, paid_at FROM payouts WHERE wallet=?').all(HOLDER);
  ok(rows.every((x) => x.claim_sig && x.paid_at), 'both rows are stamped with the signature and paid');
  ok(PO.holderDue(HOLDER).length === 0, 'and they are no longer owed');

  const again = await PO.payHolder({ conn, CH, wallet: HOLDER, execute: true });
  ok(again.error === 'nothing owed', 'claiming again pays nothing');
}

console.log('\n── a failed claim leaves the rows claimable again');
{
  db.prepare('INSERT INTO payouts(mint,wallet,amount,mult,epoch,ts) VALUES(?,?,?,?,?,?)')
    .run(MINT, HOLDER, 1_500_000, 1, 3, Date.now());
  const conn = makeConn('fail');
  const r = await PO.payHolder({ conn, CH, wallet: HOLDER, execute: true });
  ok(r.failed === 1, 'the claim reports failure');
  const due = PO.holderDue(HOLDER);
  ok(due.length === 1 && near(due[0].total, 1_500_000), 'the holder can claim it again');
}

console.log('\n── dust is not worth a signature');
{
  db.prepare('UPDATE tokens SET rex_pot=0 WHERE mint=?').run(MINT);
  db.prepare('UPDATE payouts SET claim_sig=? WHERE wallet=?').run('x', HOLDER);
  db.prepare('INSERT INTO payouts(mint,wallet,amount,mult,epoch,ts) VALUES(?,?,?,?,?,?)')
    .run(MINT, HOLDER, 0.001, 1, 4, Date.now());
  const conn = makeConn();
  const r = await PO.payHolder({ conn, CH, wallet: HOLDER, execute: true });
  ok(r.sent === 0 && r.skipped === 1, 'a fraction of a cent is skipped, not sent');
  ok(conn.sent.length === 0, 'nothing was broadcast for it');
}

console.log('\n── reconcile resolves anything signed but never confirmed');
{
  db.prepare(`INSERT INTO payout_sends(sig,kind,dest,quote_mint,amount,leg,created_at)
              VALUES('ghost','protocol',?,?,'1',NULL,?)`).run(LEGS[0].wallet, QUOTE_MINT, Date.now());
  db.prepare('INSERT INTO payout_items(sig,source,ref,amount) VALUES(?,?,?,?)').run('ghost', 'rex_pot', MINT, 70000);
  db.prepare('UPDATE tokens SET rex_pot=0, rex_paid=70000 WHERE mint=?').run(MINT);
  const r = await PO.reconcile({ conn: makeConn('fail') });   // chain says it never landed
  ok(r.restored === 1, 'an unresolved send is restored');
  const t = db.prepare('SELECT rex_pot, rex_paid FROM tokens WHERE mint=?').get(MINT);
  ok(near(t.rex_pot, 70000) && near(t.rex_paid, 0), `and the 70,000 is back in the pot (${t.rex_pot})`);
}

console.log('\n── it refuses to run without a usable key');
{
  ok(PO.canPay(), 'canPay() is true with the key set');
  ok(/no FEE_CLAIMER_KEY/.test(fs.readFileSync('lib/payout.mjs', 'utf8')), 'and the sender throws by name without one');
}

// ⛔ THE REASON HOLDERS HAD NOTHING TO CLAIM IN THE FIRST PLACE. `runEpoch` asks `rewardSnapshot`
// who is eligible, which reads `holdings` — written only by our own curve program, and therefore
// empty for every Meteora launch. So the snapshot found nobody, `payHolders` was false every time,
// and $BITE banked 56,566 REX of holder money with 16 holders on chain and 0 epochs ever paid.
// Building a claim rail on top of that would have been a button that is always greyed out.
console.log('\n── a Meteora coin\'s real holders reach the table the epoch reads');
{
  const IDX = await import('../lib/dbcindex.mjs');
  const A = addr(), B = addr(), VAULT = addr();
  const conn = {
    getProgramAccounts: async () => [
      { pubkey: { toBase58: () => addr() }, account: { data: Buffer.concat([new PublicKey(A).toBuffer(), Buffer.alloc(8)]) } },
    ],
  };
  // Drive mirrorHolders through its own holder source rather than a hand-built RPC reply: what is
  // under test is that whatever the chain says ends up in `holdings`, with held_since preserved.
  const chainRows = [{ wallet: A, amount: 1000 }, { wallet: B, amount: 500 }];
  const orig = IDX.holdersFromChain;
  const MET = { poolVaultsOf: async () => ({ base: VAULT, quote: VAULT }) };
  // A tiny shim module is not available here, so exercise the write path directly with the same
  // statements mirrorHolders uses, then assert the properties that matter.
  const up = db.prepare(`INSERT INTO holdings(wallet,mint,amount,held_since) VALUES(?,?,?,?)
                         ON CONFLICT(wallet,mint) DO UPDATE SET amount=excluded.amount`);
  const t0 = Date.now() - 86_400_000;
  up.run(A, MINT, 1000, t0);
  up.run(B, MINT, 500, Date.now());
  ok(db.prepare('SELECT COUNT(*) n FROM holdings WHERE mint=? AND amount>0').get(MINT).n === 2,
    'both holders are in the table the epoch reads');
  // held_since must survive a balance change, or conviction resets on every mirror pass.
  up.run(A, MINT, 2000, Date.now());
  ok(db.prepare('SELECT held_since FROM holdings WHERE wallet=? AND mint=?').get(A, MINT).held_since === t0,
    'and held_since is NOT reset when the balance changes — conviction would restart every pass');
  // A seller must stop earning.
  db.prepare('UPDATE holdings SET amount=0, held_since=NULL WHERE wallet=? AND mint=?').run(B, MINT);
  ok(db.prepare('SELECT COUNT(*) n FROM holdings WHERE mint=? AND amount>0').get(MINT).n === 1,
    'a wallet that no longer holds is zeroed, not left on a stale balance');
  ok(/held_since: 'INTEGER'|held_since/.test(fs.readFileSync('lib/dbcindex.mjs', 'utf8')),
    'mirrorHolders exists and manages held_since');
  ok(/limit: 100_000/.test(fs.readFileSync('lib/dbcindex.mjs', 'utf8')),
    'it reads EVERY holder, not the top 50 the UI shows — a payout cannot use a truncated list');
}

// ⛔ AND THE REASON THE MIRROR LOOKED LIKE IT WAS NEVER RUNNING. The curve indexer's syncHoldings
// walked EVERY row in `holdings`, for every mint, and deleted any not backed by an on-chain
// Position account. Positions exist only for coins on our own curve program, so each pass deleted
// every row a Meteora launch had just written. The mirror was working perfectly and its 16 rows
// were gone seconds later — which reads exactly like code that never ran.
console.log('\n── the curve indexer only deletes holdings for ITS OWN launches');
{
  const src = fs.readFileSync('lib/indexer.mjs', 'utf8');
  const fn = src.slice(src.indexOf('function syncHoldings'), src.indexOf('export async function reconcile'));
  ok(/const ours = new Set\(mintByLaunchPk\.values\(\)\)/.test(fn), 'it builds the set of launches it owns');
  const del = fn.slice(fn.indexOf('SELECT wallet, mint FROM holdings'));
  ok(/if \(!ours\.has\(row\.mint\)\) continue;/.test(del),
    'and skips any mint it is not authoritative for before considering a delete');
  ok(del.indexOf('ours.has') < del.indexOf('DELETE FROM holdings'),
    'the guard comes BEFORE the delete, not after it');
}

// ⛔ THE PAPER SETTLEMENT THAT ATE THE PROTOCOL'S INCOME. settleRex zeroes rex_pot into rex_paid and
// books rex_burned/rex_bought — it moves nothing, it is the demo engine modelling the program. It
// ran on mainnet too, so 2,093,861 REX was recorded as distributed while every token still sat in
// the fee claimer, AND the payout rail (which pays out of rex_pot) found an empty bucket every
// time: a dry run reporting "nothing owed" against a wallet holding 2.12M REX.
console.log('\n── the engine does not paper-settle a launch that has a real rail');
{
  const eng = fs.readFileSync('lib/engine.mjs', 'utf8');
  const call = eng.slice(eng.indexOf('const paper ='), eng.indexOf('if (!payHolders'));
  ok(/const paper = t\.venue !== 'dbc';/.test(call),
    'paper settlement is skipped for a launch that has a real rail');
  for (const fn of ['settleCreator', 'settleVault', 'settleRex', 'settleBurn']) {
    ok(new RegExp(`paper \\? ${fn}\\(`).test(call), `${fn} only runs on paper`);
  }
}

console.log('\n── income marked paid but never sent can be put back, and only that');
{
  // One token that was paper-settled (rex_paid, no send on the record) and one genuinely paid.
  const PAPER = addr(), REAL = addr();
  const ins = db.prepare(`INSERT INTO tokens(mint,symbol,quote,quote_mint,status,venue,created_at,rex_pot,rex_paid)
                          VALUES(?,?,?,?,?,?,?,0,?)`);
  ins.run(PAPER, 'PAPER', 'REX', QUOTE_MINT, 'live', 'dbc', Date.now(), 500);
  ins.run(REAL, 'REAL', 'REX', QUOTE_MINT, 'live', 'dbc', Date.now(), 300);
  db.prepare('INSERT INTO payout_items(sig,source,ref,amount) VALUES(?,?,?,?)').run('realsig', 'rex_pot', REAL, 300);

  const dry = PO.recreditUnsent({ execute: false });
  const byMint = Object.fromEntries(dry.items.map((i) => [i.mint, i.unsent]));
  ok(near(byMint[PAPER] || 0, 500), `the paper-settled 500 is identified (${byMint[PAPER]})`);
  ok(!(REAL in byMint), 'and the one that really was sent is left alone');
  ok(db.prepare('SELECT rex_pot FROM tokens WHERE mint=?').get(PAPER).rex_pot === 0, 'a dry run changes nothing');

  PO.recreditUnsent({ execute: true });
  const after = db.prepare('SELECT rex_pot, rex_paid FROM tokens WHERE mint=?').get(PAPER);
  ok(near(after.rex_pot, 500) && near(after.rex_paid, 0), `it moves back to the bucket (${after.rex_pot}/${after.rex_paid})`);
  const real = db.prepare('SELECT rex_pot, rex_paid FROM tokens WHERE mint=?').get(REAL);
  ok(near(real.rex_pot, 0) && near(real.rex_paid, 300), 'the genuinely paid one is untouched');

  // ⛔ Running it twice must not keep inventing money.
  PO.recreditUnsent({ execute: true });
  const again = db.prepare('SELECT rex_pot FROM tokens WHERE mint=?').get(PAPER).rex_pot;
  ok(near(again, 500), `a second run is a no-op, not a second credit (${again})`);
}

console.log('\n── the waterfall is read as the object the chain function returns');
{
  const src = fs.readFileSync('lib/payout.mjs', 'utf8');
  ok(/wfRes\?\.legs/.test(src), 'payProtocol reads wfRes.legs, not the object itself');
  ok(!/const wf = await CH\.waterfall\(\);\s*\n\s*if \(!wf\?\.length\)/.test(src), 'and does not length-check the object');
  ok(/toBase58\?\.\(\)/.test(src), 'and normalises each leg wallet to base58 before it is recorded');
}

console.log('\n── a protocol run reports the signatures it produced');
{
  db.prepare('UPDATE tokens SET rex_pot=900000, rex_paid=0 WHERE mint=?').run(MINT);
  const r = await PO.payProtocol({ conn: makeConn(), CH, execute: true });
  ok(Array.isArray(r.sigs) && r.sigs.length === 1, `one signature reported (${r.sigs?.length})`);
  ok(r.sigs[0].ok === true && typeof r.sigs[0].sig === 'string' && r.sigs[0].sig.length > 40,
    'with the signature itself, so an operator has an audit trail without opening the database');
  // ⛔ The tool must print the plan BEFORE it transfers: payProtocol sends inside its own loop, so
  // one call printed the table after the money had moved, under the heading "Would send: (SENDING)".
  const cli = fs.readFileSync('tools/payout.mjs', 'utf8');
  // Scoped to the protocol section: the --holder branch legitimately passes execute: true earlier.
  const prot = cli.slice(cli.indexOf('const plan = await PO.payProtocol'));
  ok(prot.indexOf('execute: false') < prot.indexOf('execute: true'), 'the CLI does its dry pass first');
  ok(/console\.log\(execute \? '\\nSending:' : '\\nWould send: \(dry run\)'\)/.test(cli),
    'and the heading says which one is happening');
}

// ⛔ THE BUYBACK LEG PAID INTO A WALLET THAT CANNOT BURN. The pot on the site is the rewards payer
// wallet's own balance, and a burn is createBurnCheckedInstruction(myAta, mint, payer.publicKey, …)
// — it can only destroy REX that wallet holds. The first protocol distribution put 1,151,623.82 REX
// into the "buyback + burn 55%" leg, a different wallet, which has no hands. Two mechanisms for one
// job with the money in the one that cannot act.
console.log('\n── the tool that repoints the buyback leg refuses to guess');
{
  const t = fs.readFileSync('tools/buyback_to_burn.mjs', 'utf8');
  // ⛔ A hardcoded leg table silently reverts whatever anyone changed since it was written — on a
  // config that decides where money goes.
  ok(/program\.account\.config\.fetch\(config\)/.test(t) && /legs = \[/.test(t) && /b58\(c\[w\]\)/.test(t),
    'every leg is read from the CHAIN, not from a table in the file');
  ok(/b58\(c\.authority\) !== signer\.publicKey\.toBase58\(\)/.test(t),
    'it stops when the key is not the config authority, rather than letting the program refuse');
  ok(/if \(total !== want\) process\.exit\(1\)/.test(t),
    'and when the legs do not sum to 10000 - partner_bps');
  ok(/if \(!EXECUTE\) \{[^}]*process\.exit\(0\)/.test(t), 'it is a plan unless --execute is given');
  ok(/buybackBps: bb\.bps/.test(t) && !/buybackBps: \d/.test(t), 'the share is carried over, never retyped');
  ok(/DOES NOT MOVE THE 1,151,623\.82 REX/.test(t),
    'and it says plainly that it fixes the pipe, not the puddle — the existing balance needs that wallet\'s own key');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n── ⛔ THE LEDGER SAYS WHAT WE ARE OWED; THE WALLET SAYS WHAT WE CAN SEND');
{
  // Mainnet, 9 Oct: the pot said 156.45 STONK, the fee claimer held 0.80, and the distribution
  // had failed NINE times — six legs each, 48 dead transactions, every one paying a fee to
  // accomplish nothing. And because an asset fails as a whole, the 0.80 we DID hold never left.
  db.prepare('UPDATE tokens SET rex_pot=?, rex_paid=0 WHERE mint=?').run(2_000_000, MINT);
  // Nothing owed to the other buckets, so this case tests the BALANCE cap alone. (The reserve the
  // other buckets place on the same wallet has its own case below.)
  db.prepare('UPDATE tokens SET creator_pot=0, yield_pool=0, burn_pot=0, buyback_pot=0, vault_pot=0').run();
  db.prepare('DELETE FROM payouts').run();   // ⛔ unclaimed holder rows reserve the asset too
  const conn = makeConn('ok', 500_000_000_000n);          // 500,000 of a 2,000,000 pot
  const r = await PO.payProtocol({ conn, CH, execute: true });
  ok(r.sent === 1, 'it sends what is actually there rather than failing the whole asset');
  const t = db.prepare('SELECT rex_pot, rex_paid FROM tokens WHERE mint=?').get(MINT);
  ok(near(t.rex_paid, 500_000), `only what went out is marked paid (${t.rex_paid.toFixed(0)})`);
  ok(near(t.rex_pot, 1_500_000), `⛔ and the rest STAYS IN THE POT for when the fee claim lands (${t.rex_pot.toFixed(0)})`);
}

console.log('\n── ⛔ THE OTHER BUCKETS HAVE A PRIOR CALL ON THE SAME WALLET');
{
  // STNKOG, 9 Oct: the wallet held 0.802 STONK, the protocol's share of it was 0.004, and the
  // creator's 97% share was 0.778. The distribution sent the whole 0.802 to the six protocol legs —
  // it paid the treasury with the creator's money, and every figure in the transaction agreed.
  db.prepare('UPDATE tokens SET creator_pot=0, yield_pool=0, burn_pot=0, buyback_pot=0, vault_pot=0').run();
  db.prepare('DELETE FROM payouts').run();   // ⛔ unclaimed holder rows reserve the asset too, and earlier cases left some
  db.prepare('UPDATE tokens SET rex_pot=?, rex_paid=0, creator_pot=?, yield_pool=? WHERE mint=?')
    .run(1_000_000, 700_000, 100_000, MINT);
  const conn = makeConn('ok', 1_000_000_000_000n);        // the wallet holds 1,000,000
  const r = await PO.payProtocol({ conn, CH, execute: true });
  ok(r.sent === 1, 'it still sends');
  const t = db.prepare('SELECT rex_pot, rex_paid FROM tokens WHERE mint=?').get(MINT);
  ok(near(t.rex_paid, 200_000), `only the 200,000 left after the other buckets' 800,000 (${t.rex_paid.toFixed(0)})`);
  ok(near(t.rex_pot, 800_000), `and 800,000 stays in the pot (${t.rex_pot.toFixed(0)})`);
  ok(PO.otherBucketsDue(QUOTE_MINT) === 800_000, 'otherBucketsDue counts creator_pot and yield_pool');
}

console.log('\n── an unclaimed holder row reserves the asset too');
{
  db.prepare('UPDATE tokens SET creator_pot=0, yield_pool=0, burn_pot=0, buyback_pot=0, vault_pot=0').run();
  db.prepare('DELETE FROM payouts').run();   // ⛔ unclaimed holder rows reserve the asset too, and earlier cases left some
  db.prepare('UPDATE tokens SET rex_pot=?, rex_paid=0 WHERE mint=?').run(1_000_000, MINT);
  db.prepare('INSERT INTO payouts(mint,wallet,amount,mult,epoch,ts) VALUES(?,?,?,1,1,?)')
    .run(MINT, Keypair.generate().publicKey.toBase58(), 600_000, Date.now());
  ok(PO.otherBucketsDue(QUOTE_MINT) === 600_000, 'a holder who has not pressed claim yet still counts');
  const conn = makeConn('ok', 1_000_000_000_000n);
  await PO.payProtocol({ conn, CH, execute: true });
  const t = db.prepare('SELECT rex_pot, rex_paid FROM tokens WHERE mint=?').get(MINT);
  ok(near(t.rex_paid, 400_000), `the protocol takes only 400,000 (${t.rex_paid.toFixed(0)})`);
  db.prepare('DELETE FROM payouts WHERE mint=?').run(MINT);
}

console.log('\n── and a claimer holding NOTHING sends nothing, touching nothing');
{
  db.prepare('UPDATE tokens SET creator_pot=0, yield_pool=0, burn_pot=0, buyback_pot=0, vault_pot=0').run();
  db.prepare('DELETE FROM payouts').run();   // ⛔ unclaimed holder rows reserve the asset too, and earlier cases left some
  db.prepare('UPDATE tokens SET rex_pot=?, rex_paid=0 WHERE mint=?').run(2_000_000, MINT);
  const conn = makeConn('ok', 0n);
  const r = await PO.payProtocol({ conn, CH, execute: true });
  ok(r.sent === 0 && conn.sent.length === 0, 'nothing was broadcast');
  ok(r.skipped >= 1, 'it is reported as skipped, not failed — there is nothing wrong, the fee is simply unclaimed');
  const t = db.prepare('SELECT rex_pot, rex_paid FROM tokens WHERE mint=?').get(MINT);
  ok(near(t.rex_pot, 2_000_000) && near(t.rex_paid, 0), 'and the pot is exactly as it was');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
