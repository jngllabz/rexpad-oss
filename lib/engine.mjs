// FORGE engine — bonding curve (constant-product virtual reserves, LaunchLab/pump-compatible sizing),
// Fair Open sealed-batch opening, Conviction Yield epochs, graduation into a burned-LP AMM.
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { db, tx } from './db.mjs';
import { cfg, log } from './config.mjs';
import { QUOTES, usdOf, payableAsset } from './prices.mjs';

export const TOTAL_SUPPLY = 1_000_000_000;
export const CURVE_TOKENS = 793_100_000;           // sold on the curve
export const V_TOKENS0 = 1_073_000_000;            // initial virtual token reserve
export const LP_TOKENS = TOTAL_SUPPLY - CURVE_TOKENS; // 206.9M seeded into the AMM at graduation (price-continuous)
export const V_SOL0 = 30;
// The raise falls out of the constants (30 × (1.073B / 279.9M − 1) = 85.0054 SOL) — "worth 85 SOL" in the chosen quote.
export const RAISE_SOL = V_SOL0 * (V_TOKENS0 / (V_TOKENS0 - CURVE_TOKENS) - 1);
// There is NO separate platform fee. The locked spec caps the whole take at 4% and puts REX's
// revenue inside the holder bucket only ("REX is not a fifth fee"), and its own comparison table
// marks Stonk down for charging "tax plus swap fee". Charging 1% on top would make us that.
// These stay at zero so the paper engine matches the contract exactly; the program has no
// equivalent deduction at all.
export const PLATFORM_FEE_BPS = 0;
export const AMM_FEE_BPS = 0;
// Fee module, per the locked spec. Four buckets in HALF-POINT steps, taken in the quote asset on
// SWAPS ONLY — a send pays nothing, and the fee is never taken in the launched token.
export const FEE_STEP_BPS = 50;      // half a percent is a real setting, not a rounded default
export const HOLDER_MIN_BPS = 100;   // rewards 1%…
export const HOLDER_MAX_BPS = 300;   // …to 3%
export const SIDE_MAX_BPS = 100;     // creator / burn / buyback ceiling, 1% each
export const VAULT_MAX_BPS = 200;    // Value / Vault runs to 2%
export const FEE_CAP_BPS = 500;      // 5% hard ceiling — no launch configures an unlimited stack
export const MAX_TAX_BPS = FEE_CAP_BPS; // legacy alias
// The REX protocol fee is an ABSOLUTE share of the trade, carved out of the holder allocation —
// not a fraction of it. It steps down as the launch hits market-cap milestones, and whatever REX
// gives up goes straight back to holders.
export const REX_TIERS = [50, 45, 40, 35, 30, 25, 20].map((bps, i) => ({ step: i, bps, label: (bps / 100).toFixed(2) + '%' }));
export const REX_TIER_LAUNCH_BPS = 50;
export const REX_TIER_FLOOR_BPS = 20;
export const REX_SLICE = { burn: 0.20, buyback: 0.60, lp: 0.20 }; // of REX's own cut
export const VAULT_SPLIT = { lp: 0.70, bid: 0.30 };               // concentrated LP / quote bid
export const REWARD_FLOOR_USD = cfg.rewardFloorUsd; // a holder under the quote equivalent of $20 is skipped
// "Dev buy is escrowed into the same clear and capped." The memo names no number, so this is ours:
// the creator may commit at most 20% of the raise. Mirrors DEV_COMMIT_MAX_BPS in the program.
export const DEV_COMMIT_MAX_BPS = 2000;
// 30 seconds is too short; instant stays for degens and is not recommended.
export const FAIR_OPEN_CHOICES = [0, 60, 120, 300];
export const FAIR_OPEN_DEFAULT = 60;
export const MIN_TRADE_USD = 0.01;

// Hold-time labels. These are a BADGE and nothing more: the locked spec pays holders pro-rata to
// balance, so a tier buys no extra yield. `mult` is kept only so an old row renders; nothing reads it
// as a weight any more (see rewardSnapshot).
export const LADDER = [
  { hours: 0, mult: 1.0, label: 'Hatchling' },
  { hours: 1, mult: 1.25, label: 'Runt' },
  { hours: 6, mult: 1.5, label: 'Raptor' },
  { hours: 24, mult: 2.0, label: 'Rex' },
  { hours: 72, mult: 3.0, label: 'Apex' },
];
// How much $REX a wallet holds, in USD — the gate rex.fun uses for agent access, reused here for launching.
export function rexHeldUsd(wallet) { return balanceOf(wallet, 'REX') * usdOf('REX'); }
export const canLaunch = (wallet) => cfg.launchHoldUsd <= 0 || rexHeldUsd(wallet) >= cfg.launchHoldUsd;
/**
 * The rate a launch opens at. Everyone can launch; holding $REX starts you further down the REX fee
 * schedule, and since REX's fee is carved out of the holder allocation, every step it drops goes
 * straight to that token's holders rather than to the creator.
 */
export function openingRexBps(wallet) {
  if (cfg.rexRateHoldUsd <= 0 || rexHeldUsd(wallet) < cfg.rexRateHoldUsd) return REX_TIER_LAUNCH_BPS;
  const off = REX_TIER_LAUNCH_BPS - cfg.rexRateSteps * 5;
  return Math.max(REX_TIER_FLOOR_BPS, off);
}
export const rexRateFor = (wallet) => ({
  bps: openingRexBps(wallet),
  standard: REX_TIER_LAUNCH_BPS,
  qualifies: cfg.rexRateHoldUsd > 0 && rexHeldUsd(wallet) >= cfg.rexRateHoldUsd,
  holdUsd: cfg.rexRateHoldUsd,
  heldUsd: rexHeldUsd(wallet),
});
export function convictionOf(heldSince, now = Date.now()) {
  const hours = Math.max(0, (now - (heldSince || now)) / 3_600_000) * cfg.convictionScale;
  let cur = LADDER[0], next = null;
  for (let i = 0; i < LADDER.length; i++) { if (hours >= LADDER[i].hours) { cur = LADDER[i]; next = LADDER[i + 1] || null; } }
  return { mult: cur.mult, label: cur.label, hours, next: next ? { ...next, inHours: next.hours - hours } : null };
}

/** The four buckets as the creator set them, with legacy single-tax rows read as holder-only. */
export function feesOf(t) {
  const holder = t.holder_bps ?? 0, creator = t.creator_bps ?? 0, vault = t.vault_bps ?? 0;
  const burn = t.burn_bps ?? 0, buyback = t.buyback_bps ?? 0;
  // `rex` is already inside `holder`, so it never widens the total a trader pays.
  return { holder, creator, vault, burn, buyback, rex: t.rex_bps ?? REX_TIER_LAUNCH_BPS,
    total: holder + creator + vault + burn + buyback };
}
/** REX's tier for a launch, from cumulative verified quote volume in USD. Tiers only move down. */
/** How far down the schedule a launch has stepped. `step` 0 is launch, 6 is the floor. */
export function rexTierFor(step = 0) {
  return REX_TIERS[Math.max(0, Math.min(REX_TIERS.length - 1, Math.round(step)))];
}
/**
 * Reject anything the contract would reject, with the reason the UI should already have shown.
 * Ceilings first, then the step, then the sum — so "3/1/1" says "over the 4% cap", not "step".
 */
/**
 * The two holder-reward modes. Elio's call, 3 Oct: both ship, the launcher picks, default is 'hold'.
 *
 * Anything unrecognised becomes the default rather than throwing — a bad value here must not be able
 * to block a launch, and the default is the safe, advertised behaviour.
 */
export const REWARD_MODES = ['hold', 'flat'];
export const REWARD_MODE_DEFAULT = 'hold';
export const rewardMode = (v) => (REWARD_MODES.includes(String(v)) ? String(v) : REWARD_MODE_DEFAULT);

/**
 * The AI modes, and the ONE list that decides what counts as one.
 *
 * ⛔ IT LIVES HERE, NOT IN ai_alloc.mjs, SO THAT publicToken CAN REACH IT. ai_alloc imports this
 * module, so this module cannot import ai_alloc, and the obvious workaround — a second copy of the
 * list beside `publicToken` — is the exact failure this whole area was cleaned up to remove. Two
 * lists drift, and the one that drifts is always the one nobody is testing.
 *
 * ⛔ AND IT IS APPLIED ON READ, not merely on write. 'manager' and 'dip' were removed on 23 Oct but
 * the COLUMN still holds them on coins launched before that — KOPIX and SHARK are both live with
 * ai_mode='dip' right now. Surfacing the stored string raw told every client those coins were in a
 * mode that no longer exists and that nothing implements, which is precisely the bug the removal
 * was for, one level further out. A stored value is not a supported value.
 */
export const AI_MODES = ['off', 'dividend'];
export const aiModeOf = (v) => (AI_MODES.includes(String(v)) ? String(v) : 'off');

export function validateFees({ holderBps, creatorBps = 0, vaultBps = 0, burnBps = 0, buybackBps = 0 }) {
  const num = (v) => Math.round(Number(v) || 0);
  const f = { holderBps: num(holderBps), creatorBps: num(creatorBps), vaultBps: num(vaultBps), burnBps: num(burnBps), buybackBps: num(buybackBps) };
  if (f.holderBps < HOLDER_MIN_BPS || f.holderBps > HOLDER_MAX_BPS) throw new Error('Holder rewards must be between 1% and 3%');
  if (f.vaultBps > VAULT_MAX_BPS) throw new Error('Vault ceiling is 2%');
  for (const [k, label] of [['creatorBps', 'Creator'], ['burnBps', 'Burn'], ['buybackBps', 'Buyback']])
    if (f[k] > SIDE_MAX_BPS) throw new Error(`${label} ceiling is 1%`);
  for (const [k, label] of [['holderBps', 'Holder rewards'], ['creatorBps', 'Creator'], ['vaultBps', 'Vault'], ['burnBps', 'Burn'], ['buybackBps', 'Buyback']])
    if (f[k] % FEE_STEP_BPS !== 0) throw new Error(`${label} move in half-point steps only`);
  const total = f.holderBps + f.creatorBps + f.vaultBps + f.burnBps + f.buybackBps;
  if (total > FEE_CAP_BPS) throw new Error(`${(total / 100).toFixed(1)}% is over the 5% ceiling`);
  return { ...f, total };
}
/** Split a gross quote amount into the four buckets. REX comes out of the holder bucket. */
export function splitFees(gross, t) {
  const f = feesOf(t);
  const holderGross = gross * f.holder / 10_000;
  // Carved OUT of the holder allocation at an absolute rate: 2% holders with a 0.50% REX fee leaves
  // holders 1.5%. As REX steps to 0.20% they rise to 1.8%; the trader's total never moves.
  const rex = gross * Math.min(f.rex, f.holder) / 10_000;
  return { holder: holderGross - rex, rex, creator: gross * f.creator / 10_000, vault: gross * f.vault / 10_000,
    burn: gross * f.burn / 10_000, buyback: gross * f.buyback / 10_000, holderGross, total: gross * f.total / 10_000 };
}

/**
 * What a paper wallet starts with. The four originals keep their hand-picked amounts; every other
 * quote asset — the META and Stocks pairs — gets roughly $faucetUsd worth at the live price, so a
 * pair that the launch screen offers is a pair the demo can actually trade.
 */
export function faucetAmounts() {
  const out = { ...cfg.faucet };
  for (const q of Object.values(QUOTES)) {
    if (out[q.symbol] != null) continue;
    const usd = usdOf(q.symbol);
    if (usd > 0) out[q.symbol] = Number((cfg.faucetUsd / usd).toPrecision(3));
  }
  return out;
}

// ---------- social: referrals ------------------------------------------------------------------
// A creator can route part of THEIR OWN bucket to whoever brings the volume. It costs the protocol
// and the holders nothing, so the 5% ceiling is untouched and every holder gets a reason to sell the
// token to someone new rather than to the pool.
export const REF_SHARE_MAX_BPS = 10_000;   // up to 100% of the creator's own cut

const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // no 0/O/1/I — these get read aloud
/** A short, stable, shareable code for a wallet. Created on first use and never reissued. */
export function refCodeOf(wallet) {
  const row = db.prepare('SELECT ref_code FROM wallets WHERE wallet=?').get(wallet);
  if (row?.ref_code) return row.ref_code;
  ensureWallet(wallet);
  for (let i = 0; i < 40; i++) {
    const code = Array.from(crypto.randomBytes(6)).map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
    try { db.prepare('UPDATE wallets SET ref_code=? WHERE wallet=?').run(code, wallet); return code; }
    catch { /* collision on the unique index — draw again */ }
  }
  throw new Error('could not allocate a referral code');
}
export const walletForRefCode = (code) => {
  const c = typeof code === 'string' ? code.toUpperCase() : '';
  if (!/^[23456789A-HJ-NP-Z]{6}$/.test(c)) return null;
  return db.prepare('SELECT wallet FROM wallets WHERE ref_code=?').get(c)?.wallet || null;
};

/**
 * Bind a visitor to the wallet that brought them, for one token. First touch wins and is permanent:
 * the reward is for finding someone new, not for re-tagging a buyer somebody else already brought.
 * Self-referral and referring the creator are both no-ops.
 */
const isWalletish = (w) => typeof w === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w);
export function attributeReferral(mint, referee, referrer) {
  if (!isWalletish(referee) || !isWalletish(referrer) || referee === referrer) return null;
  if (typeof mint !== 'string' || !mint) return null;
  const t = getToken.get(mint); if (!t) return null;
  const existing = db.prepare('SELECT referrer FROM referrals WHERE mint=? AND referee=?').get(mint, referee);
  if (existing) return existing.referrer;
  if (sameFundingCluster(referrer, referee)) return null;   // paying yourself is not a referral
  ensureWallet(referrer); ensureWallet(referee);
  db.prepare('INSERT INTO referrals(mint,referee,referrer,first_seen) VALUES(?,?,?,?)').run(mint, referee, referrer, now());
  return referrer;
}
/** Record that `parent` funded `child` — the edge a common-funder wash is detected on. */
export function recordFunding(child, parent) {
  if (!isWalletish(child) || !isWalletish(parent) || child === parent) return;
  db.prepare('INSERT OR IGNORE INTO funding(child,parent,ts) VALUES(?,?,?)').run(child, parent, now());
}
/** Are two wallets in the same funding cluster? Walks up both chains, bounded. */
export function sameFundingCluster(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  if (a === b) return true;
  const chain = (w) => { const out = new Set([w]); let cur = w;
    for (let i = 0; i < 8; i++) { const p = db.prepare('SELECT parent FROM funding WHERE child=?').get(cur)?.parent; if (!p || out.has(p)) break; out.add(p); cur = p; }
    return out; };
  const A = chain(a), B = chain(b);
  for (const x of A) if (B.has(x)) return true;
  // siblings: funded by the same parent
  const pa = db.prepare('SELECT parent FROM funding WHERE child=?').get(a)?.parent;
  const pb = db.prepare('SELECT parent FROM funding WHERE child=?').get(b)?.parent;
  return !!(pa && pb && pa === pb);
}

