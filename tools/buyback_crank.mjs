// The buyback crank. Buys REX with REX Chain's own income, and burns most of it.
//
//   node tools/buyback_crank.mjs                # plan only — quotes, prices, nothing signed
//   node tools/buyback_crank.mjs --execute      # swap and burn, requires BUYBACK_KEY
//
// This is what makes a launch quoted in SOL or an xStock still create buy pressure on REX. Its fees
// arrive in that asset; this converts them and destroys most of the result.
//
// Of every REX bought: 40/55 burned, 15/55 held. Elio's waterfall, derived rather than retyped.
//
// TWO THINGS IT WILL NOT DO, both deliberate.
//
// It will not run without being told to. Planning signs nothing and needs no key, so the trade can
// be read and argued with before it happens — these are market orders against a thin book, and a
// crank that fired them unattended would be making a trading decision nobody reviewed.
//
// It will never burn REX it did not just buy. The burn acts only on the amount this run acquired, in
// this run, never on a wallet balance it happened to find. A crank that destroyed "whatever REX is
// here" would one day be pointed at a treasury.
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, getAccount, createBurnInstruction,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';

const EXECUTE = process.argv.includes('--execute');
const MIN_USD = Number(process.env.BUYBACK_MIN_USD || 10);   // below this the fees eat the trade
const SLIPPAGE_BPS = Number(process.env.BUYBACK_SLIPPAGE_BPS || 300);

const B = await import('../lib/buyback.mjs');
const JUP = await import('../lib/jupiter.mjs');
const { cfg } = await import('../lib/config.mjs');

const conn = new Connection(cfg.jupRpc, 'confirmed');
const REX = B.REX_MINT();

const key = process.env.BUYBACK_KEY;
const signer = key ? Keypair.fromSecretKey(bs58.decode(key)) : null;
if (EXECUTE && !signer) {
  console.error('--execute needs BUYBACK_KEY (base58 secret of the buyback wallet).');
  process.exit(1);
}
const owner = signer?.publicKey.toBase58() || process.env.BUYBACK_WALLET;
if (!owner) {
  console.error('Set BUYBACK_WALLET to plan, or BUYBACK_KEY to execute.');
  process.exit(1);
}

const ui = (n, d) => Number(n) / 10 ** d;

console.log(`REX buyback crank — ${EXECUTE ? 'EXECUTE' : 'plan only, nothing will be signed'}`);
console.log(`buyback wallet ${owner}`);
console.log(`target         ${REX}  (REX)`);
console.log(`split          ${B.LEG.burn}/${B.LEG.total} burned, ${B.LEG.hold}/${B.LEG.total} held`
  + `  =  ${(B.burnShare() * 100).toFixed(1)}% burn / ${(B.holdShare() * 100).toFixed(1)}% hold\n`);

// ---------------------------------------------------------------- what has been done before
const prior = B.summary();
if (prior.cycles) {
  console.log(`ALL TIME: ${prior.cycles} cycles · bought ${prior.rexBought.toFixed(2)} REX · `
    + `burned ${prior.rexBurned.toFixed(2)} · held ${prior.rexHeld.toFixed(2)}\n`);
} else {
  console.log('ALL TIME: no buyback has ever run\n');
}

// ---------------------------------------------------------------- what is convertible now
const holdings = await B.convertible(conn, owner);
if (!holdings.length) {
  console.log('NOTHING TO CONVERT — the buyback wallet holds no non-REX balance.');
  console.log('Fees reach it through `distribute`, which needs the upgrade and the five wallets set.');
  process.exit(0);
}

console.log(`CONVERTIBLE BALANCES: ${holdings.length}`);
let acted = 0;
for (const h of holdings) {
  console.log(`\n  ${h.mint.slice(0, 10)}…  ${ui(h.amount, h.decimals)}  (${h.accounts.length} account${h.accounts.length === 1 ? '' : 's'})`);

  let q = null;
  try {
    q = await JUP.quote({ inputMint: h.mint, outputMint: REX, amount: String(h.amount), slippageBps: SLIPPAGE_BPS });
  } catch (e) { console.log(`    no route — ${String(e.message).slice(0, 90)}`); continue; }
  const quoteObj = q?.quote || q;
  if (!quoteObj?.outAmount) { console.log('    no route to REX'); continue; }

  const outRex = ui(quoteObj.outAmount, 6);
  const impact = Number(quoteObj.priceImpactPct || 0) * 100;
  const { burn, hold } = B.splitBought(quoteObj.outAmount);
  console.log(`    would buy     ${outRex.toFixed(4)} REX   (price impact ${impact.toFixed(2)}%)`);
  console.log(`    would burn    ${ui(burn, 6).toFixed(4)} REX  — permanently destroyed`);
  console.log(`    would hold    ${ui(hold, 6).toFixed(4)} REX  — treasury`);

  // A thin book is the normal case for this token, so an impact check is not optional.
  if (impact > 10) {
    console.log('    SKIPPED — price impact above 10%. Split this across several smaller runs.');
    continue;
  }
  acted++;
  if (!EXECUTE) continue;

  try {
    const built = await JUP.build({ quoteResponse: quoteObj, userPublicKey: owner });
    const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, 'base64'));
    tx.sign([signer]);
    const swapSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(swapSig, 'confirmed');
    console.log(`    ✅ bought     ${swapSig.slice(0, 16)}…`);

    // Burn only what THIS run acquired. Measured as the balance delta across the swap, not as the
    // wallet's REX balance — anything already sitting there belongs to the treasury, not the fire.
    const rexAta = getAssociatedTokenAddressSync(new PublicKey(REX), signer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const after = await getAccount(conn, rexAta, 'confirmed', TOKEN_2022_PROGRAM_ID).then((a) => a.amount).catch(() => 0n);
    const acquired = BigInt(quoteObj.outAmount);
    const toBurn = B.splitBought(acquired).burn;
    if (toBurn > after) {
      console.log(`    ⚠ burn skipped — balance ${after} is less than the ${toBurn} this run bought. Not burning into a shortfall.`);
      B.record({ quoteMint: h.mint, quoteSpent: ui(h.amount, h.decimals), rexBought: outRex, rexBurned: 0, rexHeld: outRex, swapSig, burnSig: null });
      continue;
    }
    const burnIx = createBurnInstruction(rexAta, new PublicKey(REX), signer.publicKey, toBurn, [], TOKEN_2022_PROGRAM_ID);
    const { Transaction } = await import('@solana/web3.js');
    const btx = new Transaction().add(burnIx);
    btx.feePayer = signer.publicKey;
    btx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    btx.sign(signer);
    const burnSig = await conn.sendRawTransaction(btx.serialize());
    await conn.confirmTransaction(burnSig, 'confirmed');
    console.log(`    🔥 burned     ${ui(toBurn, 6).toFixed(4)} REX  ${burnSig.slice(0, 16)}…`);

    B.record({
      quoteMint: h.mint, quoteSpent: ui(h.amount, h.decimals), rexBought: outRex,
      rexBurned: ui(toBurn, 6), rexHeld: outRex - ui(toBurn, 6), swapSig, burnSig,
    });
  } catch (e) {
    console.log(`    ❌ failed — ${String(e.message).slice(0, 140)}`);
  }
}

console.log(`\n${acted} balance(s) ready to convert.`);
if (!EXECUTE && acted) console.log('Re-run with --execute and BUYBACK_KEY set to actually buy and burn.');
