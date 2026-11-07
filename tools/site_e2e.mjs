// Full product proof in on-chain mode: everything goes through the SITE's own HTTP API,
// with a local keypair standing in for Phantom. Run with the site started in on-chain mode.
// Usage: BASE=http://localhost:5402 RPC_URL=... node tools/site_e2e.mjs <quoteMintBase58> <payerSecretBase58>
import { Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, mintTo, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';

const BASE = process.env.BASE || 'http://localhost:5402';
const RPC = process.env.RPC_URL || 'http://127.0.0.1:8899';
const quoteMint = new PublicKey(process.argv[2]);
const mintAuth = Keypair.fromSecretKey(bs58.decode(process.argv[3]));
const conn = new Connection(RPC, 'confirmed');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

const api = async (path, body) => {
  const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};
const signSend = async (b64, ...signers) => {
  const tx = Transaction.from(Buffer.from(b64, 'base64'));
  tx.partialSign(...signers);
  return (await api('/api/chain/send', { tx: tx.serialize().toString('base64') })).signature;
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  const dev = Keypair.generate(), buyer = Keypair.generate();
  for (const k of [dev, buyer]) { const s = await conn.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL); const bh = await conn.getLatestBlockhash(); await conn.confirmTransaction({ signature: s, ...bh }, 'confirmed'); }
  const qAta = {};
  for (const k of [dev, buyer]) { const a = await getOrCreateAssociatedTokenAccount(conn, k, quoteMint, k.publicKey); qAta[k.publicKey.toBase58()] = a.address; await mintTo(conn, mintAuth, quoteMint, a.address, mintAuth, 500_000_000_000); }

  // ---------- launch through the site, with metadata
  const built = await api('/api/chain/build/create', { wallet: dev.publicKey.toBase58(), quoteMint: quoteMint.toBase58(), raiseTarget: 40_000_000_000, vQuote0: 14_000_000_000, holderBps: 200, creatorBps: 100, vaultBps: 100, burnBps: 0, buybackBps: 0, fairOpenSecs: 45 });
  await api('/api/chain/meta', { wallet: dev.publicKey.toBase58(), mint: built.mint, name: 'Apex Raptor', symbol: 'APEX', description: 'launched through the site', image: PNG });
  await signSend(built.tx, dev);
  await sleep(11000); // let the indexer reconcile (window is 45s, so it is still open)
  let list = (await api('/api/tokens?limit=50')).tokens;
  let t = list.find((x) => x.mint === built.mint);
  ok(t && t.name === 'Apex Raptor' && t.symbol === 'APEX', 'launch appears in the discover feed with its real name');
  ok(t && t.image && t.image.startsWith('/img/'), 'its uploaded image is served by the site');
  ok(t && t.status === 'fairopen', 'it opens in Fair Open');
  ok(t && t.mcapUsd > 0, `priced in USD through the quote (mcap $${Math.round(t?.mcapUsd || 0)})`);

  // ---------- two sealed commitments
  for (const [who, amt] of [[dev, 2_000_000_000], [buyer, 4_000_000_000]]) {
    const b = await api('/api/chain/build/commit', { wallet: who.publicKey.toBase58(), mint: built.mint, amount: amt });
    await signSend(b.tx, who);
  }
  const ch = await api(`/api/chain/launch?mint=${built.mint}`);
  ok(ch.launch.fairOpenTotal === 6_000_000_000, 'both commitments escrowed on chain');

  // ---------- the server's crank rings the bell (cluster time, so poll rather than guess)
  let after = null;
  for (let i = 0; i < 40; i++) { await sleep(3000); after = await api(`/api/chain/launch?mint=${built.mint}`); if (after.launch.status !== 'fairopen') break; }
  ok(after && after.launch.status === 'live', 'server crank settled the Fair Open automatically');

  // ---------- claims at one price
  const prices = {};
  for (const [who, amt] of [[dev, 2_000_000_000], [buyer, 4_000_000_000]]) {
    const b = await api('/api/chain/build/claim-fairopen', { wallet: who.publicKey.toBase58(), mint: built.mint });
    await signSend(b.tx, who);
    const acc = await getOrCreateAssociatedTokenAccount(conn, who, new PublicKey(built.mint), who.publicKey);
    prices[who.publicKey.toBase58()] = amt / Number((await getAccount(conn, acc.address)).amount);
  }
  const pv = Object.values(prices);
  ok(near(pv[0], pv[1]), `both claimed at one uniform price (${pv[0].toExponential(6)})`);

  // ---------- trade through the site
  const buy = await api('/api/chain/build/buy', { wallet: buyer.publicKey.toBase58(), mint: built.mint, quoteIn: 3_000_000_000 });
  await signSend(buy.tx, buyer);
  await sleep(3000);
  const feed = (await api('/api/feed')).feed.filter((f) => f.mint === built.mint);
  ok(feed.length > 0, `the trade reached the site's live feed (${feed.length} rows)`);
  const cndl = (await api(`/api/tokens/${built.mint}/candles?tf=1m`)).candles;
  ok(cndl.length > 0, `candles built from chain state (${cndl.length})`);
  // holders come from the 10s reconcile that mirrors on-chain positions — poll for it
  let holders = [];
  for (let i = 0; i < 15 && holders.length < 2; i++) { await sleep(2000); holders = (await api(`/api/tokens/${built.mint}/holders`)).holders; }
  ok(holders.length >= 2, `holders read from on-chain positions (${holders.length})`);
  // NOTE: run the site with REWARD_FLOOR_USD=0 for this suite. At the raise this fixture uses, every
  // position is worth cents, so the real $20 floor would (correctly) skip all of them — the floor is
  // proven in the engine and chain suites; what is under test here is the pro-rata split itself.
  const shareSum = holders.reduce((x, hh) => x + (hh.share || 0), 0);
  ok(near(shareSum, 1, 1e-6), `holder shares are pro-rata to balance and sum to 1 (${shareSum.toFixed(6)})`);
  const biggest = [...holders].sort((a, b) => b.amount - a.amount)[0];
  ok(near(biggest.share, biggest.amount / holders.reduce((x, hh) => x + hh.amount, 0), 1e-6),
    'the biggest holder\'s share is exactly its slice of the balance — hold time weighs nothing');
  const t0 = (await api(`/api/tokens/${built.mint}`)).token;
  ok(t0.fees.holderBps === 200 && t0.fees.creatorBps === 100 && t0.fees.vaultBps === 100 && t0.fees.totalBps === 400,
    `the site reads the four buckets back off chain (${t0.fees.totalBps / 100}%)`);
  ok(t0.buckets.creatorPot > 0 && t0.buckets.vaultPot > 0 && t0.buckets.rexPot > 0, 'creator, vault and REX pots are all on the pair page');

  // ---------- rewards: crank posts the epoch, wallet claims with a proof
  // The reward epoch is a crank on a timer — poll for it rather than guessing the interval.
  let claims = [];
  for (let i = 0; i < 40 && !claims.length; i++) {
    await sleep(3000);
    claims = (await api(`/api/chain/claimable?wallet=${buyer.publicKey.toBase58()}`)).claims.filter((c) => c.mint === built.mint);
  }
  ok(claims.length > 0, `epoch posted and a claim with a merkle proof is offered (${claims.length})`);
  if (claims.length) {
    const before = Number((await getAccount(conn, qAta[buyer.publicKey.toBase58()])).amount);
    const cb = await api('/api/chain/build/claim-reward', { wallet: buyer.publicKey.toBase58(), mint: built.mint, index: claims[0].index, amount: claims[0].amount, proof: claims[0].proof });
    await signSend(cb.tx, buyer);
    const got = Number((await getAccount(conn, qAta[buyer.publicKey.toBase58()])).amount) - before;
    ok(got === claims[0].amount, `reward claimed through the site for exactly the offered amount (${got})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL', e.message || e); process.exit(1); });