/**
 * Promote a referral from pending to vested, once the referee has proved they are a real
 * participant: real volume AND still holding a while after they were introduced. Until then the
 * referral counts nowhere and pays nothing, so a farm of fresh wallets inflates no leaderboard.
 * Returns the reason it did NOT vest, or null when it did (or already had).
 */
export function tryVest(mint, referee) {
  const r = db.prepare('SELECT * FROM referrals WHERE mint=? AND referee=?').get(mint, referee);
  if (!r || r.vested) return null;
  if (r.rejected) return r.rejected;
  const t = getToken.get(mint); if (!t) return 'no token';
  const usd = usdOf(t.quote) || 0;

  // a referral inside a funding cluster is somebody paying themselves
  if (sameFundingCluster(r.referrer, referee)) {
    db.prepare("UPDATE referrals SET rejected='same funder' WHERE mint=? AND referee=?").run(mint, referee);
    return 'same funder';
  }
  if (r.volume * usd < cfg.refVestVolumeUsd) return 'not enough volume yet';
  if (now() - r.first_seen < cfg.refVestHoldSecs * 1000) return 'too soon';
  // still holding? a wallet that bought and dumped inside the window was never a real introduction
  if (holdingOf(referee, mint).amount <= 1) return 'referee no longer holds';
  // the referrer must have skin in the game, when the platform asks for it
  if (cfg.refHoldUsd > 0 && rexHeldUsd(r.referrer) < cfg.refHoldUsd) return 'referrer holds too little $REX';
  // and no farm may vest faster than the cap
  const since = now() - 86_400_000;
  const today = db.prepare('SELECT COUNT(*) n FROM referrals WHERE referrer=? AND vested=1 AND vested_at>=?').get(r.referrer, since)?.n || 0;
  if (today >= cfg.refMaxPerDay) return 'referrer at the daily cap';

  db.prepare('UPDATE referrals SET vested=1, vested_at=? WHERE mint=? AND referee=?').run(now(), mint, referee);
  // only now does the volume they brought start counting toward a payout
  db.prepare(`INSERT INTO ref_credit(mint,referrer,volume) VALUES(?,?,?)
    ON CONFLICT(mint,referrer) DO UPDATE SET volume=volume+excluded.volume`).run(mint, r.referrer, r.volume);
  events.push({ type: 'refvest', mint, referrer: r.referrer, referee, volume: r.volume, ts: now() });
  return null;
}

/** Credit the referrer who brought this buyer with the volume they just did. */
/**
 * Attribute a buy to whoever sent the buyer, so share-and-earn has something to divide.
 *
 * ⛔ EXPORTED BECAUSE THE PAPER CURVE WAS THE ONLY CALLER. `buy()` is the demo engine; every real
 * coin now trades on Meteora and is recorded by the DBC indexer, which never called this. So a
 * sharer brought volume, the link worked, and nothing anywhere recorded that they had brought it.
 */
export function creditReferral(mint, buyer, quoteVolume) {
  if (!(quoteVolume > 0)) return;
  const r = db.prepare('SELECT referrer, vested, rejected FROM referrals WHERE mint=? AND referee=?').get(mint, buyer);
  if (!r || r.rejected) return;
  // The referral row always tracks what this buyer did — that is the evidence vesting is judged on.
  db.prepare('UPDATE referrals SET volume=volume+? WHERE mint=? AND referee=?').run(quoteVolume, mint, buyer);
  if (r.vested) {
    // Already proved: this trade counts toward a payout straight away.
    db.prepare(`INSERT INTO ref_credit(mint,referrer,volume) VALUES(?,?,?)
      ON CONFLICT(mint,referrer) DO UPDATE SET volume=volume+excluded.volume`).run(mint, r.referrer, quoteVolume);
  } else {
    // Still pending — nothing reaches ref_credit. Try to promote it now that they have traded;
    // tryVest carries the whole accumulated volume across in one go if it qualifies.
    tryVest(mint, buyer);
  }
}

/**
 * Platform-level referral: whoever brought this wallet to REX Chain. First touch and permanent, and
 * it is snapshotted onto each token at launch, so changing it later cannot redirect a live token's
 * payouts. Earns `cfg.creatorRefBps` of that creator's own bucket on every token they ever launch.
 */
export function attributeWallet(wallet, referrer) {
  if (!isWalletish(wallet) || !isWalletish(referrer) || wallet === referrer) return null;
  ensureWallet(wallet); ensureWallet(referrer);
  const row = db.prepare('SELECT referred_by FROM wallets WHERE wallet=?').get(wallet);
  if (row?.referred_by) return row.referred_by;
  // Refuse a cycle: if the proposed referrer was themselves brought by this wallet, both sides would
  // earn off each other forever.
  const theirs = db.prepare('SELECT referred_by FROM wallets WHERE wallet=?').get(referrer);
  if (theirs?.referred_by === wallet) return null;
  db.prepare('UPDATE wallets SET referred_by=?, referred_at=? WHERE wallet=?').run(referrer, now(), wallet);
  return referrer;
}
export const referrerOf = (wallet) => db.prepare('SELECT referred_by FROM wallets WHERE wallet=?').get(wallet)?.referred_by || null;

/** Everything a wallet has done as a sharer, across every token — their public track record. */
export function reputationOf(wallet) {
  const ref = refSummary(wallet);
  const creators = db.prepare('SELECT COUNT(*) n FROM wallets WHERE referred_by=?').get(wallet)?.n || 0;
  const fromCreators = db.prepare('SELECT COALESCE(SUM(creator_ref_paid),0) s, COUNT(*) n FROM tokens WHERE creator_ref=?').get(wallet);
  const backed = db.prepare('SELECT COUNT(DISTINCT mint) n FROM holdings WHERE wallet=? AND amount > 1').get(wallet)?.n || 0;
  const epochs = db.prepare('SELECT COUNT(*) n FROM epoch_held WHERE wallet=?').get(wallet)?.n || 0;
  const longest = db.prepare(`SELECT MIN(held_since) m FROM holdings WHERE wallet=? AND amount > 1 AND held_since > 0`).get(wallet)?.m;
  return {
    code: ref.code, broughtBuyers: ref.brought, broughtCreators: creators,
    launchesFromReferrals: fromCreators?.n || 0,
    earnedUsd: ref.earnedUsd, volumeUsd: ref.volumeUsd,
    tokensBacked: backed, epochsSurvived: epochs,
    longestHoldHours: longest ? Math.max(0, (now() - longest) / 3_600_000) : 0,
  };
}

/** A creator's public record, shown on every launch they make. */
export function creatorHistory(creator) {
  const r = db.prepare(`SELECT COUNT(*) launches,
      SUM(CASE WHEN status='graduated' THEN 1 ELSE 0 END) graduated,
      COALESCE(SUM(yield_paid * 1.0),0) paidRaw, COALESCE(SUM(volume * 1.0),0) volRaw
    FROM tokens WHERE creator=?`).get(creator) || {};
  const byQuote = db.prepare('SELECT quote, SUM(yield_paid) p, SUM(volume) v FROM tokens WHERE creator=? GROUP BY quote').all(creator);
  const paidUsd = byQuote.reduce((s2, x) => s2 + (x.p || 0) * usdOf(x.quote), 0);
  const volumeUsd = byQuote.reduce((s2, x) => s2 + (x.v || 0) * usdOf(x.quote), 0);
  const first = db.prepare('SELECT MIN(created_at) m FROM tokens WHERE creator=?').get(creator)?.m || null;
  return { launches: r.launches || 0, graduated: r.graduated || 0, paidUsd, volumeUsd, firstLaunch: first };
}

// ---------- milestones: the moments worth posting ----------------------------------------------
export const MILESTONES = {
  holders100: { label: 'First 100 holders', cast: (t) => `$${t.symbol} just passed 100 holders.` },
  firstEpoch: { label: 'First epoch paid',  cast: (t) => `$${t.symbol} paid its holders for the first time. Rewards in ${t.quote}, on swaps only — a send pays nothing.` },
  graduated:  { label: 'Graduated',         cast: (t) => `$${t.symbol} filled its curve and graduated to a burned-LP AMM.` },
  fairOpen:   { label: 'Fair Open cleared', cast: (t) => `$${t.symbol} cleared its Fair Open — every bidder, the dev included, got the same price.` },
};
/** Record a milestone once and only once, and announce it. Returns null if it had already fired. */
export function markMilestone(mint, kind, value = 0) {
  if (!MILESTONES[kind]) return null;
  const t = getToken.get(mint); if (!t) return null;
  const existing = db.prepare('SELECT kind FROM milestones WHERE mint=? AND kind=?').get(mint, kind);
  if (existing) return null;
  const ts = now();
  db.prepare('INSERT INTO milestones(mint,kind,value,ts) VALUES(?,?,?,?)').run(mint, kind, value, ts);
  const row = { mint, kind, label: MILESTONES[kind].label, cast: MILESTONES[kind].cast(t), value, ts,
    symbol: t.symbol, name: t.name, image: t.image, quote: t.quote };
  events.push({ type: 'milestone', ...row });
  return row;
}
export const milestonesOf = (mint) => db.prepare('SELECT * FROM milestones WHERE mint=? ORDER BY ts').all(mint)
  .map((m) => ({ ...m, label: MILESTONES[m.kind]?.label || m.kind }));
export const recentMilestones = (limit = 20) => db.prepare(`SELECT m.*, t.symbol, t.name, t.image, t.quote
    FROM milestones m JOIN tokens t ON t.mint=m.mint ORDER BY m.ts DESC LIMIT ?`).all(limit)
  .map((m) => ({ ...m, label: MILESTONES[m.kind]?.label || m.kind, cast: MILESTONES[m.kind]?.cast(m) || '' }));

