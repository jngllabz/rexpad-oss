// The vault crank. Plans by default, acts only when told to.
//
//   node tools/vault_crank.mjs                 # show what it WOULD do, touch nothing
//   node tools/vault_crank.mjs --execute       # actually deposit, requires VAULT_KEY
//
// This deploys vault money as liquidity so it earns instead of sitting still, and reports what the
// existing positions have made.
//
// It will not run blind. Planning needs no key at all, so the plan can be read and argued with
// before anything is signed, and `--execute` refuses unless a key is present and every pool it is
// about to touch still prices the way the plan assumed.
//
// ONE THING IT DELIBERATELY DOES NOT DO: a constant-product deposit needs BOTH sides of the pair,
// and the vault is funded in the quote asset alone. Acquiring the token side is a market buy, and
// this tool will not place one — it reports the shortfall and stops. Whoever operates the vault
// decides when and how to take that price risk; a crank that quietly swapped on its own would be
// making a trading decision nobody asked it to make.
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';

const EXECUTE = process.argv.includes('--execute');
const SLIPPAGE_BPS = Number(process.env.VAULT_SLIPPAGE_BPS || 100);

const V = await import('../lib/vault.mjs');
const R = await import('../lib/raydium.mjs');
const CH = await import('../lib/chain.mjs');
const { cfg } = await import('../lib/config.mjs');

const conn = CH.conn();
const ui = (n, d) => Number(n) / 10 ** d;

const key = process.env.VAULT_KEY;
const signer = key ? Keypair.fromSecretKey(bs58.decode(key)) : null;
if (EXECUTE && !signer) {
  console.error('--execute needs VAULT_KEY (base58 secret of the wallet holding the vault money).');
  process.exit(1);
}

console.log(`REX vault crank — ${EXECUTE ? 'EXECUTE' : 'plan only, nothing will be signed'}`);
if (signer) console.log(`vault wallet ${signer.publicKey.toBase58()}`);
console.log();

// ---------------------------------------------------------------- what we already hold
const pos = await V.positions();
if (pos.length) {
  console.log('CURRENT POSITIONS');
  for (const p of pos) {
    if (!p.redeemable) { console.log(`  ${p.mint.slice(0, 8)}  position unreadable (pool gone?)`); continue; }
    const pct = p.principal.quote > 0 ? ((p.earnedQuote / p.principal.quote) * 100).toFixed(2) : '—';
    console.log(`  ${p.mint.slice(0, 8)}  in ${p.principal.quote.toFixed(6)}  now ${p.redeemable.quote.toFixed(6)}  `
      + `earned ${p.earnedQuote >= 0 ? '+' : ''}${p.earnedQuote.toFixed(6)} (${pct}%)  ${p.sharePct.toFixed(4)}% of pool`);
  }
  const s = await V.summary();
  console.log(`  ── principal ${s.principalQuote.toFixed(6)}  earned ${s.earnedQuote.toFixed(6)}  (${s.yieldPct.toFixed(2)}%)`);
} else {
  console.log('CURRENT POSITIONS: none yet');
}
console.log();

// ---------------------------------------------------------------- what could be deployed
const pools = await V.deployable();
if (!pools.length) {
  console.log('NOTHING TO DEPLOY');
  console.log('  No graduated launch has a live pool. Before graduation a launch is a bonding curve,');
  console.log('  and a curve has no liquidity providers by construction — there is nothing to join.');
  process.exit(0);
}

