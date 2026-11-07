#!/usr/bin/env node
// Launch a coin on REX Chain from a script, with no browser.
//
// Elio, 11 Oct: "Need 2 features to be live — AI agents being able to deploy (I have a homie who
// is making his ai agent deploy 30 tokens daily)."
//
// Nothing had to be built for this: the whole flow was already reachable over HTTP. What was
// missing is that nobody could tell, because it is only ever exercised by the browser. This file
// is the reference an agent copies, and it is deliberately boring — plain fetch, one dependency
// already in the tree, every step commented with what it is for.
//
// ⛔ THE KEY NEVER LEAVES THE AGENT. The server builds unsigned transactions and the agent signs
// them locally. There is no API that launches on your behalf, and there should not be: anything
// that could launch for you could also drain you.
//
//   AGENT_KEY=<base58 secret key> node tools/agent_launch.mjs \
//     --name "Molten Cat" --symbol MOLT --quote SOL [--base https://rex.fun] [--dev-buy 0.05]
//
// Exit code 0 means the coin is live; anything else and nothing was created.
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';

const arg = (k, d = null) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = (arg('base') || process.env.REX_BASE || 'https://rex.fun').replace(/\/+$/, '');
const NAME = arg('name'), SYMBOL = arg('symbol'), QUOTE = (arg('quote') || 'SOL').toUpperCase();
const DEV_BUY = Number(arg('dev-buy') || 0);
const IMAGE = arg('image');                       // optional data: URL or https: link

if (!process.env.AGENT_KEY) die('set AGENT_KEY to the agent wallet\'s base58 secret key');
if (!NAME || !SYMBOL) die('--name and --symbol are required');

const kp = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_KEY));
const ME = kp.publicKey.toBase58();

function die(msg) { console.error('✗ ' + msg); process.exit(1); }
let TOKEN = null;
async function api(path, body) {
  const r = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* an HTML error page is not JSON */ }
  // ⛔ The server says what is wrong in words. Print THAT, not the status code — every refusal in
  // this codebase is written to be actionable, and swallowing it is how "it just fails" happens.
  if (!r.ok) die(`${path} → ${r.status}: ${j?.error || text.slice(0, 200)}`);
  return j;
}

// ---------------------------------------------------------------- 1. sign in
// Prove the wallet is yours: the server hands out a nonce, you sign the message it builds, and it
// returns a session token. Exactly what the browser does — there is no separate API key to leak.
const { nonce, message } = await api('/api/auth/nonce', { wallet: ME });
const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
const sess = await api('/api/auth/verify', { wallet: ME, nonce, signature });
TOKEN = sess.token;
console.log(`✓ signed in as ${ME}`);

// ---------------------------------------------------------------- 2. pick the pair
const state = await api('/api/state');
const quote = (state.quotes || []).find((q) => q.symbol === QUOTE);
if (!quote) die(`unknown pair ${QUOTE} — this site takes ${(state.quotes || []).map((q) => q.symbol).join(', ')}`);
// ⛔ A pair the site has BLOCKED cannot be launched against, and finding that out after signing is
// the worst moment. The launch route refuses too; this is just the earlier, cheaper refusal.
//
// ⛔ BUT "BLOCKED" IS PER VENUE, AND THIS REFUSED ON THE COLLAPSED ANSWER. `unavailable` is Meteora's
// verdict OR the cluster's, run together into one string. The five fee-bearing pairs — GP, ZCAT, SI,
// MASK, ALLINU — carry Meteora's, and Raydium's LaunchLab takes them quite happily, which is what
// the second venue is for. This tool died on all five, and sent no `venue` at all, so even past the
// refusal it would have built them against the venue that cannot price them. The browser form has
// resolved the venue per pair for weeks; this is the same rule, in the same words.
const onLaunchLab = state.launchlab?.enabled && (state.launchlab.pairs || []).includes(quote.symbol);
const venue = quote.unavailable && onLaunchLab ? 'launchlab' : 'dbc';
if (quote.unavailable && venue !== 'launchlab') die(`${QUOTE} cannot be used as a pair right now: ${quote.unavailable}`);
console.log(`✓ pairing with ${quote.symbol}${venue === 'launchlab' ? ' via Raydium LaunchLab — Meteora will not take it' : ''}`);

// ---------------------------------------------------------------- 3. build
// Amounts are in the PAIR's base units, so a dev buy is scaled by that token's decimals — not by 9,
// and not by 6. Getting this wrong is a factor of a thousand in what you spend.
const devBuy = Math.floor(DEV_BUY * 10 ** quote.decimals);
const built = await api('/api/chain/dbc/build', {
  wallet: ME, quoteMint: quote.mint, name: NAME, symbol: SYMBOL, venue,
  initialMarketCap: Number(arg('open-mcap') || 5000),       // in DOLLARS; the server converts
  migrationMarketCap: Number(arg('grad-mcap') || 50000),
  devBuy,
  refShareBps: Number(arg('share-bps') || 0),               // share & earn, 0–10000
});
console.log(`✓ built ${built.steps.length} transaction(s) for mint ${built.mint}`);

// The metadata row is saved BEFORE signing, so the token's JSON is already answering by the time
// the mint exists on chain — wallets and scanners fetch it within seconds of the first trade.
await api('/api/chain/meta', { wallet: ME, mint: built.mint, name: NAME, symbol: SYMBOL,
  description: arg('description') || '', image: IMAGE || null,
  website: arg('website') || null, twitter: arg('twitter') || null, telegram: arg('telegram') || null });

// ---------------------------------------------------------------- 4. sign and send
// ⛔ EACH STEP CARRIES ITS OWN CO-SIGNERS. The config keypair signs the first transaction and the
// mint keypair the next; signing both with both is rejected by the runtime.
for (const [i, st] of built.steps.entries()) {
  const raw = Buffer.from(st.tx, 'base64');
  let tx; try { tx = VersionedTransaction.deserialize(raw); } catch { tx = Transaction.from(raw); }
  const extra = (st.signers || []).map((sk) => Keypair.fromSecretKey(Buffer.from(sk, 'base64')));
  if (tx instanceof VersionedTransaction) tx.sign([kp, ...extra]);
  else { for (const k of extra) tx.partialSign(k); tx.partialSign(kp); }
  const ser = Buffer.from(tx.serialize()).toString('base64');
  const { signature: sig } = await api('/api/chain/send', { tx: ser });
  console.log(`✓ step ${i + 1}/${built.steps.length} sent ${sig.slice(0, 16)}…`);
}

// A hooked launch defers its opening buy until the rule is on; unhooked launches bundle it.
if (built.devBuyAfter && built.devBuyAfter !== '0') {
  console.log('… opening buy runs separately for a hooked launch; see /api/chain/build/dbc-buy');
}

// ---------------------------------------------------------------- 5. record it
// ⛔ ONLY AFTER THE POOL EXISTS. The server re-reads the pool account and checks the DBC program
// owns it, so an abandoned signature leaves no phantom coin on the board.
await api('/api/chain/dbc/confirm', {
  wallet: ME, mint: built.mint, pool: built.pool, config: built.config,
  name: NAME, symbol: SYMBOL, quote: quote.symbol, quoteMint: quote.mint,
  description: arg('description') || '', image: IMAGE || null,
  refShareBps: Number(arg('share-bps') || 0),
});
console.log(`\n$${SYMBOL} is live: ${BASE}/t/${built.mint}`);