export const newMint = () => bs58.encode(crypto.randomBytes(32));
// Every link stored on a token goes through here, whatever the source (user form, API seed): http(s) only.
export function cleanLink(s) { s = String(s || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200); if (!s) return null; if (!/^https?:\/\//i.test(s)) s = 'https://' + s; try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } }
export function cleanImage(s) { s = String(s || '').trim().slice(0, 300); return /^\/img\/[A-Za-z0-9._-]+$/.test(s) || /^https:\/\/[^\s"'<>]+$/.test(s) ? s : null; }
const now = () => Date.now();
const r9 = (x) => Math.round(x * 1e9) / 1e9;
const minute = (t) => Math.floor(t / 60_000) * 60_000;

// ---------- balances / holdings
const getBal = db.prepare('SELECT amount FROM balances WHERE wallet=? AND asset=?');
export const balanceOf = (wallet, asset) => getBal.get(wallet, asset)?.amount || 0;
export function credit(wallet, asset, amount) {
  if (!Number.isFinite(amount)) throw new Error('Bad amount'); if (!(amount > 0)) return;
  db.prepare('INSERT INTO balances(wallet,asset,amount) VALUES(?,?,?) ON CONFLICT(wallet,asset) DO UPDATE SET amount=amount+excluded.amount').run(wallet, asset, amount);
}
export function debit(wallet, asset, amount) {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Bad amount');
  const have = balanceOf(wallet, asset);
  if (have + 1e-9 < amount) throw new Error(`Insufficient ${asset}: have ${have.toFixed(4)}, need ${amount.toFixed(4)}`);
  db.prepare('UPDATE balances SET amount=MAX(0, amount-?) WHERE wallet=? AND asset=?').run(amount, wallet, asset);
}
export function ensureWallet(wallet, bot = 0) {
  const t = now();
  db.prepare('INSERT INTO wallets(wallet,created_at,last_seen,bot) VALUES(?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET last_seen=excluded.last_seen').run(wallet, t, t, bot);
  const w = db.prepare('SELECT faucet FROM wallets WHERE wallet=?').get(wallet);
  // ⛔ PAPER MONEY IS SIM-ONLY. This grant had no sim gate, so every wallet that connected to the
  // MAINNET site was silently credited 25 SOL, 5,000,000 REX, 5,000 USDC and 3,000,000 GP of paper
  // balance — and the header then showed that paper SOL as the visitor's balance. Somebody with
  // 1 SOL was told they had 25. It also fed rexHeldUsd, so rexRateFor handed everyone the
  // best fee tier on REX they did not own, quietly cancelling the reason to hold any.
  if (cfg.sim && !w.faucet) { for (const [a, n] of Object.entries(faucetAmounts())) credit(wallet, a, n); db.prepare('UPDATE wallets SET faucet=1 WHERE wallet=?').run(wallet); }
}
const getHold = db.prepare('SELECT * FROM holdings WHERE wallet=? AND mint=?');
export const holdingOf = (wallet, mint) => getHold.get(wallet, mint) || { wallet, mint, amount: 0, held_since: null, cost: 0, realized: 0, yield_earned: 0 };
function addHolding(wallet, mint, tokens, quoteCost, t) {
  const h = getHold.get(wallet, mint);
  if (!h || h.amount <= 1e-6) {
    db.prepare('INSERT INTO holdings(wallet,mint,amount,held_since,cost,realized,yield_earned) VALUES(?,?,?,?,?,?,?) ON CONFLICT(wallet,mint) DO UPDATE SET amount=excluded.amount, held_since=excluded.held_since, cost=excluded.cost').run(wallet, mint, tokens, t, quoteCost, h?.realized || 0, h?.yield_earned || 0);
  } else db.prepare('UPDATE holdings SET amount=amount+?, cost=cost+? WHERE wallet=? AND mint=?').run(tokens, quoteCost, wallet, mint);
}
function removeHolding(wallet, mint, tokens, quoteOut, t) {
  const h = getHold.get(wallet, mint); if (!h) throw new Error('No position');
  if (h.amount + 1e-6 < tokens) throw new Error('Insufficient tokens');
  const frac = Math.min(1, tokens / h.amount);
  const costPart = h.cost * frac;
  const left = Math.max(0, h.amount - tokens);
  // Conviction rule: any sell resets the hold clock — paper hands start over.
  db.prepare('UPDATE holdings SET amount=?, cost=?, realized=realized+?, held_since=? WHERE wallet=? AND mint=?').run(left < 1e-6 ? 0 : left, left < 1e-6 ? 0 : h.cost - costPart, quoteOut - costPart, left < 1e-6 ? null : t, wallet, mint);
}
// bot=2 wallets are curve reserves (seed only): they hold supply but are not holders — excluded from lists, counts, epochs and boards
const NOT_RESERVE = 'h.wallet NOT IN (SELECT wallet FROM wallets WHERE bot=2)';
const countHolders = db.prepare(`SELECT COUNT(*) n FROM holdings h WHERE h.mint=? AND h.amount > 1 AND ${NOT_RESERVE}`);
function refreshHolders(mint) {
  const n = countHolders.get(mint).n;
  db.prepare('UPDATE tokens SET holders=? WHERE mint=?').run(n, mint);
  if (n >= 100) markMilestone(mint, 'holders100', n);
}

// ---------- curve sizing
export function raiseFor(quote) {
  const q = QUOTES[quote]; if (!q) throw new Error('Unknown quote');
  const usd = RAISE_SOL * usdOf('SOL');
  return q.symbol === 'SOL' ? RAISE_SOL : usd / q.usd;
}
export function curveInit(quote) {
  const raise = raiseFor(quote);
  const v_quote = V_SOL0 * raise / RAISE_SOL;
  return { v_quote, v_tokens: V_TOKENS0, real_tokens: CURVE_TOKENS, real_quote: 0, k: v_quote * V_TOKENS0, raise_target: raise, price: v_quote / V_TOKENS0 };
}

// ---------- quotes (previews)
export const getToken = db.prepare('SELECT * FROM tokens WHERE mint=?');
/**
 * The post-clear launch guard: a per-wallet cap and a decaying extra quote fee, both for
 * `guard_secs` after the open cleared. The extra fee decays linearly to zero and is paid to the
 * vault or burned — never to the dev. Outside the window both are zero.
 */
export function guardOf(t, at = now()) {
  const from = t.opened_at || t.fair_open_ends || 0;
  const secs = t.guard_secs || 0;
  if (!secs || !from) return { cap: 0, decay: 0, left: 0 };
  const left = Math.min(secs, (from + secs * 1000 - at) / 1000);
  if (left <= 0) return { cap: 0, decay: 0, left: 0 };
  // `left` is clamped to the window: before the bell `fair_open_ends` is still in the future, and an
  // unclamped ratio would read BACK a decay above the maximum the creator actually set.
  return { cap: t.wallet_cap || 0, decay: Math.round((t.decay_fee_bps || 0) * (left / secs)), left, to: t.decay_to };
}
/**
 * Which other program prices this coin, if it is not us. NULL venue means our own curve — see
 * `publicToken`, which reads `t.venue || 'rexpad'`.
 */
export const offCurve = (t) => (t && (t.venue === 'dbc' || t.venue === 'launchlab') ? t.venue : null);
/**
 * ⛔ A COIN WHOSE CURVE IS NOT OURS HAS NO ROW TO PRICE, AND THE MATHS DOES NOT SAY SO BY ITSELF.
 * On the Meteora (dbc) and LaunchLab venues the curve lives in that program's pool, so
 * v_quote/v_tokens/k/real_tokens are NULL here. JS coerces those NULLs to 0, which makes
 * `out >= t.real_tokens - 1e-6` true on the very first comparison — so the maths takes the
 * GRADUATION branch, divides by `t.v_tokens - out` = 0, and returns NaN in every field.
 *
 * That is how `/api/quote` came to answer 200 with every field null for all 100 live coins while
 * still reporting `graduates: true`, and how `/api/trade` turned into an opaque "Bad amount"
 * thrown by `debit`. Nothing was ever written — `debit` refuses a non-finite amount and `buy`
 * runs inside a transaction — but the slippage guard above it does NOT catch this, because
 * `null < 0` is false. A silence shaped like an answer is the thing this file works hardest to
 * avoid, so name the venue that does price it instead.
 */
function requireOwnCurve(t) {
  const v = offCurve(t);
  if (!v) return;
  throw new Error(v === 'dbc'
    ? 'This coin is priced by Meteora, not by our curve — quote it against its DBC pool.'
    : 'This coin is priced by Raydium LaunchLab, not by our curve — quote it against its LaunchLab pool.');
}
export function previewBuy(t, quoteIn, decayBps = 0) {
  if (!Number.isFinite(quoteIn) || !(quoteIn > 0)) throw new Error('Amount must be positive');
  requireOwnCurve(t);
  const feeRate = (t.status === 'graduated' ? AMM_FEE_BPS : PLATFORM_FEE_BPS) / 10_000;
  const decayRate = Math.max(0, decayBps) / 10_000, taxRate = feesOf(t).total / 10_000 + decayRate;
  let gross = quoteIn, net = gross * (1 - feeRate - taxRate), out, priceBefore, priceAfter, graduates = false, refund = 0;
  if (t.status === 'graduated') {
    priceBefore = t.amm_quote / t.amm_tokens;
    out = t.amm_tokens - (t.amm_quote * t.amm_tokens) / (t.amm_quote + net);
    priceAfter = (t.amm_quote + net) / (t.amm_tokens - out);
  } else {
    priceBefore = t.v_quote / t.v_tokens;
    out = t.v_tokens - t.k / (t.v_quote + net);
    if (out >= t.real_tokens - 1e-6) { // buying the last of the curve: cap and refund the excess
      out = t.real_tokens; const need = t.k / (t.v_tokens - out) - t.v_quote;
      const gross2 = need / (1 - feeRate - taxRate); refund = gross - gross2; gross = gross2; net = need; graduates = true;
    }
    priceAfter = (t.v_quote + net) / (t.v_tokens - out);
  }
  const fee = gross * feeRate, tax = gross * taxRate;
  const split = splitFees(gross, t);
  if (decayRate > 0) { const d = gross * decayRate; split[t.decay_to === 'burn' ? 'burn' : 'vault'] += d; split.decay = d; split.total += d; }
  return { side: 'buy', quoteIn: gross, refund, net, fee, tax, split, tokensOut: out, avgPrice: net / out, priceBefore, priceAfter, impact: priceAfter / priceBefore - 1, graduates };
}
export function previewSell(t, tokensIn, decayBps = 0) {
  if (!Number.isFinite(tokensIn) || !(tokensIn > 0)) throw new Error('Amount must be positive');
  requireOwnCurve(t);
  const feeRate = (t.status === 'graduated' ? AMM_FEE_BPS : PLATFORM_FEE_BPS) / 10_000;
  const decayRate = Math.max(0, decayBps) / 10_000, taxRate = feesOf(t).total / 10_000 + decayRate;
  let gross, priceBefore, priceAfter;
  if (t.status === 'graduated') {
    priceBefore = t.amm_quote / t.amm_tokens;
    gross = t.amm_quote - (t.amm_quote * t.amm_tokens) / (t.amm_tokens + tokensIn);
    priceAfter = (t.amm_quote - gross) / (t.amm_tokens + tokensIn);
  } else {
    priceBefore = t.v_quote / t.v_tokens;
    gross = Math.min(t.real_quote, t.v_quote - t.k / (t.v_tokens + tokensIn));
    priceAfter = (t.v_quote - gross) / (t.v_tokens + tokensIn);
  }
  const fee = gross * feeRate, tax = gross * taxRate, out = gross - fee - tax;
  const split = splitFees(gross, t);
  if (decayRate > 0) { const d = gross * decayRate; split[t.decay_to === 'burn' ? 'burn' : 'vault'] += d; split.decay = d; split.total += d; }
  return { side: 'sell', tokensIn, gross, fee, tax, split, quoteOut: out, avgPrice: gross / tokensIn, priceBefore, priceAfter, impact: priceAfter / priceBefore - 1 };
}

// ---------- candles
/** Exported for the Meteora indexer: a swap it discovers has to reach the candle table too, or the
 *  coin has a trade tape and a permanently empty chart. */
export function pushCandle(mint, price, quoteVol, t, openHint = price) {
  const ts = minute(t);
  const c = db.prepare('SELECT * FROM candles WHERE mint=? AND ts=?').get(mint, ts);
  if (!c) {
    const prev = db.prepare('SELECT c FROM candles WHERE mint=? AND ts<? ORDER BY ts DESC LIMIT 1').get(mint, ts);
    const o = prev ? prev.c : openHint; // a token's first candle opens at the pre-trade curve price so the launch move is drawn
    db.prepare('INSERT INTO candles(mint,ts,o,h,l,c,v,n) VALUES(?,?,?,?,?,?,?,1)').run(mint, ts, o, Math.max(o, price), Math.min(o, price), price, quoteVol);
    return { ts, o, h: Math.max(o, price), l: Math.min(o, price), c: price, v: quoteVol };
  }
  const h = Math.max(c.h, price), l = Math.min(c.l, price), v = c.v + quoteVol;
  db.prepare('UPDATE candles SET h=?,l=?,c=?,v=?,n=n+1 WHERE mint=? AND ts=?').run(h, l, price, v, mint, ts);
  return { ts, o: c.o, h, l, c: price, v };
}
export function candles(mint, tf = '1m', limit = 300) {
  const step = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240 }[tf] || 1;
  const rows = db.prepare('SELECT * FROM candles WHERE mint=? ORDER BY ts DESC LIMIT ?').all(mint, limit * step).reverse();
  if (step === 1) return rows.map((r) => ({ time: r.ts / 1000, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v }));
  const out = []; const w = step * 60_000;
  for (const r of rows) {
    const b = Math.floor(r.ts / w) * w; const last = out[out.length - 1];
    if (last && last.time === b / 1000) { last.high = Math.max(last.high, r.h); last.low = Math.min(last.low, r.l); last.close = r.c; last.volume += r.v; }
    else out.push({ time: b / 1000, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v });
  }
  return out;
}

// ---------- trade execution
function recordTrade(t, wallet, side, quote, tokens, price, fee, tax, kind, ts) {
  db.prepare('INSERT INTO trades(mint,wallet,side,quote,tokens,price,fee,tax,kind,ts) VALUES(?,?,?,?,?,?,?,?,?,?)').run(t.mint, wallet, side, quote, tokens, price, fee, tax, kind, ts);
  const id = db.prepare('SELECT last_insert_rowid() id').get().id;
  return { id, mint: t.mint, wallet, side, quote, tokens, price, fee, tax, kind, ts, symbol: t.symbol, name: t.name, image: t.image, quoteSymbol: t.quote };
}
/**
 * Move a trade's fee into the four pots. `extra` is the AMM swap fee, which on a graduated pair has
 * no LP to pay (the LP is burned) and so joins the holders' pot. Each pot is paid out separately at
 * the epoch: holders pro-rata, the creator in full, the vault as liquidity, the burn as a buy-and-burn.
 */
function accrue(mint, p, extra = 0) {
  const f = p.split;
  db.prepare('UPDATE tokens SET yield_pool=yield_pool+?, creator_pot=creator_pot+?, vault_pot=vault_pot+?, burn_pot=burn_pot+?, buyback_pot=buyback_pot+?, rex_pot=rex_pot+? WHERE mint=?')
    .run(f.holder + extra, f.creator, f.vault, f.burn, f.buyback, f.rex, mint);
}
function applyBuyState(t, p, ts) {
  if (t.status === 'graduated') {
    db.prepare('UPDATE tokens SET amm_quote=amm_quote+?, amm_tokens=amm_tokens-?, price=?, trades=trades+1, volume=volume+?, last_trade_at=? WHERE mint=?')
      .run(p.net, p.tokensOut, p.priceAfter, p.quoteIn, ts, t.mint);
    accrue(t.mint, p, p.fee);
  } else {
    db.prepare('UPDATE tokens SET v_quote=v_quote+?, v_tokens=v_tokens-?, real_quote=real_quote+?, real_tokens=real_tokens-?, price=?, trades=trades+1, volume=volume+?, last_trade_at=? WHERE mint=?')
      .run(p.net, p.tokensOut, p.net, p.tokensOut, p.priceAfter, p.quoteIn, ts, t.mint);
    accrue(t.mint, p);
    if (p.graduates) { graduate(t.mint, ts); markMilestone(t.mint, 'graduated'); }
  }
}
function graduate(mint, ts) {
  const t = getToken.get(mint);
  // Price-continuous migration: the raise + the reserved 206.9M seed a burned-LP AMM at exactly the curve's final price.
  const ammTokens = LP_TOKENS + Math.max(0, t.real_tokens);
  db.prepare("UPDATE tokens SET status='graduated', graduated_at=?, amm_quote=?, amm_tokens=?, real_tokens=0, price=? WHERE mint=?").run(ts, t.real_quote, ammTokens, t.real_quote / ammTokens, mint);
  log('🎓 graduated', t.symbol, mint.slice(0, 6), 'raise', t.real_quote.toFixed(2), t.quote);
  events.push({ type: 'graduated', mint, symbol: t.symbol, name: t.name, image: t.image, ts });
}
export const events = []; // drained by the server and broadcast
// Re-price a graduated coin's AMM to an external price (seed only): keeps the pool depth, moves the quote side.
export function setAmmPrice(mint, price) {
  const t = getToken.get(mint); if (!t || t.status !== 'graduated' || !(price > 0)) return;
  db.prepare('UPDATE tokens SET amm_quote=?, price=? WHERE mint=?').run(price * t.amm_tokens, price, mint);
  pushCandle(mint, price, 0, now(), price);
}
export function buy(wallet, mint, quoteIn, minTokens = 0) {
  return tx(() => {
    const t = getToken.get(mint); if (!t) throw new Error('Unknown token');
    if (t.status === 'fairopen') throw new Error('Fair Open in progress — place a bid instead');
    if (quoteIn * usdOf(t.quote) < MIN_TRADE_USD) throw new Error('Trade too small');
    const g = guardOf(t);
    const p = previewBuy(t, quoteIn, g.decay);
    if (p.tokensOut < minTokens) throw new Error(`Slippage: would receive ${p.tokensOut.toFixed(0)} < min ${minTokens.toFixed(0)}`);
    if (g.cap > 0) {
      const held = db.prepare('SELECT amount FROM holdings WHERE wallet=? AND mint=?').get(wallet, mint)?.amount || 0;
      const ceil = g.cap * TOTAL_SUPPLY;
      if (held + p.tokensOut > ceil + 1e-6) throw new Error(`Launch guard: ${(g.cap * 100).toFixed(2)}% per wallet for the first ${t.guard_secs}s`);
    }
    const ts = now();
    debit(wallet, t.quote, p.quoteIn);
    addHolding(wallet, mint, p.tokensOut, p.net, ts);
    applyBuyState(t, p, ts);
    refreshHolders(mint);
    creditReferral(mint, wallet, p.quoteIn);
    const trade = recordTrade(t, wallet, 'buy', p.quoteIn, p.tokensOut, p.avgPrice, p.fee, p.tax, t.status === 'graduated' ? 'amm' : 'curve', ts);
    trade.candle = pushCandle(mint, p.priceAfter, p.quoteIn, ts, p.priceBefore);
    events.push({ type: 'trade', ...trade });
    return { ...p, trade };
  });
}
export function sell(wallet, mint, tokensIn, minQuote = 0) {
  return tx(() => {
    const t = getToken.get(mint); if (!t) throw new Error('Unknown token');
    if (t.status === 'fairopen') throw new Error('Fair Open in progress');
    const h = holdingOf(wallet, mint); if (h.amount < 1) throw new Error('Nothing to sell');
    tokensIn = Math.min(tokensIn, h.amount);
    const p = previewSell(t, tokensIn, guardOf(t).decay);
    if (p.quoteOut < minQuote) throw new Error(`Slippage: would receive ${p.quoteOut.toFixed(4)} < min ${minQuote.toFixed(4)}`);
    const ts = now();
    removeHolding(wallet, mint, tokensIn, p.quoteOut, ts);
    credit(wallet, t.quote, p.quoteOut);
    if (t.status === 'graduated') db.prepare('UPDATE tokens SET amm_quote=amm_quote-?, amm_tokens=amm_tokens+?, price=?, trades=trades+1, volume=volume+?, last_trade_at=? WHERE mint=?').run(p.gross, tokensIn, p.priceAfter, p.gross, ts, mint);
    else db.prepare('UPDATE tokens SET v_quote=v_quote-?, v_tokens=v_tokens+?, real_quote=real_quote-?, real_tokens=real_tokens+?, price=?, trades=trades+1, volume=volume+?, last_trade_at=? WHERE mint=?').run(p.gross, tokensIn, p.gross, tokensIn, p.priceAfter, p.gross, ts, mint);
    accrue(mint, p, t.status === 'graduated' ? p.fee : 0);
    refreshHolders(mint);
    const trade = recordTrade(t, wallet, 'sell', p.quoteOut, tokensIn, p.avgPrice, p.fee, p.tax, t.status === 'graduated' ? 'amm' : 'curve', ts);
    trade.candle = pushCandle(mint, p.priceAfter, p.gross, ts, p.priceBefore);
    events.push({ type: 'trade', ...trade });
    return { ...p, trade };
  });
}

// ---------- create + Fair Open
export function createToken(creator, o) {
  const symbol = String(o.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  const name = String(o.name || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 32);
  if (name.length < 2) throw new Error('Name too short'); if (symbol.length < 2) throw new Error('Ticker too short');
  if (!QUOTES[o.quote]) throw new Error('Unknown quote');
  // Four buckets, validated exactly as the contract validates them — the UI has already shown the sum.
  const f = validateFees({ holderBps: o.holderBps ?? o.taxBps ?? HOLDER_MIN_BPS, creatorBps: o.creatorBps, vaultBps: o.vaultBps, burnBps: o.burnBps, buybackBps: o.buybackBps });
  const fo = FAIR_OPEN_CHOICES.includes(Number(o.fairOpenSecs)) ? Number(o.fairOpenSecs) : FAIR_OPEN_DEFAULT;
  const devBuy = Math.max(0, Number(o.devBuy) || 0);
  // Advanced. An allowlist with no window is a private snipe and does not ship, so it is dropped on
  // an instant open; the post-clear cap and decaying fee run for 60 seconds and never pay the dev.
  const allow = fo ? String(o.allowlist || '').split(/[^1-9A-HJ-NP-Za-km-z]+/).filter((w) => w.length >= 32 && w.length <= 44) : [];
  const allowRexUsd = fo ? Math.max(0, Number(o.allowRexUsd) || 0) : 0;
  const walletCap = Math.min(0.05, Math.max(0, Number(o.walletCap) || 0));   // fraction of supply
  const decayBps = Math.min(500, Math.max(0, Math.round(Number(o.decayFeeBps) || 0)));
  const decayTo = o.decayTo === 'burn' ? 'burn' : 'vault';                    // never to the dev
  const guard = (walletCap > 0 || decayBps > 0) ? 60 : 0;
  // What the creator hands to whoever brings volume, as a share of their OWN bucket.
  const refShare = Math.max(0, Math.min(REF_SHARE_MAX_BPS, Math.round(Number(o.refShareBps) || 0)));
  // Snapshotted now: changing who referred the creator later must not redirect a live token's payouts.
  const creatorRef = referrerOf(creator);
  const rmode = rewardMode(o.rewardMode);
  const c = curveInit(o.quote); const ts = now(); const mint = newMint();
  return tx(() => {
    ensureWallet(creator);
    db.prepare(`INSERT INTO tokens(mint,name,symbol,description,image,website,twitter,telegram,creator,quote,tax_bps,holder_bps,creator_bps,vault_bps,burn_bps,buyback_bps,rex_bps,ref_share_bps,reward_mode,creator_ref,allowlist,allow_rex_usd,wallet_cap,decay_fee_bps,decay_to,guard_secs,fair_open_secs,fair_open_ends,status,v_quote,v_tokens,real_quote,real_tokens,k,raise_target,created_at,opened_at,price)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(mint, name, symbol, String(o.description || '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 600), cleanImage(o.image), cleanLink(o.website), cleanLink(o.twitter), cleanLink(o.telegram), creator, o.quote, f.total, f.holderBps, f.creatorBps, f.vaultBps, f.burnBps, f.buybackBps, openingRexBps(creator), refShare, rmode, creatorRef, allow.length ? allow.join(',') : null, allowRexUsd, walletCap, decayBps, decayBps ? decayTo : null, guard, fo, fo ? ts + fo * 1000 : null, fo ? 'fairopen' : 'live', c.v_quote, c.v_tokens, 0, c.real_tokens, c.k, c.raise_target, ts, fo ? null : ts, c.price);
    const t = getToken.get(mint);
    events.push({ type: 'token', token: publicToken(t) });
    if (devBuy > 0) { if (fo) placeBid(creator, mint, devBuy); else buy(creator, mint, devBuy); }
    return getToken.get(mint);
  });
}
export function placeBid(wallet, mint, amount) {
  return tx(() => {
    const t = getToken.get(mint); if (!t) throw new Error('Unknown token');
    if (t.status !== 'fairopen' || now() >= t.fair_open_ends) throw new Error('Fair Open window is closed');
    amount = Number(amount); if (!(amount > 0)) throw new Error('Amount must be positive');
    // The allowlist only exists inside the window, and the creator is always on it.
    if (wallet !== t.creator) {
      const list = t.allowlist ? t.allowlist.split(',') : null;
      if (list && !list.includes(wallet)) throw new Error('This open is allowlisted');
      if (t.allow_rex_usd > 0 && rexHeldUsd(wallet) < t.allow_rex_usd) throw new Error(`This open needs $${t.allow_rex_usd} of REX held`);
    }
    const prev = db.prepare('SELECT amount FROM bids WHERE mint=? AND wallet=?').get(mint, wallet)?.amount || 0;
    // ⛔ EVERY BIDDER, NOT JUST THE CREATOR — mirrors the program, which stopped keying this on
    // identity because `Commit` PDAs are per-bidder and a second wallet was simply a second
    // uncapped bidder. A cap that a fresh keypair steps around is not a cap.
    {
      const cap = t.raise_target * DEV_COMMIT_MAX_BPS / 10_000;
      if (prev + amount > cap + 1e-9) throw new Error(`Any one bidder is capped at ${(DEV_COMMIT_MAX_BPS / 100).toFixed(0)}% of the raise (${cap.toFixed(2)} ${t.quote})`);
    }
    debit(wallet, t.quote, amount);
    db.prepare('INSERT INTO bids(mint,wallet,amount,ts) VALUES(?,?,?,?) ON CONFLICT(mint,wallet) DO UPDATE SET amount=amount+excluded.amount, ts=excluded.ts').run(mint, wallet, amount, now());
    const agg = db.prepare('SELECT COALESCE(SUM(amount),0) total, COUNT(*) n FROM bids WHERE mint=?').get(mint);
    db.prepare('UPDATE tokens SET fair_open_total=?, fair_open_bidders=? WHERE mint=?').run(agg.total, agg.n, mint);
    events.push({ type: 'fairopen', mint, total: agg.total, bidders: agg.n, endsAt: t.fair_open_ends, wallet, amount, mine: prev + amount });
    return { total: agg.total, bidders: agg.n, mine: prev + amount, endsAt: t.fair_open_ends };
  });
}
export function cancelBid(wallet, mint) {
  return tx(() => {
    const t = getToken.get(mint); if (!t || t.status !== 'fairopen' || now() >= t.fair_open_ends) throw new Error('Window closed');
    const b = db.prepare('SELECT amount FROM bids WHERE mint=? AND wallet=?').get(mint, wallet); if (!b) throw new Error('No bid');
    db.prepare('DELETE FROM bids WHERE mint=? AND wallet=?').run(mint, wallet); credit(wallet, t.quote, b.amount);
    const agg = db.prepare('SELECT COALESCE(SUM(amount),0) total, COUNT(*) n FROM bids WHERE mint=?').get(mint);
    db.prepare('UPDATE tokens SET fair_open_total=?, fair_open_bidders=? WHERE mint=?').run(agg.total, agg.n, mint);
    events.push({ type: 'fairopen', mint, total: agg.total, bidders: agg.n, endsAt: t.fair_open_ends, wallet, amount: -b.amount, mine: 0 });
    return { total: agg.total, bidders: agg.n, mine: 0 };
  });
}
// Uniform-price clearing: every bid in the window — the dev's included — is one lump buy on the curve, allocated pro-rata.
export function settleFairOpen(mint) {
  return tx(() => {
    const t = getToken.get(mint); if (!t || t.status !== 'fairopen') return null;
    const bids = db.prepare('SELECT wallet, amount FROM bids WHERE mint=? ORDER BY ts').all(mint);
    const ts = now(); const total = bids.reduce((s, b) => s + b.amount, 0);
    let price = t.price, fills = [];
    if (total > 0) {
      const p = previewBuy(t, total);
      applyBuyState(t, p, ts);
      price = p.avgPrice;
      for (const b of bids) {
        const share = b.amount / total; const tokens = p.tokensOut * share; const refund = p.refund * share;
        addHolding(b.wallet, mint, tokens, p.net * share, ts);
        if (refund > 0) credit(b.wallet, t.quote, refund);
        fills.push(recordTrade(t, b.wallet, 'buy', b.amount - refund, tokens, price, p.fee * share, p.tax * share, 'fairopen', ts));
      }
      pushCandle(mint, p.priceAfter, p.quoteIn, ts, p.priceBefore);
      refreshHolders(mint);
      markMilestone(mint, 'fairOpen', total);
    }
    db.prepare("UPDATE tokens SET status=CASE WHEN status='fairopen' THEN 'live' ELSE status END, opened_at=?, fair_open_total=?, fair_open_bidders=?, fair_open_price=? WHERE mint=?").run(ts, total, bids.length, price, mint);
    db.prepare('DELETE FROM bids WHERE mint=?').run(mint);
    const fresh = getToken.get(mint);
    events.push({ type: 'settled', mint, total, bidders: bids.length, price, symbol: t.symbol, name: t.name, image: t.image, token: publicToken(fresh), ts });
    for (const f of fills) events.push({ type: 'trade', ...f });
    log('⚖️  fair open settled', t.symbol, 'bidders', bids.length, 'total', total.toFixed(3), t.quote, 'uniform price', price.toExponential(3));
    return fresh;
  });
}
export function settleDue() {
  const due = db.prepare("SELECT mint FROM tokens WHERE status='fairopen' AND fair_open_ends <= ?").all(now());
  for (const { mint } of due) settleFairOpen(mint);
  return due.length;
}

// ---------- Reward epochs
// Holders are paid PRO-RATA TO BALANCE at the snapshot — no hold-time multiplier. A holder whose
// position is worth less than the quote equivalent of $20 is skipped and their share stays in the
// pool; pool, vault, burner and team-lock wallets are excluded entirely. The same pass settles the
// other three buckets, so the pair page can post all of them in the one session.
export function nextEpochAt() { const last = Number(db.prepare("SELECT v FROM meta WHERE k='epoch_at'").get()?.v || 0); return (last || now()) + cfg.epochMs; }

/** Deterministic, public, non-redeemable addresses. Marked bot=2, so they can never earn rewards. */
export const vaultWalletOf = (mint) => 'vault' + mint.slice(0, 39);
export const burnerWalletOf = (mint) => 'burn' + mint.slice(0, 40);

/** Who is eligible this epoch, and what each is owed out of `pool`. */
export function rewardSnapshot(mint, pool, at = now()) {
  const t = getToken.get(mint); if (!t) return { eligible: [], skipped: [], total: 0 };
  // Operations take their slice off the top, before anything is split — the same order the chain
  // path uses, so the demo and the real thing report the same numbers.
  const opsBps = Math.max(0, Math.min(1000, cfg.opsBps || 0));
  const ops = cfg.opsWallet && opsBps > 0 ? pool * opsBps / 10_000 : 0;
  pool = pool - ops;
  const floorQuote = REWARD_FLOOR_USD > 0 ? REWARD_FLOOR_USD / (usdOf(t.quote) || Infinity) : 0;
  const rows = db.prepare(`SELECT h.wallet, h.amount, h.held_since FROM holdings h WHERE h.mint=? AND h.amount > 0 AND ${NOT_RESERVE}`).all(mint);
  const priced = rows.map((h) => ({ ...h, value: h.amount * t.price }));
  // The floor is a VALUE floor and is applied before any weighting, so conviction can lift a holder's
  // share but never their eligibility.
  const eligible = priced.filter((h) => h.value >= floorQuote);
  const skipped = priced.filter((h) => h.value < floorQuote);
  // Diamond Hands ('hold', the default) weights balance by the conviction multiplier; 'flat' is
  // balance alone. This is the same rule the on-chain epoch crank applies in lib/chain.mjs, and it
  // has to live here too or the demo engine and the displayed share would both contradict the payout.
  const dh = (t.reward_mode || REWARD_MODE_DEFAULT) === 'hold';
  const weigh = (h) => (dh ? h.amount * convictionOf(h.held_since, at).mult : h.amount);
  const weighted = eligible.map((h) => ({ ...h, weight: weigh(h) }));
  const total = weighted.reduce((x, h) => x + h.weight, 0);
  return { eligible: weighted.map((h) => ({ ...h, share: total > 0 ? h.weight / total : 0, amount_quote: total > 0 ? pool * h.weight / total : 0 })),
    skipped, total, floorQuote, floorUsd: REWARD_FLOOR_USD, allBelowFloor: eligible.length === 0 && skipped.length > 0, at,
    ops, opsBps, opsWallet: ops > 0 ? cfg.opsWallet : null };
}

/**
 * Pay the creator's bucket. If the creator set a referral share, that slice is split first among the
 * wallets who brought the volume — pro-rata to what each actually brought — and the creator keeps
 * the rest. REX never touches any of it.
 */
/**
 * What the creator takes out of every trade, in basis points, whichever venue the coin is on.
 *
 * Paper curve: `creator_bps` is already bps of the trade.
 * Meteora / LaunchLab: the pool charges `pool_fee_bps` and the creator's share of that is a
 * PERCENTAGE, so their cut of a trade is the product of the two.
 */
/** What holders of this coin have actually been SENT, confirmed on chain. */
export const holderSent = (mint) => Number(db.prepare(
  // ⛔ COALESCE(delivered, amount): what the chain says arrived, falling back to what was asked
  // only for rows that predate the read-back. Summing `amount` overstated every fee-bearing asset.
  'SELECT COALESCE(SUM(COALESCE(delivered, amount)),0) s FROM payouts WHERE mint=? AND paid_at IS NOT NULL').get(mint)?.s) || 0;
/** What has been allocated to holders and not yet sent. */
export const holderWaiting = (mint) => Number(db.prepare(
  'SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE mint=? AND claim_sig IS NULL').get(mint)?.s) || 0;

export function creatorCutBps(t) {
  if (!t) return 0;
  if (t.venue === 'dbc' || t.venue === 'launchlab') {
    return Math.round((Number(t.pool_fee_bps) || 0) * (Number(t.creator_share_pct) || 0) / 100);
  }
  return Number(t.creator_bps) || 0;
}

function settleCreator(t, ts) {
  const amt = t.creator_pot; if (!(amt > 0)) return 0;
  // Whoever brought this creator to the platform earns a standing cut of every launch they make.
  let toCreatorRef = 0;
  // The launch itself has to be real before whoever brought the creator earns on it: if the token
  // never traded enough to clear the vesting bar, spinning up alt creators pays nothing.
  const launchQualifies = (t.volume || 0) * (usdOf(t.quote) || 0) >= cfg.refVestVolumeUsd
    && !sameFundingCluster(t.creator_ref, t.creator);
  if (t.creator_ref && cfg.creatorRefBps > 0 && t.creator_ref !== t.creator && launchQualifies) {
    toCreatorRef = amt * Math.min(10_000, cfg.creatorRefBps) / 10_000;
    credit(t.creator_ref, t.quote, toCreatorRef);
    db.prepare('UPDATE tokens SET creator_ref_paid=creator_ref_paid+? WHERE mint=?').run(toCreatorRef, t.mint);
  }
  const rest = amt - toCreatorRef;
  const share = Math.min(REF_SHARE_MAX_BPS, t.ref_share_bps || 0);
  let toRefs = 0, paidRefs = [];
  if (share > 0) {
    const pool = rest * share / 10_000;
    // The $REX hold is a CONTINUING requirement, not a one-time gate: a referrer who qualified and
    // then sold stops earning, and their share redistributes to the sharers who are still holding.
    const rows = db.prepare('SELECT referrer, volume FROM ref_credit WHERE mint=? AND volume > 0').all(t.mint)
      .filter((r) => cfg.refHoldUsd <= 0 || rexHeldUsd(r.referrer) >= cfg.refHoldUsd);
    const total = rows.reduce((x, r) => x + r.volume, 0);
    if (total > 0 && pool > 0) {
      const ins = db.prepare('UPDATE ref_credit SET earned=earned+? WHERE mint=? AND referrer=?');
      for (const r of rows) {
        const cut = pool * r.volume / total; if (!(cut > 0)) continue;
        credit(r.referrer, t.quote, cut); ins.run(cut, t.mint, r.referrer);
        toRefs += cut; paidRefs.push({ wallet: r.referrer, amount: cut });
      }
      db.prepare('UPDATE tokens SET ref_paid=ref_paid+? WHERE mint=?').run(toRefs, t.mint);
    }
  }
  credit(t.creator, t.quote, rest - toRefs);
  db.prepare('UPDATE tokens SET creator_pot=0, creator_paid=creator_paid+? WHERE mint=?').run(rest - toRefs, t.mint);
  if (paidRefs.length) events.push({ type: 'referral', mint: t.mint, symbol: t.symbol, quote: t.quote, total: toRefs, count: paidRefs.length, ts });
  return rest - toRefs;
}
/** The vault leg arrives as quote and is deposited as liquidity: 70% LP, 30% quote bid. No redeem. */
function settleVault(t, ts) {
  const amt = t.vault_pot; if (!(amt > 0)) return null;
  const lp = amt * VAULT_SPLIT.lp, bid = amt * VAULT_SPLIT.bid;
  const w = vaultWalletOf(t.mint); ensureWallet(w, 2); credit(w, t.quote, amt);
  db.prepare('UPDATE tokens SET vault_pot=0, vault_paid=vault_paid+?, vault_lp=vault_lp+?, vault_bid=vault_bid+? WHERE mint=?').run(amt, lp, bid, t.mint);
  return { address: w, quote: amt, lp, bid };
}
/** The burn leg buys the launched token with quote and destroys it. It never mints or taxes a send. */
function settleBurn(t, ts) {
  const amt = t.burn_pot; if (!(amt > 0)) return null;
  if (amt * usdOf(t.quote) < 0.01) return null;                      // too small to move the pool
  const w = burnerWalletOf(t.mint); ensureWallet(w, 2); credit(w, t.quote, amt);
  db.prepare('UPDATE tokens SET burn_pot=0 WHERE mint=?').run(t.mint);
  let bought = 0;
  try { bought = buy(w, t.mint, amt).tokensOut; } catch { return null; }  // a dust buy can revert; roll it forward
  db.prepare('UPDATE holdings SET amount=0 WHERE wallet=? AND mint=?').run(w, t.mint);
  db.prepare('UPDATE tokens SET burn_paid=burn_paid+?, burned_tokens=burned_tokens+? WHERE mint=?').run(amt, bought, t.mint);
  return { quote: amt, tokens: bought };
}
/** REX's own slice: 20% burns REX, 60% is a permissionless buyback, 20% joins the same LP. */
function settleRex(t, ts) {
  const amt = t.rex_pot; if (!(amt > 0)) return null;
  const burn = amt * REX_SLICE.burn, buyback = amt * REX_SLICE.buyback, lp = amt * REX_SLICE.lp;
  db.prepare('UPDATE tokens SET rex_pot=0, rex_paid=rex_paid+?, rex_burned=rex_burned+?, rex_bought=rex_bought+? WHERE mint=?').run(amt, burn, buyback, t.mint);
  return { quote: amt, burn, buyback, lp };
}

/**
 * The payout basket: which assets a coin pays its holders in, and in what proportion.
 *
 * Returns `{ legs }` for a valid basket, `null` when the coin has none (pay in the quote, which is
 * what every coin did before this existed), or `{ error }` when one is set but unusable.
 *
 * ⛔ AN UNUSABLE BASKET IS NEVER QUIETLY DOWNGRADED TO THE QUOTE. A creator who asked to pay in
 * DOGE and PEPE has not asked to pay in SOL, and a holder reading "pays DOGE" must not be handed
 * something else because a leg failed to parse. The caller skips the epoch and leaves the pool to
 * roll forward, which is recoverable; paying the wrong asset is not.
 *
 * Legs are restricted to the QUOTES registry because that is the only place a mint, its decimals
 * and a live price are all known together — and the payout rail resolves an asset by mint. An
 * asset that is not a quote yet (PEPE, at the time of writing) has to be added there first, with
 * the on-chain checks that entails, rather than smuggled in through a launch form.
 */
export function payoutBasket(t) {
  const raw = t?.payout_assets;
  if (!raw) return null;
  let legs;
  try { legs = JSON.parse(raw); } catch { return { error: 'the basket is not readable JSON' }; }
  if (!Array.isArray(legs) || legs.length === 0) return { error: 'the basket is empty' };
  const out = [];
  const seen = new Set();
  for (const l of legs) {
    const q = QUOTES[l?.asset];
    const bps = Number(l?.bps);
    if (!q) return { error: `${l?.asset} is not an asset this platform can pay in` };
    if (seen.has(q.symbol)) return { error: `${q.symbol} appears twice` };
    if (!Number.isInteger(bps) || bps <= 0) return { error: `${q.symbol} has no usable share` };
    seen.add(q.symbol);
    out.push({ asset: q.symbol, mint: q.mint, decimals: q.decimals, bps });
  }
  // ⛔ EXACTLY 10_000. A basket summing to 9,700 would underpay every holder of that coin on every
  // epoch, forever, and the shortfall would look like dust rather than like a bug.
  const total = out.reduce((a, l) => a + l.bps, 0);
  if (total !== 10_000) return { error: `the shares add up to ${total} bps, not 10000` };
  return { legs: out };
}

/**
 * Turn whatever a launch form sent into the exact string the column should hold, or an error.
 *
 * ⛔ IT VALIDATES BY RUNNING THE READER. A launch form is a stranger's input, and the one failure
 * that must be impossible is a basket that writes cleanly and then cannot be paid — so this does
 * not re-implement the rules, it hands the candidate to `payoutBasket` and keeps it only if the
 * thing that will later spend it accepts it. Two validators would drift, and the drift would only
 * show up at the first epoch, after the coin was live.
 */
export function normalizeBasket(input) {
  if (input === null || input === undefined || input === '') return { json: null };
  let legs = input;
  if (typeof legs === 'string') { try { legs = JSON.parse(legs); } catch { return { error: 'the basket is not readable JSON' }; } }
  if (!Array.isArray(legs) || legs.length === 0) return { error: 'the basket is empty' };
  const candidate = legs.map((l) => ({ asset: String(l?.asset ?? ''), bps: Math.round(Number(l?.bps) || 0) }));
  const probe = payoutBasket({ payout_assets: JSON.stringify(candidate) });
  if (!probe || probe.error) return { error: probe?.error || 'the basket is empty' };
  // ⛔ A QUOTE IS NOT AUTOMATICALLY PAYABLE. `payoutBasket` asks only whether the asset is in the
  // registry, so a transfer-fee coin ($GP, $ZCAT, $MASK, $SI, $ALLINU) or an issuer-freezable stock
  // passed it — see prices.payableAsset for why each category is excluded and why this is checked on
  // the write rather than the read. The model could never choose one; this route could.
  const unpayable = probe.legs.find((l) => !payableAsset(l.asset));
  if (unpayable) return { error: `${unpayable.asset} cannot be used to pay holders — it charges a fee on every transfer, or its issuer can freeze the account it is paid into` };
  return { json: JSON.stringify(probe.legs.map((l) => ({ asset: l.asset, bps: l.bps }))) };
}

export function runEpoch() {
  const ts = now();
  const toks = db.prepare('SELECT * FROM tokens WHERE yield_pool > 0 OR creator_pot > 0 OR vault_pot > 0 OR burn_pot > 0 OR rex_pot > 0').all();
  const results = [];
  for (const t of toks) {
    const r = tx(() => {
      const snap = rewardSnapshot(t.mint, t.yield_pool, ts);
      // The first epoch pays what was collected, however small — "a zero page is a bug". From the
      // second onward, dust rolls forward instead of paying out amounts nobody can see.
      const payHolders = t.yield_pool > 0 && snap.total > 0
        && (t.yield_epochs === 0 || t.yield_pool * usdOf(t.quote) >= cfg.minEpochUsd);
      const payouts = [];
      if (payHolders) {
        // The basket, if this coin has one. A set-but-broken basket stops THIS coin's epoch and
        // leaves its pool to roll forward — see payoutBasket: paying the wrong asset is the one
        // outcome that cannot be undone next epoch.
        const basket = payoutBasket(t);
        if (basket?.error) {
          log('⛔ epoch skipped for', t.symbol, '— payout basket unusable:', basket.error);
          return null;
        }
        const legs = basket?.legs || null;
        const quoteUsd = usdOf(t.quote);
        if (legs) {
          // ⛔ A LEG WITH NO PRICE CANNOT BE CONVERTED INTO, and dividing by a zero price yields
          // Infinity — which would be written to the ledger as a payout. Refuse the whole epoch
          // instead; the pool rolls forward and is paid once prices are back.
          if (!(quoteUsd > 0)) { log('⛔ epoch skipped for', t.symbol, '— no price for its quote', t.quote); return null; }
          const dead = legs.filter((l) => !(usdOf(l.asset) > 0)).map((l) => l.asset);
          if (dead.length) { log('⛔ epoch skipped for', t.symbol, '— no price for', dead.join(', ')); return null; }
        }
        const ins = db.prepare('INSERT INTO payouts(mint,wallet,amount,mult,epoch,ts,asset,asset_mint) VALUES(?,?,?,?,?,?,?,?)');
        for (const h of snap.eligible) {
          const amt = h.amount_quote; if (!(amt > 0)) continue;
          if (legs) {
            // One row per leg, each carrying its OWN asset so the claim rail can group by it.
            // `amt` is in quote units; each leg's share is converted at the two USD prices.
            for (const leg of legs) {
              const legQuote = amt * leg.bps / 10_000;
              const legAmt = legQuote * quoteUsd / usdOf(leg.asset);
              if (!(legAmt > 0) || !Number.isFinite(legAmt)) continue;
              credit(h.wallet, leg.asset, legAmt);
              ins.run(t.mint, h.wallet, legAmt, 1, ts, ts, leg.asset, leg.mint);
            }
          } else {
            credit(h.wallet, t.quote, amt); ins.run(t.mint, h.wallet, amt, 1, ts, ts, null, null);
          }
          // `yield_earned` stays denominated in the QUOTE whatever the basket pays, because it is
          // what the coin earned this holder — mixing three assets into one running total would
          // make it a number with no unit.
          db.prepare('UPDATE holdings SET yield_earned=yield_earned+? WHERE wallet=? AND mint=?').run(amt, h.wallet, t.mint);
          payouts.push({ wallet: h.wallet, amount: amt, share: h.share });
        }
        // The ops cut stays in the QUOTE even when holders are paid a basket: it is the platform's
        // share of the fee as collected, not a holder reward, and nothing swaps it.
        if (snap.ops > 0) { credit(snap.opsWallet, t.quote, snap.ops); ins.run(t.mint, snap.opsWallet, snap.ops, 1, ts, ts, null, null); }
        db.prepare('UPDATE tokens SET yield_pool=0, yield_paid=yield_paid+?, yield_payouts=yield_payouts+?, yield_epochs=yield_epochs+1 WHERE mint=?').run(t.yield_pool, payouts.length, t.mint);
        db.prepare('INSERT INTO epochs(mint,pool,holders,ts) VALUES(?,?,?,?)').run(t.mint, t.yield_pool, payouts.length, ts);
        // Who was holding when it paid — the record behind "epochs survived".
        const held = db.prepare('INSERT OR IGNORE INTO epoch_held(wallet,mint,epoch) VALUES(?,?,?)');
        for (const h of payouts) held.run(h.wallet, t.mint, t.yield_epochs || 0);
        markMilestone(t.mint, 'firstEpoch', t.yield_pool);
      }
      // ⛔ THESE FOUR ARE PAPER SETTLEMENTS AND MUST NOT RUN AGAINST REAL MONEY.
      //
      // settleRex zeroes rex_pot into rex_paid and books rex_burned/rex_bought; settleVault,
      // settleBurn and settleCreator do the equivalent for their buckets. Not one of them moves a
      // token on chain — they are the demo engine modelling what the program would do. On mainnet
      // they ran anyway, every epoch, so the protocol's real income was consumed from its bucket
      // and recorded as burned and bought back when nothing of the sort had happened: rex_paid
      // reached 2,093,861 REX while every one of those tokens still sat in the fee claimer.
      //
      // It also starved the payout rail, which pays out of rex_pot — the epoch emptied the bucket
      // before anything could send it, which is why a dry run reported "nothing owed" against a
      // wallet holding 2.12M REX.
      //
      // A launch with a REAL rail does not get a paper settlement. For a Meteora launch these
      // buckets belong to lib/payout.mjs and to the creator's own claim on the pool, and they stay
      // put until something actually transfers them. The paper curve keeps its own behaviour, which
      // is what the demo and the engine suite exercise.
      const paper = t.venue !== 'dbc';
      const creator = paper ? settleCreator(t, ts) : null;
      const vault = paper ? settleVault(t, ts) : null;
      const rex = paper ? settleRex(t, ts) : null;
      const burn = paper ? settleBurn(getToken.get(t.mint), ts) : null;   // re-read: the vault pass moved money
      if (!payHolders && !creator && !vault && !burn && !rex) return null;
      payouts.sort((a, b) => b.amount - a.amount);
      return { mint: t.mint, symbol: t.symbol, name: t.name, image: t.image, quote: t.quote,
        pool: payHolders ? t.yield_pool : 0, holders: payouts.length, skipped: snap.skipped.length,
        floorQuote: snap.floorQuote, creator, vault, burn, rex, top: payouts.slice(0, 5), payouts };
    });
    if (r) { results.push(r); events.push({ type: 'yield', ...r, payouts: undefined, ts }); }
  }
  db.prepare("INSERT INTO meta(k,v) VALUES('epoch_at',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(ts));
  if (results.length) log('💎 epoch paid', results.length, 'tokens', results.map((r) => `${r.symbol}:${r.pool.toFixed(3)}${r.quote}/${r.holders}`).join(' '));
  return results;
}

// ---------- read models
const vol = db.prepare('SELECT COALESCE(SUM(quote),0) v, COUNT(*) n FROM trades WHERE mint=? AND ts>=?');
const lastPriceBefore = db.prepare('SELECT c FROM candles WHERE mint=? AND ts<=? ORDER BY ts DESC LIMIT 1');
// The pairs board asks the same questions over 7d, 30d and all time. Rewards come from `epochs`
// rather than tokens.yield_paid because that column is a running total and a board that showed a
// lifetime figure in a 24H column would be quietly wrong on every row.
const firstPrice = db.prepare('SELECT c FROM candles WHERE mint=? ORDER BY ts ASC LIMIT 1');
const paidSince = db.prepare('SELECT COALESCE(SUM(pool),0) v, COUNT(*) n FROM epochs WHERE mint=? AND ts>=?');
db.exec('CREATE INDEX IF NOT EXISTS epochs_mint_ts ON epochs(mint, ts DESC)');
export function publicToken(t, opts = {}) {
  if (!t) return null;
  const usd = usdOf(t.quote); const tnow = now();
  const progress = t.status === 'graduated' ? 1 : Math.min(1, t.real_quote / t.raise_target);
  const out = {
    mint: t.mint, name: t.name, symbol: t.symbol, description: t.description, image: t.image, website: t.website, twitter: t.twitter, telegram: t.telegram,
    creator: t.creator, quote: t.quote, quoteUsd: usd, taxBps: t.tax_bps, fairOpenSecs: t.fair_open_secs, fairOpenEnds: t.fair_open_ends, status: t.status,
    // The fee module, exactly as the creator set it. `rexBps` is REX's share OF holderBps.
    // How the holder bucket is split between holders. Surfaced on the public token so a buyer can see
    // which rule they are buying into BEFORE they buy, not after their first epoch.
    rewardMode: t.reward_mode || REWARD_MODE_DEFAULT,
    // WHERE this coin lives and under what rules. The client routes a trade by `venue`, so leaving
    // it off meant every DBC coin looked like a curve coin to the UI — and a trade addressed to the
    // wrong program is not a cosmetic bug.
    venue: t.venue || 'rexpad',
    // ⛔ TRAVELS WITH EVERY TOKEN, EVERYWHERE. A coin whose transfers can be refused by a separate
    // program is a different proposition from one whose cannot, and a buyer finding that out when a
    // sell fails is the worst possible moment. On the card, on the coin page, and in the public API.
    hookProgram: t.hook_program || null,
    dbcPool: t.dbc_pool || null,
    payoutRule: t.payout_rule || 'all',
    payoutN: t.payout_n ?? 25,
    // The basket, already parsed and validated, so a reader never has to trust the raw column.
    // `null` means this coin pays in its quote, which is what every coin did before baskets.
    payoutAssets: payoutBasket(t)?.legs || null,
    aiMode: aiModeOf(t.ai_mode),
    fees: { holderBps: t.holder_bps, creatorBps: t.creator_bps, vaultBps: t.vault_bps, burnBps: t.burn_bps,
            buybackBps: t.buyback_bps, rexBps: t.rex_bps,
            totalBps: (t.holder_bps || 0) + (t.creator_bps || 0) + (t.vault_bps || 0) + (t.burn_bps || 0) + (t.buyback_bps || 0),
            // REX's fee is carved out of the holder allocation, so this is what holders actually keep.
            holderNetBps: Math.max(0, (t.holder_bps || 0) - Math.min(t.rex_bps || 0, t.holder_bps || 0)) },
    // The three numbers the pair page posts, plus the vault's public address.
    buckets: { holderPot: t.yield_pool, creatorPot: t.creator_pot, vaultPot: t.vault_pot, burnPot: t.burn_pot, buybackPot: t.buyback_pot, rexPot: t.rex_pot,
               creatorPaid: t.creator_paid, vaultPaid: t.vault_paid, burnPaid: t.burn_paid, rexPaid: t.rex_paid,
               burnedTokens: t.burned_tokens, vaultLp: t.vault_lp, vaultBid: t.vault_bid,
               vaultAddress: vaultWalletOf(t.mint), burnerAddress: burnerWalletOf(t.mint) },
    guard: (() => { const g = guardOf(t, tnow); return g.left > 0 ? { capPct: g.cap * 100, decayBps: g.decay, secsLeft: Math.ceil(g.left), to: g.to } : null; })(),

    allowlisted: !!t.allowlist || t.allow_rex_usd > 0,
    // The social layer: what a sharer earns, and how much has already gone out that way.
    social: { refShareBps: t.ref_share_bps || 0, refPaid: t.ref_paid || 0,
              // ⛔ THE CREATOR'S CUT IS NOT THE SAME NUMBER ON BOTH VENUES. On the paper curve it is
              // `creator_bps` of each trade. On Meteora the creator takes `creator_share_pct` of the
              // POOL FEE, so their cut of a trade is pool_fee_bps x pct/100 — and `creator_bps` is 0
              // on every one of those rows. Using it there reported "sharers split 0% of every
              // trade" for a coin paying its creator 1%.
              refShareOfTradeBps: Math.round(creatorCutBps(t) * (t.ref_share_bps || 0) / 10_000),
              referrers: db.prepare('SELECT COUNT(*) n FROM ref_credit WHERE mint=? AND volume > 0').get(t.mint)?.n || 0,
              referred: db.prepare('SELECT COUNT(*) n FROM referrals WHERE mint=? AND vested=1').get(t.mint)?.n || 0 },
    price: t.price, priceUsd: t.price * usd, mcap: t.price * TOTAL_SUPPLY, mcapUsd: t.price * TOTAL_SUPPLY * usd,
    raiseTarget: t.raise_target, raised: t.real_quote, progress, liquidity: t.status === 'graduated' ? t.amm_quote * 2 : t.real_quote,
    // `yieldPool` is swept money; `pendingYield` is accruing on the pool and not yet claimed. The UI
    // adds them, because a holder is owed both and does not care which side of a sweep it sits on.
    yieldPool: t.yield_pool, pendingYield: t.pending_yield || 0,
    // ⛔ `yield_paid` IS AN ALLOCATION FIGURE AND WAS BEING SHOWN AS "Paid so far". An epoch
    // decides who gets what and increments it; the transfer happens later, and for the whole life
    // of this site it never happened at all — 307 rows, 85,301 of value, every one unsent. A
    // holder reading "Paid so far" was being told they had received money sitting in the fee
    // claimer. `yieldPaid` is now what the chain actually confirms, and what is still owed has
    // its own field rather than being quietly folded into the same number.
    yieldPaid: holderSent(t.mint), yieldOwed: holderWaiting(t.mint),
    yieldAllocated: t.yield_paid,
    yieldPayouts: t.yield_payouts, yieldEpochs: t.yield_epochs,
    fairOpenTotal: t.fair_open_total, fairOpenBidders: t.fair_open_bidders, fairOpenPrice: t.fair_open_price,
    createdAt: t.created_at, openedAt: t.opened_at, graduatedAt: t.graduated_at, lastTradeAt: t.last_trade_at, trades: t.trades, holders: t.holders, volume: t.volume,
  };
  // Costs a holdings scan, so it is opt-in: the detail page asks for it, list views never do.
  if (opts.reward) {
    const snap = rewardSnapshot(t.mint, t.yield_pool, tnow);
    out.reward = { eligible: snap.eligible.length, skipped: snap.skipped.length, floorQuote: snap.floorQuote, floorUsd: snap.floorUsd, allBelowFloor: snap.allBelowFloor };
  }
  if (opts.stats !== false) {
    const v24 = vol.get(t.mint, tnow - 86_400_000), v1 = vol.get(t.mint, tnow - 3_600_000);
    out.vol24 = v24.v; out.vol1h = v1.v; out.trades24 = v24.n;
    const p5 = lastPriceBefore.get(t.mint, tnow - 5 * 60_000)?.c, p1h = lastPriceBefore.get(t.mint, tnow - 3_600_000)?.c, p24 = lastPriceBefore.get(t.mint, tnow - 86_400_000)?.c;
    // ⛔ NULL, NOT ZERO, WHEN THERE IS NO PRICE TO COMPARE AGAINST. A coin younger than the window
    // has no candle before it, and reporting that as 0 renders "+0.0%" — which reads as "traded and
    // finished flat". Every freshly launched pair on the board therefore claimed to be unchanged
    // while it was actually moving several percent a minute, and the column looked broken because
    // in effect it was: it was stating a measurement nobody had made. null formats as "—".
    out.chg5m = p5 ? t.price / p5 - 1 : null; out.chg1h = p1h ? t.price / p1h - 1 : null; out.chg24h = p24 ? t.price / p24 - 1 : null;
    out.spark = db.prepare('SELECT c FROM candles WHERE mint=? ORDER BY ts DESC LIMIT 40').all(t.mint).reverse().map((r) => r.c);
  }
  // Opt-in, because it is six more statements per row and the home page needs none of them. The
  // pairs board asks for it; list views do not.
  if (opts.windows) {
    const D = 86_400_000;
    const since = (d) => tnow - d * D;
    const priceAt = (d) => lastPriceBefore.get(t.mint, since(d))?.c;
    const chg = (before) => (before ? t.price / before - 1 : null);  // null = no price that far back; see chg24h above
    out.vol7d = vol.get(t.mint, since(7)).v;
    out.vol30d = vol.get(t.mint, since(30)).v;
    out.volAll = t.volume;
    out.chg7d = chg(priceAt(7));
    out.chg30d = chg(priceAt(30));
    out.chgAll = chg(firstPrice.get(t.mint)?.c);
    out.paid24 = paidSince.get(t.mint, since(1)).v;
    out.paid7d = paidSince.get(t.mint, since(7)).v;
    out.paid30d = paidSince.get(t.mint, since(30)).v;
    out.paidAll = t.yield_paid;
    // Realized yield, annualised from what was ACTUALLY PAID in the window against the current cap.
    // Not a projection and not a promise: if a coin paid nothing this week its 7D figure is zero,
    // which is the number a holder deserves to see rather than an extrapolation of a better week.
    const ann = (paidQuote, days) => {
      const cap = t.price * TOTAL_SUPPLY;
      return cap > 0 && days > 0 ? (paidQuote / cap) * (365 / days) : 0;
    };
    const ageDays = Math.max(1 / 24, (tnow - t.created_at) / D);
    out.apy24 = ann(out.paid24, 1);
    out.apy7d = ann(out.paid7d, Math.min(7, ageDays));
    out.apy30d = ann(out.paid30d, Math.min(30, ageDays));
    out.apyAll = ann(out.paidAll, ageDays);
  }
  return out;
}
/**
 * The pairs board: every REX-quoted coin ranked, over a chosen window.
 *
 * Julz asked for one ranking with six ways in — volume, cap, rewards, realized yield, movers and
 * newest — so the window is a parameter rather than six near-identical endpoints. The totals strip
 * is computed from the SAME rows the table shows, not from a separate query: a footer that says
 * $152M while the rows visibly add to less is the fastest way to make a board look made up.
 */
export const PAIR_WINDOWS = ['24h', '7d', '30d', 'all'];
export const PAIR_SORTS = ['volume', 'mcap', 'rewards', 'apy', 'gainers', 'new'];

export function listPairs({ window: win = '24h', sort = 'volume', q = null, quote = null, limit = 100 } = {}) {
  const w = PAIR_WINDOWS.includes(win) ? win : '24h';
  const key = PAIR_SORTS.includes(sort) ? sort : 'volume';
  const where = []; const args = [];
  if (quote) { where.push('quote=?'); args.push(quote); }
  if (q) { where.push('(name LIKE ? OR symbol LIKE ? OR mint LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  // A coin that never opened has no price, no holders and no volume — it is not a pair yet, and
  // listing it would put a row of zeroes at the bottom of every sort.
  where.push("status IN ('live','graduated')");
  const rows = db.prepare(`SELECT * FROM tokens ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 400`).all(...args);

  const pick = (t, a, b, c, d) => ({ '24h': a, '7d': b, '30d': c, all: d }[w]);
  const out = rows.map((t) => {
    const o = publicToken(t, { windows: true });
    const usd = o.quoteUsd || 0;
    o.window = w;
    o.volWin = pick(o, o.vol24, o.vol7d, o.vol30d, o.volAll);
    o.chgWin = pick(o, o.chg24h, o.chg7d, o.chg30d, o.chgAll);
    o.paidWin = pick(o, o.paid24, o.paid7d, o.paid30d, o.paidAll);
    o.apyWin = pick(o, o.apy24, o.apy7d, o.apy30d, o.apyAll);
    o.volWinUsd = o.volWin * usd;
    o.paidWinUsd = o.paidWin * usd;
    return o;
  });

  const cmp = {
    volume: (a, b) => b.volWinUsd - a.volWinUsd,
    mcap: (a, b) => b.mcapUsd - a.mcapUsd,
    rewards: (a, b) => b.paidWinUsd - a.paidWinUsd,
    apy: (a, b) => b.apyWin - a.apyWin,
    gainers: (a, b) => (b.chgWin ?? 0) - (a.chgWin ?? 0),   // unmeasurable sorts with flat, never above a real gain
    new: (a, b) => b.createdAt - a.createdAt,
  }[key];
  // Every sort breaks its ties on cap, so equal rows (very common at zero volume) hold a stable
  // order instead of shuffling on each poll.
  out.sort((a, b) => cmp(a, b) || b.mcapUsd - a.mcapUsd);

  const sum = (f) => out.reduce((n, t) => n + (f(t) || 0), 0);
  const capTotal = sum((t) => t.mcapUsd);
  return {
    window: w,
    sort: key,
    pairs: out.slice(0, limit),
    totals: {
      pairs: out.length,
      volumeUsd: sum((t) => t.volWinUsd),
      mcapUsd: capTotal,
      rewardsUsd: sum((t) => t.paidWinUsd),
      // Cap-weighted, not a plain mean: averaging percentages across coins lets a $200 coin that
      // paid once outvote the whole book.
      avgApy: capTotal > 0 ? sum((t) => t.apyWin * t.mcapUsd) / capTotal : 0,
      holders: sum((t) => t.holders),
    },
  };
}

export function listTokens({ sort = 'new', quote = null, status = null, q = null, limit = 60 } = {}) {
  let where = []; const args = [];
  if (quote) { where.push('quote=?'); args.push(quote); }
  if (status) { where.push('status=?'); args.push(status); }
  // Mint matches ANYWHERE, not just as a prefix. People paste the last few characters of a contract
  // address as often as the first — it is what fits in a screenshot and what a block explorer shows.
  if (q) { where.push('(name LIKE ? OR symbol LIKE ? OR mint LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(`SELECT * FROM tokens ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 400`).all(...args);
  let out = rows.map((t) => publicToken(t));
  const key = { new: (a, b) => b.createdAt - a.createdAt, trending: (a, b) => b.vol1h - a.vol1h || b.mcapUsd - a.mcapUsd, volume: (a, b) => b.vol24 - a.vol24, mcap: (a, b) => b.mcapUsd - a.mcapUsd, graduating: (a, b) => (b.status === 'graduated' ? -1 : b.progress) - (a.status === 'graduated' ? -1 : a.progress), paid: (a, b) => b.yieldPaid * b.quoteUsd - a.yieldPaid * a.quoteUsd, holders: (a, b) => b.holders - a.holders }[sort] || null;
  if (key) out.sort(key);
  return out.slice(0, limit);
}
/**
 * The crown goes to whoever is most traded this hour — unless it has been handed to someone for a
 * fixed window.
 *
 * The automatic rule is the right default: it cannot be gamed by whoever happens to be in the room,
 * and it keeps moving. But a launch worth pointing at deserves to be pointed at, and the only way
 * to do that was to out-trade the board. The override is deliberately TIME-BOXED rather than a
 * sticky flag: a crown nobody can lose is a crown worth nothing, and an override with no expiry is
 * one somebody forgets to clear. When the window passes, the automatic rule resumes on its own with
 * no second action required.
 */
const META_GET = db.prepare('SELECT v FROM meta WHERE k=?');
const META_SET = db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');

export function setKing(mint, hours = 24) {
  if (!mint) { META_SET.run('king_mint', ''); META_SET.run('king_until', '0'); return null; }
  const t = getToken.get(mint);
  if (!t) throw new Error('unknown mint');
  const until = now() + Math.max(1, Math.min(24 * 7, Number(hours) || 24)) * 3_600_000;
  META_SET.run('king_mint', mint);
  META_SET.run('king_until', String(until));
  return { mint, until };
}
export function kingOverride() {
  const mint = META_GET.get('king_mint')?.v || '';
  const until = Number(META_GET.get('king_until')?.v || 0);
  return mint && until > now() ? { mint, until } : null;
}

export function kingOfTheHill() {
  const o = kingOverride();
  if (o) {
    const t = getToken.get(o.mint);
    // A crowned coin that has since graduated or vanished must not freeze the strip on a dead row.
    if (t && t.status === 'live') return { ...publicToken(t), crownedUntil: o.until, dubbed: true };
  }
  const rows = db.prepare("SELECT * FROM tokens WHERE status='live' ORDER BY created_at DESC LIMIT 200").all().map((t) => publicToken(t));
  return rows.sort((a, b) => b.vol1h * b.quoteUsd - a.vol1h * a.quoteUsd || b.mcapUsd - a.mcapUsd)[0] || null;
}
export function globalStats() {
  const tnow = now();
  const paid = db.prepare('SELECT quote, SUM(yield_paid) s, SUM(yield_payouts) n FROM tokens GROUP BY quote').all().reduce((a, r) => ({ usd: a.usd + r.s * usdOf(r.quote), n: a.n + r.n }), { usd: 0, n: 0 });
  const v24 = db.prepare('SELECT t.quote q, SUM(tr.quote) v FROM trades tr JOIN tokens t ON t.mint=tr.mint WHERE tr.ts>=? GROUP BY t.quote').all(tnow - 86_400_000).reduce((s, r) => s + r.v * usdOf(r.q), 0);
  const c = db.prepare("SELECT COUNT(*) n, SUM(status='graduated') g, SUM(status='fairopen') f, SUM(created_at>=?) d FROM tokens").get(tnow - 86_400_000);
  const fo = db.prepare("SELECT COUNT(*) n FROM trades WHERE kind='fairopen'").get().n;
  return { paidUsd: paid.usd, payouts: paid.n, vol24Usd: v24, launches: c.n, launches24: c.d || 0, graduated: c.g || 0, fairOpensLive: c.f || 0, fairOpenFills: fo, nextEpochAt: nextEpochAt(), epochMs: cfg.epochMs };
}
export function holdersOf(mint, limit = 50) {
  const t = getToken.get(mint); const tnow = now();
  const rows = db.prepare(`SELECT h.*, w.bot, w.name nm FROM holdings h LEFT JOIN wallets w ON w.wallet=h.wallet WHERE h.mint=? AND h.amount > 1 AND ${NOT_RESERVE} ORDER BY h.amount DESC LIMIT ?`).all(mint, limit);
  // Reward share comes from the same snapshot the payout uses, so it already reflects this token's
  // reward_mode: under Diamond Hands the tier badge is load-bearing (up to 3x), under 'flat' it is a
  // label only.
  const snap = rewardSnapshot(mint, 1, tnow);
  const shares = new Map(snap.eligible.map((h) => [h.wallet, h.share]));
  return rows.map((h) => { const c = convictionOf(h.held_since, tnow); return { wallet: h.wallet, name: h.nm, amount: h.amount, pct: h.amount / TOTAL_SUPPLY, heldSince: h.held_since, tier: c.label, hours: c.hours, share: shares.get(h.wallet) || 0, belowFloor: !shares.has(h.wallet), yieldEarned: h.yield_earned, isDev: h.wallet === t?.creator }; });
}
/** What one wallet has brought to one token, and earned for it. */
export function refStatsFor(wallet, mint) {
  if (!isWalletish(wallet) || typeof mint !== 'string') return { code: null, brought: 0, pending: 0, volume: 0, earned: 0, broughtBy: null };
  const c = db.prepare('SELECT volume, earned FROM ref_credit WHERE mint=? AND referrer=?').get(mint, wallet);
  const n = db.prepare('SELECT COUNT(*) n FROM referrals WHERE mint=? AND referrer=? AND vested=1').get(mint, wallet)?.n || 0;
  const pending = db.prepare('SELECT COUNT(*) n FROM referrals WHERE mint=? AND referrer=? AND vested=0 AND rejected IS NULL').get(mint, wallet)?.n || 0;
  const broughtBy = db.prepare('SELECT referrer FROM referrals WHERE mint=? AND referee=?').get(mint, wallet)?.referrer || null;
  return { code: refCodeOf(wallet), brought: n, pending, volume: c?.volume || 0, earned: c?.earned || 0, broughtBy };
}
/** Everything one wallet has earned by sharing, across every token. */
export function refSummary(wallet) {
  const rows = db.prepare(`SELECT c.mint, c.volume, c.earned, t.symbol, t.name, t.image, t.quote
    FROM ref_credit c JOIN tokens t ON t.mint=c.mint WHERE c.referrer=? AND c.volume > 0 ORDER BY c.earned DESC`).all(wallet);
  const brought = db.prepare('SELECT COUNT(*) n FROM referrals WHERE referrer=? AND vested=1').get(wallet)?.n || 0;
  const earnedUsd = rows.reduce((s2, r) => s2 + r.earned * usdOf(r.quote), 0);
  const volumeUsd = rows.reduce((s2, r) => s2 + r.volume * usdOf(r.quote), 0);
  return { code: refCodeOf(wallet), brought, tokens: rows, earnedUsd, volumeUsd };
}
/** Who is bringing the most volume — per token, or across the whole platform. */
export function topReferrers(mint = null, limit = 20) {
  const rows = mint
    ? db.prepare('SELECT referrer wallet, volume, earned FROM ref_credit WHERE mint=? AND volume > 0 ORDER BY volume DESC LIMIT ?').all(mint, limit)
    : db.prepare(`SELECT c.referrer wallet, SUM(c.volume * 1.0) volume, SUM(c.earned * 1.0) earned, COUNT(DISTINCT c.mint) tokens
         FROM ref_credit c WHERE c.volume > 0 GROUP BY c.referrer ORDER BY volume DESC LIMIT ?`).all(limit);
  return rows.map((r) => ({ ...r, brought: db.prepare('SELECT COUNT(*) n FROM referrals WHERE referrer=? AND vested=1' + (mint ? ' AND mint=?' : '')).get(...(mint ? [r.wallet, mint] : [r.wallet]))?.n || 0 }));
}

/**
 * Can this wallet post in a token's room? The creator always can; everyone else needs a position
 * worth the same floor that gates rewards. A message costs nothing to send, so the floor is what
 * keeps the room worth reading.
 */
export function canChat(wallet, mint) {
  const t = getToken.get(mint); if (!t) return { ok: false, reason: 'Unknown token' };
  if (wallet === t.creator) return { ok: true, why: 'creator' };
  const h = holdingOf(wallet, mint);
  const floorUsd = cfg.chatFloorUsd;
  if (floorUsd <= 0) return { ok: true };
  const valueUsd = h.amount * t.price * usdOf(t.quote);
  if (valueUsd >= floorUsd) return { ok: true, why: 'holder' };
  const need = floorUsd / (t.price * usdOf(t.quote) || Infinity);
  return { ok: false, reason: `Hold at least $${floorUsd} of $${t.symbol} to post here`, needTokens: need, haveUsd: valueUsd, floorUsd };
}

/** The creator's update feed on their own token page. */
export function postUpdate(wallet, mint, text) {
  const t = getToken.get(mint); if (!t) throw new Error('Unknown token');
  if (wallet !== t.creator) throw new Error('Only the creator can post an update');
  const body = String(text || '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 500);
  if (body.length < 2) throw new Error('Say something');
  db.prepare('INSERT INTO posts(mint,wallet,text,ts) VALUES(?,?,?,?)').run(mint, wallet, body, now());
  const row = { id: db.prepare('SELECT last_insert_rowid() id').get().id, mint, wallet, text: body, ts: now() };
  events.push({ type: 'post', ...row, symbol: t.symbol, image: t.image });
  return row;
}
export const postsOf = (mint, limit = 20) => db.prepare('SELECT * FROM posts WHERE mint=? ORDER BY ts DESC LIMIT ?').all(mint, limit);

export function tradesOf(mint, limit = 60) { return db.prepare('SELECT * FROM trades WHERE mint=? ORDER BY ts DESC LIMIT ?').all(mint, limit); }
/**
 * Was this the first time this wallet ever bought this coin?
 *
 * Asked at broadcast time, when the row is already written, so the trade being asked about is
 * included in the count — one means it is the only one, i.e. a brand new holder. Bounded by `ts`
 * rather than counting the lot, because the DBC indexer backfills history and a wallet's first buy
 * must stay its first buy when an older page of signatures arrives later.
 */
export function isFirstBuy(mint, wallet, ts) {
  if (!mint || !wallet) return false;
  const r = db.prepare("SELECT COUNT(*) n FROM trades WHERE mint=? AND wallet=? AND side='buy' AND ts<=?").get(mint, wallet, ts);
  return (r?.n || 0) <= 1;
}

/**
 * Recent BUYS, across every pair.
 *
 * The ticker tape already carries every trade, but a tape is a strip of glyphs you read in passing —
 * MiKOL asked for a feed, and a feed is a different thing: who bought, how much it was worth in real
 * money, and whether that wallet had ever held the coin before. The last of those is the only figure
 * here that is not already on the page somewhere, and it is the one that tells you whether a coin is
 * being accumulated by the same four wallets or actually finding new holders.
 *
 * `firstBuy` is a NOT EXISTS over the same table rather than a GROUP BY, because the question is per
 * ROW ("had this wallet bought this coin before this trade?") and the trades_mint index makes it a
 * seek. Sells are excluded here on purpose: a buys feed with sells in it is the tape again.
 */
export function recentBuys(limit = 30, { minUsd = 0 } = {}) {
  const rows = db.prepare(`SELECT tr.*, t.symbol, t.name, t.image, t.quote quoteSymbol,
      NOT EXISTS (SELECT 1 FROM trades x WHERE x.mint=tr.mint AND x.wallet=tr.wallet AND x.side='buy' AND x.ts < tr.ts) firstBuy
    FROM trades tr JOIN tokens t ON t.mint=tr.mint
    WHERE tr.side='buy' AND tr.quote > 0
    ORDER BY tr.ts DESC LIMIT ?`).all(Math.min(Number(limit) || 30, 200));
  // The USD value is computed here and not in the browser: the page has no quote-price table, and a
  // feed whose sizes are in fourteen different units cannot be read at a glance or sorted by size.
  return rows.map((r) => ({
    mint: r.mint, symbol: r.symbol, name: r.name, image: r.image,
    wallet: r.wallet, quote: r.quote, quoteSymbol: r.quoteSymbol, tokens: r.tokens,
    price: r.price, kind: r.kind, ts: r.ts,
    usd: r.quote * usdOf(r.quoteSymbol),
    firstBuy: !!r.firstBuy,
  })).filter((r) => r.usd >= (Number(minUsd) || 0));
}
export function recentTrades(limit = 40) { return db.prepare('SELECT tr.*, t.symbol, t.name, t.image, t.quote quoteSymbol FROM trades tr JOIN tokens t ON t.mint=tr.mint ORDER BY tr.ts DESC LIMIT ?').all(limit); }
export function portfolio(wallet) {
  const tnow = now();
  const balances = db.prepare('SELECT asset, amount FROM balances WHERE wallet=? AND amount>0').all(wallet);
  const hold = db.prepare('SELECT h.*, t.symbol, t.name, t.image, t.quote, t.price, t.status, t.creator FROM holdings h JOIN tokens t ON t.mint=h.mint WHERE h.wallet=? AND h.amount>1 ORDER BY h.amount*t.price DESC').all(wallet)
    .map((h) => { const c = convictionOf(h.held_since, tnow); const value = h.amount * h.price; return { mint: h.mint, symbol: h.symbol, name: h.name, image: h.image, quote: h.quote, quoteUsd: usdOf(h.quote), amount: h.amount, value, valueUsd: value * usdOf(h.quote), cost: h.cost, pnl: value - h.cost, realized: h.realized, yieldEarned: h.yield_earned, heldSince: h.held_since, tier: c.label, status: h.status, isDev: h.creator === wallet }; });
  const created = db.prepare('SELECT * FROM tokens WHERE creator=? ORDER BY created_at DESC').all(wallet).map((t) => publicToken(t));
  // ⛔ GROUPED BY THE ROW'S ASSET, NOT JUST BY COIN. A basket coin pays one holder in several
  // assets, so grouping by mint alone would sum DOGE and PEPE into one number and then price the
  // lot at whichever quote the join happened to return — a total with no unit.
  const yieldRows = db.prepare(`SELECT p.mint, COALESCE(p.asset, t.quote) AS quote, SUM(p.amount) s, COUNT(*) n
    FROM payouts p JOIN tokens t ON t.mint=p.mint WHERE p.wallet=?
    GROUP BY p.mint, COALESCE(p.asset, t.quote)`).all(wallet);
  const yieldUsd = yieldRows.reduce((s, r) => s + r.s * usdOf(r.quote), 0);
  const recent = db.prepare('SELECT tr.*, t.symbol, t.image, t.quote quoteSymbol FROM trades tr JOIN tokens t ON t.mint=tr.mint WHERE tr.wallet=? ORDER BY tr.ts DESC LIMIT 30').all(wallet);
  // The row's own asset is what was actually paid, so it is what the list must say.
  const payouts = db.prepare(`SELECT p.*, t.symbol, COALESCE(p.asset, t.quote) AS quote
    FROM payouts p JOIN tokens t ON t.mint=p.mint WHERE p.wallet=? ORDER BY p.ts DESC LIMIT 30`).all(wallet);
  const bids = db.prepare('SELECT b.*, t.symbol, t.quote, t.fair_open_ends FROM bids b JOIN tokens t ON t.mint=b.mint WHERE b.wallet=?').all(wallet);
  return { wallet, balances, holdings: hold, created, yieldUsd, yieldPayouts: yieldRows.reduce((s, r) => s + r.n, 0), recent, payouts, bids };
}
export function leaderboard() {
  const tnow = now();
  const coins = db.prepare('SELECT * FROM tokens WHERE yield_paid>0 ORDER BY yield_paid DESC LIMIT 100').all().map((t) => publicToken(t, { stats: false })).sort((a, b) => b.yieldPaid * b.quoteUsd - a.yieldPaid * a.quoteUsd).slice(0, 10);
  const earners = db.prepare(`SELECT p.wallet, COALESCE(p.asset, t.quote) AS quote, SUM(p.amount) s, COUNT(*) n
    FROM payouts p JOIN tokens t ON t.mint=p.mint GROUP BY p.wallet, COALESCE(p.asset, t.quote)`).all()
    .reduce((m, r) => { const e = m.get(r.wallet) || { wallet: r.wallet, usd: 0, n: 0 }; e.usd += r.s * usdOf(r.quote); e.n += r.n; m.set(r.wallet, e); return m; }, new Map());
  const topEarners = [...earners.values()].sort((a, b) => b.usd - a.usd).slice(0, 10);
  const diamond = db.prepare(`SELECT h.wallet, h.mint, h.amount, h.held_since, t.symbol, t.price, t.quote FROM holdings h JOIN tokens t ON t.mint=h.mint WHERE h.amount>1 AND ${NOT_RESERVE} ORDER BY h.held_since ASC LIMIT 200`).all()
    .map((h) => ({ wallet: h.wallet, mint: h.mint, symbol: h.symbol, heldSince: h.held_since, ...convictionOf(h.held_since, tnow), valueUsd: h.amount * h.price * usdOf(h.quote) })).sort((a, b) => b.hours - a.hours || b.valueUsd - a.valueUsd).slice(0, 10);
  const creators = db.prepare('SELECT creator, COUNT(*) n, SUM(status=\'graduated\') g FROM tokens GROUP BY creator ORDER BY g DESC, n DESC LIMIT 10').all();
  return { coins, topEarners, diamond, creators };
}

// ---------------------------------------------------------------- the creator's own coins
/** Every coin a wallet launched, newest first. Raw rows: the creator dashboard needs the venue and
 *  the pool address, which `publicToken` deliberately does not carry in full. */
export function coinsByCreator(creator) {
  return db.prepare('SELECT * FROM tokens WHERE creator=? ORDER BY created_at DESC').all(creator);
}
/**
 * Put a website and socials on a coin AFTER it launched, or correct one.
 *
 * Most live coins carry no links at all, and the ones that do had no way to fix a typo: the three
 * fields were only ever written by the launch form, in the seconds before the mint was signed.
 *
 * ⛔ IT HAS TO WRITE BOTH TABLES. `indexer.reconcile()` re-upserts every on-chain launch on a short
 * timer and takes website/twitter/telegram from `token_meta` — so an edit written only to `tokens`
 * saves, survives a reload, and is silently reverted within a tick.
 *
 * ⛔ AND `token_meta` IS UPDATED, NEVER INSERTED. A row invented here would carry a null name, and
 * that same upsert would then rename the coin to the first six characters of its mint.
 *
 * Held to the launch form's own rule by the launch form's own sanitiser, and an empty field CLEARS:
 * a creator who put the wrong Telegram on a coin has to be able to take it off again, and a blank
 * that quietly kept the old value would look exactly like a save that worked.
 */
export function setLinks(mint, creator, o) {
  const t = getToken.get(mint);
  if (!t) throw new Error('unknown coin');
  if (t.creator !== creator) throw new Error('Only the wallet that launched this coin can change its links.');
  const v = { website: cleanLink(o.website), twitter: cleanLink(o.twitter), telegram: cleanLink(o.telegram) };
  return tx(() => {
    db.prepare('UPDATE tokens SET website=?, twitter=?, telegram=? WHERE mint=?').run(v.website, v.twitter, v.telegram, mint);
    db.prepare('UPDATE token_meta SET website=?, twitter=?, telegram=? WHERE mint=?').run(v.website, v.twitter, v.telegram, mint);
    return v;
  });
}

/** Track what has gone out through this site. ⛔ This is NOT the authority on what is still owed —
 *  for a Meteora coin the pool account is, and a claim made anywhere else never reaches this row. */
export function recordCreatorClaim(mint, amount) {
  if (!(amount > 0)) return;
  db.prepare('UPDATE tokens SET creator_paid=creator_paid+? WHERE mint=?').run(amount, mint);
}

/* ---------------------------------------------------------------- affiliate tree + feedback */

/**
 * Who a wallet brought, and who those wallets brought, down to `maxDepth`.
 *
 * Elio, 5 Oct: "a dashboard for them to see their affiliate tree, with leaderboard to see who was
 * invited more". The edge is `wallets.referred_by` — platform-level and first-touch, so each wallet
 * has at most one referrer and the whole thing is a forest.
 *
 * ⛔ CYCLES ARE POSSIBLE AND MUST BE GUARDED HERE. `attributeWallet` refuses a DIRECT swap (A
 * brought B, B cannot then bring A) but nothing stops A→B→C→A, which is three ordinary first-touch
 * attributions. Walking that without a seen-set is an infinite loop that takes the server with it.
 * `maxDepth` alone is not the guard: it would still re-count the same wallets at every level.
 */
export function affiliateTree(wallet, { maxDepth = 5, maxNodes = 500 } = {}) {
  if (!isWalletish(wallet)) return { root: null, levels: [], total: 0, volume: 0, earned: 0 };
  const kids = db.prepare('SELECT wallet, referred_at FROM wallets WHERE referred_by=? ORDER BY referred_at ASC');
  // What each wallet has actually produced, so a tree shows worth rather than just names.
  const stat = db.prepare(`SELECT COALESCE(SUM(volume),0) volume, COALESCE(SUM(earned),0) earned,
                                  COUNT(*) tokens, SUM(vested) vested FROM referrals WHERE referee=?`);
  const seen = new Set([wallet]);
  const levels = [];
  let frontier = [wallet], total = 0, volume = 0, earned = 0;
  for (let depth = 1; depth <= maxDepth && frontier.length && total < maxNodes; depth++) {
    const next = [], rows = [];
    for (const parent of frontier) {
      for (const k of kids.all(parent)) {
        if (seen.has(k.wallet) || total >= maxNodes) continue;   // the cycle guard, and the ceiling
        seen.add(k.wallet);
        const st = stat.get(k.wallet) || {};
        rows.push({ wallet: k.wallet, parent, at: k.referred_at,
          volume: Number(st.volume) || 0, earned: Number(st.earned) || 0,
          tokens: Number(st.tokens) || 0, vested: Number(st.vested) || 0 });
        next.push(k.wallet); total++;
        volume += Number(st.volume) || 0; earned += Number(st.earned) || 0;
      }
    }
    if (!rows.length) break;
    levels.push({ depth, count: rows.length, members: rows });
    frontier = next;
  }
  return { root: wallet, levels, total, volume, earned, truncated: total >= maxNodes };
}

/** Who has brought the most wallets to the platform. The tree's leaderboard. */
export function topInviters(limit = 20) {
  return db.prepare(`SELECT referred_by wallet, COUNT(*) invited, MIN(referred_at) since
    FROM wallets WHERE referred_by IS NOT NULL GROUP BY referred_by
    ORDER BY invited DESC, since ASC LIMIT ?`).all(limit)
    .map((r) => {
      const st = db.prepare(`SELECT COALESCE(SUM(volume),0) v, COALESCE(SUM(earned),0) e FROM referrals WHERE referrer=?`).get(r.wallet) || {};
      return { ...r, volume: Number(st.v) || 0, earned: Number(st.e) || 0 };
    });
}

/**
 * Record a rating, a suggestion or a bug report.
 *
 * Deliberately accepts an ANONYMOUS submission: requiring a wallet to report a broken page means
 * the people most likely to have hit something broken — the ones who could not connect — are
 * exactly the ones who cannot tell you about it.
 */
export function addFeedback({ wallet = null, kind = 'rating', rating = null, text = '', page = null }) {
  const k = ['rating', 'suggestion', 'bug'].includes(kind) ? kind : 'rating';
  const r = rating == null ? null : Math.max(1, Math.min(5, Math.round(Number(rating) || 0)));
  const body = String(text || '').slice(0, 2000).trim();
  if (k === 'rating' && !r) throw new Error('Pick a rating from 1 to 5');
  if (k !== 'rating' && !body) throw new Error('Tell us what happened — a line is enough');
  const info = db.prepare(`INSERT INTO feedback(wallet,kind,rating,text,page,ts,status)
                           VALUES(?,?,?,?,?,?,'new')`)
    .run(wallet && isWalletish(wallet) ? wallet : null, k, r, body, String(page || '').slice(0, 120), now());
  return { id: Number(info.lastInsertRowid), kind: k, rating: r };
}

/** Everything the admin panel shows, newest first. */
export function feedbackList({ status = null, limit = 100 } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM feedback WHERE status=? ORDER BY ts DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM feedback ORDER BY ts DESC LIMIT ?').all(limit);
  const counts = db.prepare("SELECT status, COUNT(*) n FROM feedback GROUP BY status").all();
  const avg = db.prepare("SELECT AVG(rating) a, COUNT(*) n FROM feedback WHERE rating IS NOT NULL").get() || {};
  return { rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    avgRating: avg.a ? Number(avg.a) : null, ratings: avg.n || 0 };
}

/** Move one item through new -> seen -> done, with an optional note. */
export function setFeedbackStatus(id, status, by, note = null) {
  if (!['new', 'seen', 'done'].includes(status)) throw new Error('bad status');
  db.prepare('UPDATE feedback SET status=?, note=COALESCE(?, note), handled_at=?, handled_by=? WHERE id=?')
    .run(status, note, Date.now(), by, Number(id));
  return db.prepare('SELECT * FROM feedback WHERE id=?').get(Number(id));
}