console.log(`DEPLOYABLE POOLS: ${pools.length}`);
let planned = 0;
for (const p of pools) {
  const [m0, m1] = R.sortMints(p.mint, p.quoteMint);
  const tokenIs0 = m0 === p.mint;
  const tp = await CH.tokenProgramOf(p.quoteMint).catch(() => TOKEN_PROGRAM_ID);
  const mp = await CH.tokenProgramOf(p.mint).catch(() => TOKEN_PROGRAM_ID);

  if (!signer) {
    console.log(`  ${p.mint.slice(0, 8)}  pool ${p.pool.slice(0, 8)}  (no VAULT_KEY, cannot read balances)`);
    continue;
  }
  const quoteAta = getAssociatedTokenAddressSync(new PublicKey(p.quoteMint), signer.publicKey, false, tp);
  const tokenAta = getAssociatedTokenAddressSync(new PublicKey(p.mint), signer.publicKey, false, mp);
  const [qBal, tBal] = await Promise.all([
    getAccount(conn, quoteAta, 'confirmed', tp).then((a) => a.amount).catch(() => 0n),
    getAccount(conn, tokenAta, 'confirmed', mp).then((a) => a.amount).catch(() => 0n),
  ]);

  const have0 = tokenIs0 ? tBal : qBal;
  const have1 = tokenIs0 ? qBal : tBal;
  const d = V.sizeDeposit(p.state, have0, have1, SLIPPAGE_BPS);

  const qd = tokenIs0 ? p.state.dec1 : p.state.dec0;
  const td = tokenIs0 ? p.state.dec0 : p.state.dec1;
  console.log(`\n  ${p.mint.slice(0, 8)}  pool ${p.pool.slice(0, 8)}`);
  console.log(`    vault holds   ${ui(qBal, qd).toFixed(6)} quote · ${ui(tBal, td).toFixed(6)} token`);

  if (!d) {
    // The usual reason, and the one the operator has to resolve themselves.
    const needTokens = qBal > 0n && tBal === 0n;
    console.log(`    SKIPPED — ${needTokens
      ? 'quote only. A constant-product deposit needs both sides, and buying the token side is a market order this tool will not place.'
      : 'nothing mintable from the balances held.'}`);
    continue;
  }
  console.log(`    would mint    ${d.lp} LP`);
  console.log(`    costing       ${ui(tokenIs0 ? d.need1 : d.need0, qd).toFixed(6)} quote · ${ui(tokenIs0 ? d.need0 : d.need1, td).toFixed(6)} token`);
  console.log(`    max (slip ${SLIPPAGE_BPS}bps) ${ui(tokenIs0 ? d.max1 : d.max0, qd).toFixed(6)} quote · ${ui(tokenIs0 ? d.max0 : d.max1, td).toFixed(6)} token`);
  planned++;

  if (!EXECUTE) continue;

  // Re-read the pool immediately before signing. The plan above may be seconds old, and seconds are
  // enough for someone to move the ratio.
  const fresh = await V.poolState(p.pool, m0, m1);
  const d2 = V.sizeDeposit(fresh, have0, have1, SLIPPAGE_BPS);
  if (!d2 || d2.lp === 0n) { console.log('    ABORTED — pool moved, nothing mintable now'); continue; }

  const lpAta = getAssociatedTokenAddressSync(new PublicKey(R.lpMint(p.pool)), signer.publicKey, false, TOKEN_PROGRAM_ID);
  const ix = R.depositIx({
    owner: signer.publicKey, cpmmAuthority: R.cpmmAuthority(), poolState: p.pool,
    ownerLpToken: lpAta,
    token0Account: tokenIs0 ? tokenAta : quoteAta,
    token1Account: tokenIs0 ? quoteAta : tokenAta,
    poolVault0: R.poolVault(p.pool, m0), poolVault1: R.poolVault(p.pool, m1),
    tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    mint0: m0, mint1: m1, lpMint: R.lpMint(p.pool),
    lpAmount: d2.lp, maxAmount0: d2.max0, maxAmount1: d2.max1,
  });
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [signer], { commitment: 'confirmed' });
    V.recordDeposit({
      pool: p.pool, mint: p.mint, quoteMint: p.quoteMint, lp: d2.lp,
      quoteIn: ui(tokenIs0 ? d2.need1 : d2.need0, qd),
      tokensIn: ui(tokenIs0 ? d2.need0 : d2.need1, td),
    });
    console.log(`    ✅ deposited  ${sig.slice(0, 16)}…`);
  } catch (e) {
    console.log(`    ❌ failed — ${String(e.message).slice(0, 140)}`);
  }
}

console.log(`\n${planned} pool(s) ready to deploy into.`);
if (!EXECUTE && planned) console.log('Re-run with --execute and VAULT_KEY set to actually deposit.');
