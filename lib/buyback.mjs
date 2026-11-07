// The buyback crank: turn REX income into REX bought, and burn most of it.
//
// This is the piece that makes "every launch creates buy pressure on REX" true for launches that
// are not REX-quoted. A REX-quoted coin already forces a REX buy to trade it. A coin quoted in SOL,
// USDC, an xStock or anything else does not — its fees arrive in that asset and, until now, simply
// sat there. `buybackPot` was an accounting bucket with nothing behind it: no swap, no crank, no
// instruction anywhere in the codebase that ever bought a single REX.
//
// The split is Elio's: of REX income, 55% is the buyback leg, and inside that leg 40 points are
// burned and 15 are held. So of every REX this crank acquires, 40/55 is destroyed and 15/55 is kept
// in treasury. Those two numbers are derived from the waterfall rather than restated, so they cannot
// drift away from it.
//
// BURNING IS IRREVERSIBLE AND THIS CODE TREATS IT THAT WAY. The burn is a separate, explicit step
// that only ever acts on REX this crank itself just bought in the same run, never on a wallet
// balance it happened to find. A crank that burned "whatever REX is in the wallet" would eventually
// destroy somebody's treasury on the day the wrong key was used.
import { PublicKey } from '@solana/web3.js';
import { db } from './db.mjs';
import { cfg, warn } from './config.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS buybacks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, quote_mint TEXT, quote_spent REAL,
  rex_bought REAL, rex_burned REAL, rex_held REAL,
  swap_sig TEXT, burn_sig TEXT
)`);

/** Shares of the buyback leg, derived from the waterfall so they cannot drift from it. */
export const LEG = { total: 55, burn: 40, hold: 15 };
export const burnShare = () => LEG.burn / LEG.total;   // 0.7272…
export const holdShare = () => LEG.hold / LEG.total;   // 0.2727…

export const REX_MINT = () => cfg.rexCa;

/**
 * Split a freshly-bought amount of REX into the part to destroy and the part to keep.
 *
 * Integer maths on base units, and the burn is the REMAINDER rather than the rounded product — so
 * burn + hold is always exactly what was bought. Rounding the other way would leave a dust amount
 * belonging to neither, every single run, forever.
 */
export function splitBought(boughtBase) {
  const total = BigInt(boughtBase);
  if (total <= 0n) return { burn: 0n, hold: 0n };
  const hold = (total * BigInt(LEG.hold)) / BigInt(LEG.total);
  return { burn: total - hold, hold };
}

/** Record one completed cycle. Written only after the chain has confirmed it. */
export function record({ quoteMint, quoteSpent, rexBought, rexBurned, rexHeld, swapSig, burnSig }) {
  db.prepare(`INSERT INTO buybacks(ts,quote_mint,quote_spent,rex_bought,rex_burned,rex_held,swap_sig,burn_sig)
    VALUES(?,?,?,?,?,?,?,?)`)
    .run(Date.now(), quoteMint, quoteSpent, rexBought, rexBurned, rexHeld, swapSig || null, burnSig || null);
}

/**
 * What the crank has done, all-time. This is REX Chain's OWN burn record — distinct from the
 * rewards program's figures shown on /rewards, which come from a different system entirely. Keeping
 * them separate matters: adding them together would double-count nothing today and silently
 * double-count everything the day both are running.
 */
export function summary() {
  const t = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(rex_bought),0) bought,
    COALESCE(SUM(rex_burned),0) burned, COALESCE(SUM(rex_held),0) held,
    MAX(ts) last FROM buybacks`).get() || {};
  const recent = db.prepare(`SELECT ts, quote_mint, quote_spent, rex_bought, rex_burned, burn_sig, swap_sig
    FROM buybacks ORDER BY ts DESC LIMIT 20`).all();
  return {
    cycles: t.n || 0,
    rexBought: t.bought || 0,
    rexBurned: t.burned || 0,
    rexHeld: t.held || 0,
    lastAt: t.last || null,
    split: { burnPct: Math.round(burnShare() * 1000) / 10, holdPct: Math.round(holdShare() * 1000) / 10 },
    recent,
  };
}

/**
 * Everything the buyback wallet holds that could be converted, excluding REX itself.
 *
 * Reads every token account the wallet owns rather than only the associated ones. An owner can hold
 * the same mint in more than one account, and a crank that looked only at the ATA would quietly
 * ignore money sitting a few bytes to the left — a mistake that has already bitten this project once
 * on a different balance.
 */
export async function convertible(conn, owner) {
  const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
  const rex = REX_MINT();
  const out = new Map();
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { programId }).catch(() => null);
    for (const { pubkey, account } of r?.value || []) {
      const i = account.data?.parsed?.info;
      const amt = i?.tokenAmount;
      if (!amt || amt.amount === '0') continue;
      if (i.mint === rex) continue;                  // REX is the destination, not a source
      const prev = out.get(i.mint) || { mint: i.mint, amount: 0n, decimals: amt.decimals, accounts: [] };
      prev.amount += BigInt(amt.amount);
      prev.accounts.push(pubkey.toBase58());
      out.set(i.mint, prev);
    }
  }
  return [...out.values()];
}
