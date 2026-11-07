import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cfg } from './config.mjs';
fs.mkdirSync(cfg.dataDir, { recursive: true });
fs.mkdirSync(path.join(cfg.dataDir, 'img'), { recursive: true });
export const db = new DatabaseSync(path.join(cfg.dataDir, cfg.dbName));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS wallets(wallet TEXT PRIMARY KEY, name TEXT, created_at INTEGER, last_seen INTEGER, faucet INTEGER DEFAULT 0, bot INTEGER DEFAULT 0, ref_code TEXT);
CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, wallet TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, wallet TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS balances(wallet TEXT, asset TEXT, amount REAL DEFAULT 0, PRIMARY KEY(wallet, asset));
CREATE TABLE IF NOT EXISTS tokens(
  mint TEXT PRIMARY KEY, name TEXT, symbol TEXT, description TEXT, image TEXT, website TEXT, twitter TEXT, telegram TEXT,
  creator TEXT, quote TEXT, tax_bps INTEGER DEFAULT 0, fair_open_secs INTEGER DEFAULT 0, fair_open_ends INTEGER, status TEXT,
  -- Fee module. Four buckets in bps of the quote leg of a SWAP; a send pays nothing. rex_bps is
  -- REX's share OF holder_bps, not a fifth fee. Each pot holds quote collected but not yet moved.
  holder_bps INTEGER DEFAULT 100, creator_bps INTEGER DEFAULT 0, vault_bps INTEGER DEFAULT 0, burn_bps INTEGER DEFAULT 0, buyback_bps INTEGER DEFAULT 0, rex_bps INTEGER DEFAULT 50,
  creator_pot REAL DEFAULT 0, vault_pot REAL DEFAULT 0, burn_pot REAL DEFAULT 0, buyback_pot REAL DEFAULT 0, rex_pot REAL DEFAULT 0,
  creator_paid REAL DEFAULT 0, vault_paid REAL DEFAULT 0, burn_paid REAL DEFAULT 0, buyback_paid REAL DEFAULT 0, rex_paid REAL DEFAULT 0,
  -- Advanced, all off by default. The allowlist only bites inside the Fair Open window; the cap and
  -- the decaying fee only bite for guard_secs seconds after the clear.
  burned_tokens REAL DEFAULT 0, rex_burned REAL DEFAULT 0, rex_bought REAL DEFAULT 0, vault_lp REAL DEFAULT 0, vault_bid REAL DEFAULT 0,
  ref_share_bps INTEGER DEFAULT 0, ref_paid REAL DEFAULT 0, creator_ref TEXT, creator_ref_paid REAL DEFAULT 0,
  allowlist TEXT, allow_rex_usd REAL DEFAULT 0, wallet_cap REAL DEFAULT 0, decay_fee_bps INTEGER DEFAULT 0, decay_to TEXT, guard_secs INTEGER DEFAULT 0,
  v_quote REAL, v_tokens REAL, real_quote REAL DEFAULT 0, real_tokens REAL, k REAL, raise_target REAL,
  amm_quote REAL DEFAULT 0, amm_tokens REAL DEFAULT 0,
  yield_pool REAL DEFAULT 0, yield_paid REAL DEFAULT 0, yield_payouts INTEGER DEFAULT 0, yield_epochs INTEGER DEFAULT 0,
  fair_open_total REAL DEFAULT 0, fair_open_bidders INTEGER DEFAULT 0, fair_open_price REAL DEFAULT 0,
  created_at INTEGER, opened_at INTEGER, graduated_at INTEGER, last_trade_at INTEGER,
  price REAL, trades INTEGER DEFAULT 0, holders INTEGER DEFAULT 0, volume REAL DEFAULT 0, dev_locked INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tokens_created ON tokens(created_at DESC);
CREATE TABLE IF NOT EXISTS holdings(wallet TEXT, mint TEXT, amount REAL DEFAULT 0, held_since INTEGER, cost REAL DEFAULT 0, realized REAL DEFAULT 0, yield_earned REAL DEFAULT 0, PRIMARY KEY(wallet, mint));
CREATE INDEX IF NOT EXISTS holdings_mint ON holdings(mint, amount DESC);
CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT, wallet TEXT, side TEXT, quote REAL, tokens REAL, price REAL, fee REAL, tax REAL, kind TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS trades_mint ON trades(mint, ts DESC);
CREATE INDEX IF NOT EXISTS trades_wallet ON trades(wallet, ts DESC);
CREATE INDEX IF NOT EXISTS trades_ts ON trades(ts DESC);
CREATE TABLE IF NOT EXISTS candles(mint TEXT, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL DEFAULT 0, n INTEGER DEFAULT 0, PRIMARY KEY(mint, ts));
CREATE TABLE IF NOT EXISTS bids(mint TEXT, wallet TEXT, amount REAL, ts INTEGER, PRIMARY KEY(mint, wallet));
CREATE TABLE IF NOT EXISTS payouts(id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT, wallet TEXT, amount REAL, mult REAL, epoch INTEGER, ts INTEGER);
CREATE INDEX IF NOT EXISTS payouts_wallet ON payouts(wallet, ts DESC);
CREATE INDEX IF NOT EXISTS payouts_mint ON payouts(mint, ts DESC);
-- ⛔ THE MONEY PATH OUT. Fees were being claimed into the fee-claimer wallet and then only
-- RECORDED as divided — applySplit writes bucket columns and moves nothing, runEpoch writes
-- payout rows and moves nothing — so 2.12M REX accumulated in one wallet and neither the protocol
-- wallets nor a single holder had ever received anything. These two tables are what makes a send
-- survivable: the signature is written here BEFORE the transaction is broadcast, and every balance
-- the send drains is itemised, so a crash between signing and confirming can be resolved by looking
-- the signature up on chain rather than by guessing.
--
-- sig is the primary key: re-recording the same signature is a no-op, which is what makes a retry
-- safe. settled_at/failed_at are set only after the chain has answered.
-- ⛔ KEYED BY (sig, dest), NOT BY sig. One transaction carries every waterfall leg, so a sig-only
-- primary key silently kept the FIRST leg and dropped the other four on INSERT OR IGNORE — the
-- record of where the money went would have been missing 90% of it while every balance still
-- reconciled. Re-recording the same leg of the same signature is still a no-op, which is what makes
-- a retry safe.
-- Feedback: a rating, a suggestion or a bug report, from anyone using the site. Elio, 5 Oct:
-- "add a rating box, 1-5 stars, and they can add a suggestion/ or report bug. Feedback is
-- important." status is what the admin panel moves: new -> seen -> done.
CREATE TABLE IF NOT EXISTS feedback(
  id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, kind TEXT, rating INTEGER, text TEXT,
  page TEXT, ts INTEGER, status TEXT DEFAULT 'new', note TEXT, handled_at INTEGER, handled_by TEXT
);
CREATE INDEX IF NOT EXISTS feedback_new ON feedback(ts DESC) WHERE status='new';
CREATE INDEX IF NOT EXISTS feedback_wallet ON feedback(wallet, ts DESC);
CREATE TABLE IF NOT EXISTS payout_sends(
  sig TEXT, kind TEXT, dest TEXT, quote_mint TEXT, amount TEXT, leg TEXT,
  created_at INTEGER, settled_at INTEGER, failed_at INTEGER, note TEXT,
  PRIMARY KEY(sig, dest)
);
CREATE INDEX IF NOT EXISTS payout_sends_sig ON payout_sends(sig);
CREATE INDEX IF NOT EXISTS payout_sends_open ON payout_sends(created_at) WHERE settled_at IS NULL AND failed_at IS NULL;
-- What each send drained, so a failed send can be put back exactly as it was. source is the
-- column it came out of ('rex_pot') or 'payout' for a holder row, and ref identifies the row.
CREATE TABLE IF NOT EXISTS payout_items(
  sig TEXT, source TEXT, ref TEXT, amount REAL,
  PRIMARY KEY(sig, source, ref)
);
CREATE TABLE IF NOT EXISTS epochs(id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT, pool REAL, holders INTEGER, ts INTEGER);
CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT, wallet TEXT, name TEXT, text TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS chat_mint ON chat(mint, ts DESC);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
-- Social / growth layer ------------------------------------------------------------------------
-- A referral is first-touch and permanent per (mint, referee): whoever brought you to a token keeps
-- the credit, so the incentive is to find new buyers rather than to re-tag existing ones.
CREATE TABLE IF NOT EXISTS referrals(
  mint TEXT, referee TEXT, referrer TEXT, volume REAL DEFAULT 0, earned REAL DEFAULT 0,
  vested INTEGER DEFAULT 0, vested_at INTEGER, rejected TEXT,
  first_seen INTEGER, PRIMARY KEY(mint, referee)
);
CREATE INDEX IF NOT EXISTS referrals_ref ON referrals(mint, referrer);
-- Who funded whom. A referral inside a funding cluster is somebody paying themselves, which is the
-- "common-funder wash" the spec excludes. Populated from on-chain funders and in-app transfers.
-- ⛔ POINTS ARE DERIVED AND THEREFORE MOVE UNDER YOUR FEET. That is the right design for a live
-- scoreboard and the wrong one for an airdrop: a score recomputed at claim time is a score that
-- changed between the promise and the payment, and the formula itself may change in between. A
-- snapshot is the one place a figure is deliberately frozen — written once, never recomputed, and
-- the only thing an allocation should ever be calculated from.
CREATE TABLE IF NOT EXISTS point_snapshots(
  epoch INTEGER, wallet TEXT, points REAL, base REAL, tier TEXT, multiplier REAL,
  downline REAL, taken_at INTEGER, PRIMARY KEY(epoch, wallet)
);
CREATE INDEX IF NOT EXISTS point_snap_epoch ON point_snapshots(epoch, points DESC);
CREATE TABLE IF NOT EXISTS funding(child TEXT PRIMARY KEY, parent TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS funding_parent ON funding(parent);
CREATE INDEX IF NOT EXISTS referrals_by ON referrals(referrer);
-- What each referrer is owed on a token, and what they have been paid.
CREATE TABLE IF NOT EXISTS ref_credit(mint TEXT, referrer TEXT, volume REAL DEFAULT 0, earned REAL DEFAULT 0, PRIMARY KEY(mint, referrer));
CREATE INDEX IF NOT EXISTS ref_credit_by ON ref_credit(referrer);
-- Milestones a token crosses. One row per (mint, kind) so a cast fires once and only once.
CREATE TABLE IF NOT EXISTS milestones(mint TEXT, kind TEXT, value REAL, ts INTEGER, PRIMARY KEY(mint, kind));
CREATE INDEX IF NOT EXISTS milestones_ts ON milestones(ts DESC);
-- Which wallets were holding when an epoch paid — the record behind "epochs survived".
CREATE TABLE IF NOT EXISTS epoch_held(wallet TEXT, mint TEXT, epoch INTEGER, PRIMARY KEY(wallet, mint, epoch));
CREATE INDEX IF NOT EXISTS epoch_held_w ON epoch_held(wallet);
-- Creator posts on their own token page: the update feed holders follow.
CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT, wallet TEXT, text TEXT, pinned INTEGER DEFAULT 0, ts INTEGER);
CREATE INDEX IF NOT EXISTS posts_mint ON posts(mint, ts DESC);
-- Callouts: a public call on a coin, with the price it was called at.
--
-- ⛔ price_at IS THE WHOLE POINT AND IT IS WRITTEN ONCE. A call whose entry can move is not a
-- call, it is a claim made afterwards — the entire value of a caller's record is that the number
-- was fixed before anyone knew the answer. Nothing updates this column.
CREATE TABLE IF NOT EXISTS callouts(id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, wallet TEXT NOT NULL,
  text TEXT, x_url TEXT, price_at REAL NOT NULL, mcap_at REAL, quote TEXT, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS callouts_mint ON callouts(mint, ts DESC);
CREATE INDEX IF NOT EXISTS callouts_wallet ON callouts(wallet, ts DESC);
CREATE INDEX IF NOT EXISTS callouts_ts ON callouts(ts DESC);
-- Post & earn: a post on X about REX Chain, claimed by the wallet that wrote it.
-- The UNIQUE index is on the post id, not the URL — one post has a dozen URL spellings (x.com vs
-- twitter.com, a ?s=46 tracking tail, a trailing slash) and a unique URL would let the same post be
-- claimed once per spelling. Lives here rather than in shareboost.mjs because points.mjs reads it
-- and must not depend on which module happened to be imported first.
CREATE TABLE IF NOT EXISTS share_posts(id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, url TEXT NOT NULL, post_id TEXT NOT NULL, handle TEXT, status TEXT NOT NULL DEFAULT 'pending', note TEXT, ts INTEGER NOT NULL, decided_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS share_posts_post ON share_posts(post_id);
CREATE INDEX IF NOT EXISTS share_posts_wallet ON share_posts(wallet, ts DESC);
CREATE INDEX IF NOT EXISTS share_posts_status ON share_posts(status, ts DESC);
-- On-chain mode: the program stores economics, these hold the off-chain parts of a launch.
CREATE TABLE IF NOT EXISTS token_meta(mint TEXT PRIMARY KEY, name TEXT, symbol TEXT, description TEXT, image TEXT, website TEXT, twitter TEXT, telegram TEXT, creator TEXT, created_at INTEGER);
-- Reward epochs: the merkle leaves are computed off-chain, so we keep them to serve proofs.
CREATE TABLE IF NOT EXISTS epoch_alloc(mint TEXT, epoch_index INTEGER, wallet TEXT, amount INTEGER, mult REAL, proof TEXT, root TEXT, ts INTEGER, PRIMARY KEY(mint, epoch_index, wallet));
CREATE INDEX IF NOT EXISTS epoch_alloc_wallet ON epoch_alloc(wallet);
`);
// Columns added after the first deploy. sqlite has no ADD COLUMN IF NOT EXISTS, so compare against
// the live table and add what is missing — a fresh database already has them from the CREATE above.
for (const [table, defs] of Object.entries({
  // `referred_by` is platform-level and first-touch: whoever brought this wallet to REX Chain earns
  // a standing share of every token it ever launches.
  // A wallet's public identity. `name` already existed and is the handle other people see; the rest
  // is the profile behind it. Kept on `wallets` rather than in its own table because every lookup
  // that wants a profile is already reading this row for the name.
  wallets: { ref_code: 'TEXT', referred_by: 'TEXT', referred_at: 'INTEGER',
    bio: 'TEXT', avatar: 'TEXT', x: 'TEXT', telegram: 'TEXT', website: 'TEXT', profile_at: 'INTEGER' },
  // The launcher's holder-reward choice, carried from the launch form to the tokens row. On
  // token_meta rather than only on tokens because for an ON-CHAIN launch the tokens row does not
  // exist yet when the choice is made — meta is saved before the create tx is even signed.
  token_meta: { reward_mode: 'TEXT' },
  // A referral is pending until the referee proves they are a real participant.
  referrals: { vested: 'INTEGER DEFAULT 0', vested_at: 'INTEGER', rejected: 'TEXT' },
  tokens: {
    // ⛔ A COIN CAN CARRY A TRANSFER HOOK, AND A BUYER HAS TO BE TOLD. The hook is a separate
    // program with a veto over every transfer — it can refuse a sell — and it cannot be removed
    // from an immutable mint. Stamped from the CHAIN at confirm, never from the client, because the
    // one party with a motive to hide it is the one submitting the form.
    hook_program: 'TEXT',
    holder_bps: 'INTEGER DEFAULT 100', creator_bps: 'INTEGER DEFAULT 0', vault_bps: 'INTEGER DEFAULT 0',
    burn_bps: 'INTEGER DEFAULT 0', buyback_bps: 'INTEGER DEFAULT 0', rex_bps: 'INTEGER DEFAULT 50',
    creator_pot: 'REAL DEFAULT 0', vault_pot: 'REAL DEFAULT 0', burn_pot: 'REAL DEFAULT 0', buyback_pot: 'REAL DEFAULT 0', rex_pot: 'REAL DEFAULT 0',
    creator_paid: 'REAL DEFAULT 0', vault_paid: 'REAL DEFAULT 0', burn_paid: 'REAL DEFAULT 0', rex_paid: 'REAL DEFAULT 0',
    burned_tokens: 'REAL DEFAULT 0', rex_burned: 'REAL DEFAULT 0', rex_bought: 'REAL DEFAULT 0', vault_lp: 'REAL DEFAULT 0', vault_bid: 'REAL DEFAULT 0',
    // Share of the CREATOR's own bucket routed to whoever brings the volume. Costs the protocol and
    // the holders nothing — it comes out of the creator's cut, so the 5% ceiling is untouched.
    // How the holder bucket is split between holders. Elio's call, 3 Oct: both modes ship, the
    // launcher picks, and the default is 'hold'.
    //   'hold' — Diamond Hands. weight = balance x conviction multiplier (1.0x..3.0x by hours held),
    //            so a three-day holder earns 3x what a fresh wallet of the same size earns, and any
    //            sell resets that clock. This is the default.
    //   'flat' — pro-rata to balance alone. Biggest bag wins, however briefly it has been held.
    // Stored per token rather than read from config so that changing the platform default can never
    // silently restate what a live launch promised its holders.
    reward_mode: "TEXT DEFAULT 'hold'",
    // WHERE this launch lives. 'rexpad' is our own bonding curve; 'dbc' is Meteora's, which is
    // indexed by DexScreener and Jupiter from the first trade. Stored rather than inferred: two
    // venues run side by side while the old launches finish, and guessing a venue from the shape of
    // a row is exactly the kind of inference that sends a swap to the wrong program.
    venue: "TEXT DEFAULT 'rexpad'",
    dbc_pool: 'TEXT', dbc_config: 'TEXT',
    // How far the swap indexer has walked this pool's history. Stored so a pass only ever reads
    // what is new: without it every pass would re-walk from the top and either re-count volume or
    // cost a full history fetch per cycle.
    dbc_last_sig: 'TEXT',
    // And how far BACK it has walked. A pool's history is only reachable newest-first, so without a
    // backward cursor the indexer would know about the most recent page and nothing before it —
    // $BITE's first 300 trades would never have been counted and its volume would read a fraction
    // of the truth for ever. Null once the walk has reached the beginning.
    dbc_back_sig: 'TEXT', dbc_backfilled: 'INTEGER DEFAULT 0',
    // Holder rewards that have ACCRUED ON THE POOL but not yet been claimed and split. Kept apart
    // from `yield_pool`, which is money already swept into the buckets: conflating them would
    // either understate what holders are owed or double-count it once a claim lands.
    pending_yield: 'REAL DEFAULT 0',
    // The single pool fee, and the launcher's share of it. The four buckets above now describe how
    // REX Chain's side of THIS fee is divided after it is claimed.
    pool_fee_bps: 'INTEGER DEFAULT 0', creator_share_pct: 'INTEGER DEFAULT 0',
    // AI dividends, per launch: 'off' or 'dividend'. 'off' by default and for every existing
    // launch — a model does not start deciding anything about someone's coin because we shipped a
    // feature. In 'dividend' mode lib/ai_alloc.mjs picks an asset off an allowlist and writes it
    // to `payout_assets` below, which the epoch already knows how to spend.
    //
    // ⛔ `ai_dividend_asset` WAS DECLARED HERE AND REMOVED ON 23 OCT. It was never written and
    // never read, and it was the wrong shape besides: the chosen asset has to live in the column
    // the epoch actually spends, not in a second one beside it. A second column is how
    // `payout_asset` happened — see below.
    ai_mode: "TEXT DEFAULT 'off'",
    // WHO gets paid, and in WHAT. Separate from reward_mode, which decides how much each of them
    // gets: 'all' pays every eligible holder, 'whale' only the biggest payout_n, 'shrimp' everyone
    // EXCEPT the biggest payout_n, 'equal' the same amount to each.
    payout_rule: "TEXT DEFAULT 'all'", payout_n: 'INTEGER DEFAULT 25',
    // ⛔ WHAT HOLDERS ARE PAID IN — AND THE ONE COLUMN THAT DOES IT. A JSON array of {asset, bps}
    // whose bps sum to exactly 10_000, so a coin can pay its holders in DOGE + WIF + SOL at once.
    // Stored as one value rather than a side table because it is read on every epoch and written
    // rarely, and because a partial basket must be impossible: a row summing to 9,700 would
    // silently underpay every holder forever and the shortfall would look like dust.
    //
    // ⛔ IT REPLACED `payout_asset`, WHICH WAS REMOVED ON 23 OCT AND MUST NOT COME BACK. That
    // column's own comment claimed it "swaps the fee before distributing". It did not. It was
    // written by the launch form, range-checked against a whitelist, surfaced in publicToken, and
    // READ BY NOTHING THAT PAYS — every coin on the board had it NULL, so no holder was ever paid
    // a single token through it, while a card on the launch form promised them $WIF.
    //
    // Both removals leave the columns in place on any database that already has them: the
    // migration below only ever ADDS. That is deliberate and it is fine — nothing writes or reads
    // them now, so they hold NULL forever. What must not happen is a new feature finding one of
    // them sitting there and deciding it looks useful.
    payout_assets: 'TEXT',
    ref_share_bps: 'INTEGER DEFAULT 0', ref_paid: 'REAL DEFAULT 0',
    // Who brought this launch's creator to the platform, snapshotted at launch so a later change of
    // referrer cannot retroactively redirect a live token's payouts.
    creator_ref: 'TEXT', creator_ref_paid: 'REAL DEFAULT 0',
    // The quote asset's MINT, written straight from the chain. `quote` holds a symbol, and a symbol
    // is a lossy name for a mint: an unrecognised one degrades to the mint's first four characters,
    // which can never be resolved back. Everything that needs the asset's decimals — the recorded
    // amounts, the adapter's prices — needs the mint, so the mint is stored rather than re-derived.
    quote_mint: 'TEXT',
    allowlist: 'TEXT', allow_rex_usd: 'REAL DEFAULT 0', wallet_cap: 'REAL DEFAULT 0',
    decay_fee_bps: 'INTEGER DEFAULT 0', decay_to: 'TEXT', guard_secs: 'INTEGER DEFAULT 0',
  },
  // DexScreener indexes by BLOCK, not by clock: its adapter asks "what happened between slot X and
  // slot Y", so a trade that does not know its slot cannot be answered with.
  // ev_ix is which Traded event this was WITHIN its transaction. One trade per signature is the
  // normal case, but the pair (sig, ev_ix) is what makes the row identifiable either way — and that
  // identity is what lets the live stream and the backfill both write a trade without counting it
  // twice. See `recordTrade` in indexer.mjs.
  trades: { slot: 'INTEGER', sig: 'TEXT', ev_ix: 'INTEGER' },
  // ⛔ A payout row used to be the END of the story — runEpoch wrote it and nothing ever paid it.
  // claim_sig is stamped when a send is signed for it and is what stops the same row being paid
  // twice by two concurrent claims; paid_at only lands once the chain has confirmed.
  //
  // ⛔ asset/asset_mint CARRY THE ROW'S OWN ASSET, because a row no longer has to be denominated in
  // its token's quote. A coin with a payout basket pays its holders in several assets at once, so
  // one epoch writes one row PER asset. Both columns are NULL on every row written before baskets
  // existed and on every coin that still pays in its quote — and NULL has to keep meaning exactly
  // that, because `holderDue` resolves the asset as COALESCE(p.asset_mint, t.quote_mint). Reading
  // a missing column as "no asset" instead of "the quote" would strand every historical payout.
  // ⛔ `delivered` IS WHAT THE CHAIN SAYS ARRIVED, WHICH IS NOT ALWAYS `amount`. paid_at used to be
  // stamped on nothing but a confirmed signature, so a row saying "100 GP" was marked paid in full
  // when the holder received 97 — GP, ZCAT and MASK take 3% on every transfer and SI takes 1%, and
  // a transfer fee is deducted in flight, not refused. The ledger then overstated what holders got,
  // which is the same lie as "Paid so far" counting allocations that were never sent.
  //
  // NULL means a row settled before this column existed, or a send whose transaction could not be
  // read back — NOT zero. Anything reporting on it has to keep those apart, so COALESCE to `amount`
  // rather than to 0 when summing historical rows.
  payouts: { claim_sig: 'TEXT', paid_at: 'INTEGER', asset: 'TEXT', asset_mint: 'TEXT', delivered: 'REAL' },
  // ⛔ WHAT A SHARER IS OWED IS NOT WHAT THEY HAVE BEEN PAID, and the two have to be kept apart or
  // a claim that does not land is indistinguishable from one that did. `owed` accrues every time
  // the creator claims a pool fee; `paid` only moves once a transaction has confirmed and the
  // transfer has been READ BACK off it. `earned` already existed and means the paper curve's
  // credit, which is a different thing on a different venue — it is left alone.
  ref_credit: { owed: 'REAL DEFAULT 0', paid: 'REAL DEFAULT 0' },
})) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [col, def] of Object.entries(defs)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
// Indexes over columns the migration may have just added have to come after it: on an existing
// database the CREATE block above runs while the column still does not exist.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS wallets_ref ON wallets(ref_code) WHERE ref_code IS NOT NULL');
// The affiliate tree walks DOWNWARD — "who did this wallet bring" — which is the opposite direction
// to how referred_by is normally read, so without this every level of every tree is a full scan.
db.exec('CREATE INDEX IF NOT EXISTS wallets_referred_by ON wallets(referred_by) WHERE referred_by IS NOT NULL');
db.exec('CREATE INDEX IF NOT EXISTS trades_slot ON trades(slot)');
// Rows written before ev_ix existed have a signature but no event index, so they would not collide
// with the backfill's own numbering and every one of them would be inserted a second time. Numbering
// them by insertion order within the signature reproduces exactly the order the event parser yields,
// which is the order the backfill will number them in.
db.exec(`UPDATE trades SET ev_ix = (SELECT COUNT(*) FROM trades t2 WHERE t2.sig = trades.sig AND t2.id < trades.id)
         WHERE sig IS NOT NULL AND ev_ix IS NULL`);
// The constraint the whole two-feed design rests on. Partial, because paper-mode trades have no
// signature and there can be any number of those.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS trades_sig_ev ON trades(sig, ev_ix) WHERE sig IS NOT NULL AND ev_ix IS NOT NULL');
// Pre-fee-module rows carried a single tax_bps; read it as the holder bucket so old launches keep paying.
db.exec('UPDATE tokens SET holder_bps = MAX(100, MIN(300, tax_bps)) WHERE tax_bps > 0 AND holder_bps = 100 AND creator_bps = 0 AND vault_bps = 0 AND burn_bps = 0');
// rex_bps changed meaning: it used to be a fraction of the holder bucket (2000 = 20% of it), it is
// now an absolute share of the trade (50 = 0.50%). A row left at the old value would charge 20% of
// every trade, so anything above the launch rate is clamped back to it.
db.exec('UPDATE tokens SET rex_bps = 50 WHERE rex_bps > 50');
export const meta = {
  get: (k) => db.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v ?? null,
  set: (k, v) => db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)),
};
let depth = 0;
// Re-entrant: nested calls join the outer transaction (an inner throw unwinds the whole thing).
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE'); depth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { depth--; }
}
