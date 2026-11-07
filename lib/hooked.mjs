// Hooked rules: a transfer hook on the launched coin, so the coin itself enforces a rule on every transfer (owner 10-06: "fully implement
// hooked technology as option into our launches, where people can customize every aspect of their coin").
//
// HOW IT WORKS. A Token-2022 mint names a program and Solana calls that program on EVERY transfer of the token — every buy, every sell,
// every wallet-to-wallet send — and the program can refuse. Hooked (hookedpad.com) publishes ~40 ready-made hook programs; Meteora's DBC
// launches them natively (config + pool "with transfer hook", swaps "with transfer hook"), and when the curve completes DBC revokes the hook,
// so a Graduating coin trades freely afterwards and a Permanent curve keeps its rule for life.
//
// A hooked launch is TWO transactions by the launcher: (1) the pool, on a config that names the hook program (made by the platform key, one
// per pair token × hook × curve kind); (2) "switch the rule on": the hook program's own `initialize`, which writes the rule's settings on
// chain and creates the extra-account-metas list the token program needs. Until (2) lands, every transfer of the coin fails, so the dev buy
// and all trading wait for it. Nothing here is signed by the site: both transactions are built for the launcher's wallet.
//
// WHERE THIS COMES FROM. Studied 10-06 from Hooked's docs, its launch page and its shipped front-end code (the instruction layouts live in
// the browser, since "Hooked never holds a key"). Every program below was checked executable on mainnet before being offered. Four programs
// are REMAPPED on mainnet relative to the docs (the docs list devnet ids): Max per wallet 4Gsx…, Trade guard D92g…, Chapters AFQC…,
// Anti-bundle 7zxh… — launching against the documented id would attach a program that is not the one Hooked runs (or none at all).
//
// NOT HERE, on purpose: rules that need Hooked's own servers or a third app (FOMO-only, Pump-app-only, Social trading, OpenSea-only, the
// AI-written Custom/Editable/DAO/Hooki hooks), rules whose payout plumbing is wired to Hooked's fee claimer (King of the Hill, Lock & earn),
// Pegs (an art collection upload), the linked-token pairs, and Sliding caps / Combined rules (their builders were not recoverable).
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import crypto from 'node:crypto';
import { warn } from './config.mjs';
import { meta } from './db.mjs';

// ⛔ A LAZY CONNECTION, NOT ONE TAKEN AT IMPORT. chain.mjs reads config, builds the endpoint list and
// installs the breaker/semaphore; grabbing a connection while this module is being imported binds to
// whatever exists at that instant and bypasses all of it. Called per use, every read here goes
// through the same failover and rate limiting as the rest of the site.
let _CH = null;
const chain = async () => (_CH ||= await import('./chain.mjs'));
const rpc = async () => (await chain()).conn();
export const DBC_POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM');
export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
const ZERO = PublicKey.default;
const disc = (name) => crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const eamlOf = (mint, prog) => pda([Buffer.from('extra-account-metas'), mint.toBuffer()], prog);
const u8 = (v) => Buffer.from([Number(v) & 255]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(Number(v) & 65535); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(v) >>> 0); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v))); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const pk = (k) => new PublicKey(k).toBuffer();
const num = (v, d) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : d; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** A percentage of supply, in raw token units — Hooked's own rounding (basis points of a basis point). */
const pctRaw = (pct, supplyRaw) => (supplyRaw * BigInt(Math.round(1e4 * pct))) / 1_000_000n;
const lam = (sol) => BigInt(Math.max(0, Math.round(1e9 * sol)));
const SLOTS_PER_HOUR = 9000;
const K = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

/** The common `initialize`: payer, extra-account-metas, mint, the rule's state account, (optional pool / vault PDAs), system program. */
function genericInit({ prog, mint, payer, prefix, data, poolKey = null, poolSeed = null, vaultSeed = null, noState = false }) {
  const keys = [K(payer, true, true), K(eamlOf(mint, prog), true), K(mint)];
  if (!noState) keys.push(K(pda([Buffer.from(prefix), mint.toBuffer()], prog), true));
  if (poolSeed) keys.push(K(pda([Buffer.from(poolSeed), mint.toBuffer()], prog), true));
  if (vaultSeed) keys.push(K(pda([Buffer.from(vaultSeed), mint.toBuffer()], prog), true));
  if (poolKey) keys.push(K(poolKey)); // the Meteora pool, read: the hook learns the pool and its authority from it
  keys.push(K(SystemProgram.programId));
  return new TransactionInstruction({ programId: prog, keys, data: Buffer.concat([disc('initialize'), data]) });
}

const minutesWord = (m) => (m < 90 ? `${Math.round(m)} minutes` : m < 2880 ? `${+(m / 60).toFixed(1)} hours` : `${+(m / 1440).toFixed(1)} days`);
const hoursWord = (h) => (h >= 48 ? `${+(h / 24).toFixed(1)} days` : `${+h.toFixed(1)} hours`);
const PH_DEFAULT_PERIOD = { breathing: 300, resonance: 60, coupled: 180, momentum: 120 };
const physics = (kind, p, supplyRaw) => {
  const base = pctRaw(num(p.base, 1), supplyRaw), floor = pctRaw(num(p.floor, kind === 'breathing' ? 0.1 : 0.25), supplyRaw);
  const omega2 = BigInt(Math.round((2 * Math.PI / Math.max(1, num(p.period, PH_DEFAULT_PERIOD[kind]))) ** 2 * 1e6));
  const s = (v) => BigInt(Math.round(v / 100 * 1e6));
  if (kind === 'breathing') return { omega2, k: 0n, gamma: 0n, kick: 0n, base, floor, x1: (base * BigInt(Math.round(100 * num(p.swing, 60)))) / 10000n, x2: 0n };
  const gamma = s(num(p.damping, kind === 'momentum' ? 8 : 2)), kick = s(num(p.kick, 40)); const k = kind === 'coupled' ? (omega2 * BigInt(Math.round(100 * num(p.coupling, 20)))) / 10000n : 0n;
  return { omega2, k, gamma, kick, base, floor, x1: 0n, x2: 0n };
};
const physicsIx = (kind) => ({ mint, pool, payer, params, supplyRaw }) => { const P = physics(kind, params, supplyRaw); const data = Buffer.concat([u64(P.omega2), u64(P.k), u64(P.gamma), u64(P.kick), i64(P.base), i64(P.floor), i64(P.x1), i64(P.x2)]); return [[genericInit({ prog: PROG.physics, mint, payer, prefix: 'ph', data, poolKey: pool })]]; };
const physicsParams = (periodDefault, extra) => [
  { key: 'period', label: extra.periodLabel, help: extra.periodHelp, type: 'range', min: 20, max: 1200, step: 10, default: periodDefault, unit: 'seconds' },
  ...(extra.before || []),
  { key: 'base', label: 'Base cap', help: 'the most one buy can take when the oscillator is at rest', type: 'pct', min: 0.1, max: 10, step: 0.1, default: 1, unit: '% supply' },
  { key: 'floor', label: 'Floor', help: 'the cap never drops below this', type: 'pct', min: 0.01, max: 5, step: 0.01, default: 0.25, unit: '% supply' },
];

export const PROG = {
  maxhold: new PublicKey('4GsxAQV9NeDh4J9HX4dWRfNFacxiqHKRf6RxGJoLuK8n'), timecap: new PublicKey('6AH1GVkqUdYCrbse28TcFSLyYTSiYqQVneaxvSBTSyp3'),
  antidump: new PublicKey('Ft8R4BsJp7n3dGKsd1RbAi3WrvkiH5s5z2jyDztEQJ6f'), guard: new PublicKey('D92gP881Q8q1LhvKCbUiyz5vn86DyiNZ9S2z2V9v8gAr'),
  evolve: new PublicKey('AFQCJz9Q7TXgJe86MqrCLR1LjPL2W1zmjA4NidmgbJnn'), antibundle: new PublicKey('7zxho6cRXcazb97vA9RSdWQ6dUvUHPe9koTRsn5WfmQr'),
  sellcaps: new PublicKey('9Am6KfHqhi3vYmZKpE2kRJxmbNvwggujNzqqSaqdor2Z'), feecap: new PublicKey('BPVEVJfsDvPQ4A8oRntVudUAJyaUvFuSJVk5tidKz7Fp'),
  drip: new PublicKey('3MYbfUJVKsKnyYJ2QSXdgchoeW8hc7fqMBBuc51pDHuo'), potato: new PublicKey('CapP1YJk8Rh4d17szh45zXHy8vSMbZoNXfzm6zvNTgz7'),
  depth: new PublicKey('4FYZUzNqHxLRLs8bhoQf71yRW8i2jPxJxLZJFcqB9Xom'), gatekeep: new PublicKey('3uxoNzXjn6hKxuFqi5sZjnSoFauSXjnq6i9vWPJf99Zs'),
  holdergated: new PublicKey('2WsdXUpABzpXbiPcKrDYypdgzr2EybGorWFHBDXYtSGx'), schedule: new PublicKey('BUwCiwrRfVgNKEhHryBb626oKCRqNfm5hhkebrXKG6iY'),
  hours: new PublicKey('EZet2oSoussVujse5U8W4T2NZsTuJ1rZBqQ8J188iJKk'), pingpong: new PublicKey('Bf7ecqFieSoacTNbangY4trvnU7bVig6na1RMr6G84dk'),
  physics: new PublicKey('C7Whr2PbMHGAt8J7gpvRVfmUqhW9nBk17qBbZDmdnFmk'), blocklist: new PublicKey('8zw1psRFN541E1A3uzxB3uBXjUj3dVtkLHS3Ad99dFqP'),
  airdrop: new PublicKey('3MNVGyhzq5iLN2ZAnkSnBdwqEomtdQ9vt7qS6nheauok'),
  pumpapp: new PublicKey('BXax2KXrnT7qRf7cva9cLJpqDGXWywsw4ucLwtGiTa28'), social: new PublicKey('DMohCzuYMQUsmYAiitgtYtSpsBtyEw9UWZha7EGqTv8M'),
  king: new PublicKey('63VLLdKEZVjwKN4Y6CqeeFkLGzMoSZxFAXsfiLwnKKkD'), lockin: new PublicKey('CndZxZoVjv2RC9RX7DGfQzQru9a1kfAsEfUVVM37diGF'),
};
const PUMP_APP_PROGRAM = new PublicKey('6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const dbcEventAuthority = () => pda([Buffer.from('__event_authority')], DBC_PROGRAM_ID);
/**
 * The pool's config account — the one the caller already has, or failing that read off the pool.
 *
 * ⛔ IT WAS ALWAYS READ, AND ON A LAUNCH THE POOL DOES NOT EXIST YET. King of the Hill and Lock &
 * earn are the two rules whose `initialize` names the config, and both fetched it off the pool
 * account. But `buildRuleOn` runs while the launch is being BUILT: the base mint is generated in
 * that same call, so its pool address is a PDA of a mint that is not on chain, and
 * `getAccountInfo` on it returns null every single time. Both rules therefore threw "could not
 * read the pool, so the rule cannot be switched on" for every launch ever attempted with them —
 * 2 of the 28 rules, offered on the form, dead on arrival. Julz hit it on 24 Oct and read the
 * message as a problem with the XMR pair; the pair had nothing to do with it.
 *
 * `tools/hook_rules_test.mjs` had `catch { continue }` around its build loop with `checked >= 20`
 * to pass, so two rules dropping out silently was indistinguishable from the rules that refuse on
 * purpose for a blank required address. The catch is gone now.
 *
 * ⛔ AND THE READ WAS NEVER NEEDED. `deriveDbcPoolAddress(quote, base, config)` IS the pool
 * address, and bytes 72..104 of the pool account are that same config — verified 24 Oct against
 * three live mainnet pools (F2F, GORILLION, DDOPE), where offset 72 is the only offset in the
 * 424-byte account that derives the pool back. So meteora.mjs hands its `config.publicKey`
 * straight in: not an equivalent value, the identical one, by the derivation that produced the
 * address in the first place.
 *
 * The fallback stays for a caller that genuinely has only a pool address, and it now retries —
 * the same single-429 trap that refused Fco's launch through `decimalsOf`.
 */
async function poolConfigOf(pool, known = null) {
  if (known) return new PublicKey(known);
  let last = null;
  for (let i = 0; i < 4; i++) {
    try {
      const info = await (await rpc()).getAccountInfo(new PublicKey(pool));
      if (info && info.data.length >= 104) return new PublicKey(info.data.subarray(72, 104));
    } catch (e) { last = e; }
    if (i < 3) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error(`could not read the pool ${String(pool).slice(0, 8)}…, so the rule cannot be switched on`
    + (last ? ` (${last.message})` : ' — it may not exist yet'));
}
/**
 * A foreign mint's token program and decimals, for Buyer rewards — the one rule that pays in
 * somebody else's token.
 *
 * ⛔ "THE REWARD TOKEN MINT WAS NOT FOUND ON CHAIN" WAS SAID ON ONE REFUSED READ, AND IT IS THE
 * WRONG SENTENCE. It takes a mint the launcher types in, so unlike the pool config there is
 * genuinely something to look up — but a single `getParsedAccountInfo` meant a
 * 429, or the breaker being open, told the launcher their perfectly real token does not exist. They
 * would go and check the address, find it correct, and have nowhere to go. Same trap as
 * `decimalsOf` and the pool config: one attempt where four cost nothing.
 *
 * The two answers are kept apart, because only one of them is the launcher's problem: a clean
 * response saying the account is absent or is not a mint is a definitive no, while never getting a
 * response at all is ours to say so about.
 */
async function mintInfoOf(key) {
  const mint = new PublicKey(String(key).trim());
  let answered = false, last = null;
  for (let i = 0; i < 4; i++) {
    try {
      const info = await (await rpc()).getParsedAccountInfo(mint);
      answered = true;
      const pi = info.value?.data?.parsed;
      if (pi && pi.type === 'mint') return { owner: info.value.owner, decimals: Number(pi.info.decimals) };
      if (info.value) throw new Error(`${mint.toBase58().slice(0, 8)}… is an account but not a token mint`);
    } catch (e) {
      if (/not a token mint$/.test(e.message)) throw e;   // a real answer, not a hiccup
      last = e;
    }
    if (i < 3) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error(answered
    ? `the reward token mint ${mint.toBase58().slice(0, 8)}… was not found on chain — check the address`
    : `could not reach the chain to read the reward token mint just now — try again in a moment (${last?.message || 'no answer'})`);
}
const LOCK_TEMPLATES = { earn: { label: 'Lock to earn', what: 'Holders lock for a week to three months and share the yield; longer locks earn up to twice as much.', minDays: 7, maxDays: 90, boost: 2, capPct: 0, lockerCapPct: 0 }, longterm: { label: 'Long-term boost', what: 'Vote-escrow style: lock from a week to a year, and a one-year lock earns four times a one-week lock.', minDays: 7, maxDays: 365, boost: 4, capPct: 0, lockerCapPct: 0 }, loyalty: { label: 'Loyalty tiers', what: 'Everyone can buy up to 0.5% of supply at a time; wallets with a lock can buy up to 2%, and earn the yield.', minDays: 3, maxDays: 30, boost: 1.5, capPct: 0.5, lockerCapPct: 2 }, diamond: { label: 'Diamond hands', what: 'One lock length for everyone, 30 days, and every locked token earns the same.', minDays: 30, maxDays: 30, boost: 1, capPct: 0, lockerCapPct: 0 } };
const LOCK_CAPACITIES = [250, 500, 1000, 2500];
const lockSettings = (p) => { const t = LOCK_TEMPLATES[String(p.template ?? 'earn')]; const minD = t ? t.minDays : Math.max(1, num(p.minDays, 7)), maxD = t ? t.maxDays : Math.max(minD, num(p.maxDays, 90)), boost = t ? t.boost : clamp(num(p.maxBoost, 2), 1, 10), cap = t ? t.capPct : Math.max(0, num(p.capPct, 0)), lcap = t ? t.lockerCapPct : Math.max(cap, num(p.lockerCapPct, cap)); const capacity = LOCK_CAPACITIES.includes(Number(p.capacity)) ? Number(p.capacity) : 500; return { minSecs: Math.round(86400 * minD), maxSecs: Math.round(86400 * Math.min(maxD, 1460)), maxBoostBps: Math.round(1e4 * boost), capPpm: Math.round(1e4 * cap), lockerCapPpm: cap > 0 ? Math.round(1e4 * lcap) : 0, capacity, teamEarns: String(p.teamEarns ?? 'no') === 'yes' }; };
const lockTableBytes = (cap) => 16 + (Math.floor((Math.floor(4 * cap / 3) + 3) / 4) + 1) * 384;
const secsWord = (s) => { const d = s / 86400; return d >= 365 && d % 365 === 0 ? `${d / 365} year${d === 365 ? '' : 's'}` : `${+d.toFixed(1)} day${d === 1 ? '' : 's'}`; };

/**
 * The catalogue. `build` returns an array of instruction GROUPS: each group is one transaction the launcher signs, in order (most rules
 * are one). `sol(p)` is what the rule itself takes from the launcher's wallet beyond rent (pre-funded pools); `summary(p)` is the sentence
 * shown before signing and on the coin page; `exempt` says whether the launcher's own wallet is exempt.
 */
export const RULES = [
  // ---- Fair launch
  { key: 'maxhold', family: 'Fair launch', label: 'Max per wallet', program: PROG.maxhold, blurb: 'No wallet can hold more than a set share of supply.', exempt: true,
    params: [{ key: 'maxWallet', label: 'Max per wallet', type: 'pct', min: 0.1, max: 5, step: 0.1, default: 1, unit: '% supply' }],
    summary: (p) => `After every buy or transfer the hook checks what the receiving wallet now holds; over ${num(p.maxWallet, 1)}% of supply, the transfer is refused. The pool and your wallet are exempt.`,
    build: ({ mint, payer, params }) => [[new TransactionInstruction({ programId: PROG.maxhold, keys: [K(payer, true, true), K(eamlOf(mint, PROG.maxhold), true), K(mint), K(pda([Buffer.from('config'), mint.toBuffer()], PROG.maxhold), true), K(SystemProgram.programId)], data: Buffer.concat([Buffer.from([92, 197, 174, 197, 41, 124, 19, 3]), payer.toBuffer(), u16(clamp(Math.round(100 * num(params.maxWallet, 1)), 1, 1e4))]) })]] },
  { key: 'timecap', family: 'Fair launch', label: 'Rising max per wallet', program: PROG.timecap, blurb: 'Max per wallet starts small and rises on a timer.', exempt: true,
    params: [{ key: 'capStart', label: 'Starting max per wallet', type: 'pct', min: 0.01, max: 5, step: 0.01, default: 0.1, unit: '% supply' }, { key: 'growth', label: 'How it rises', type: 'choice', default: 'step', options: [{ value: 'step', label: 'Fixed step' }, { value: 'double', label: 'Doubles' }] }, { key: 'capStep', label: 'Rises by', help: 'added to the cap every period', type: 'pct', min: 0.01, max: 5, step: 0.01, default: 0.1, unit: '% supply', showIf: { key: 'growth', value: 'step' } }, { key: 'everyMinutes', label: 'Every', help: 'how often the cap rises', type: 'range', min: 1, max: 1440, step: 1, default: 5, unit: 'minutes' }],
    summary: (p) => { const t = num(p.capStart, 0.1), a = num(p.capStep, 0.1), n = Math.max(1, num(p.everyMinutes, 5)), dbl = String(p.growth ?? 'step') === 'double'; const steps = (x) => (x <= t ? 0 : dbl ? Math.ceil(Math.log2(x / t)) : Math.ceil((x - t) / a)); return `Every wallet's max starts at ${+t.toFixed(2)}% of supply and ${dbl ? `doubles every ${minutesWord(n)}` : `rises ${+a.toFixed(2)}% every ${minutesWord(n)}`}${t < 5 ? `; it reaches 5% after ${minutesWord(steps(5) * n)}` : ''} and keeps rising until there is no cap at all, after about ${minutesWord(steps(100) * n)}. The pool and your wallet are exempt.`; },
    build: ({ mint, payer, params }) => { const n = (pct) => clamp(Math.round(1e4 * pct), 1, 1e6); const dbl = String(params.growth ?? 'step') === 'double'; const data = Buffer.concat([u32(n(num(params.capStart, 0.1))), u32(dbl ? 0 : n(num(params.capStep, 0.1))), u64(Math.max(1, Math.round(60 * num(params.everyMinutes, 5)))), u8(dbl ? 1 : 0)]); return [[genericInit({ prog: PROG.timecap, mint, payer, prefix: 'cfg', data })]]; } },
  { key: 'chapters', family: 'Fair launch', label: 'Chapters', program: PROG.evolve, blurb: 'A max per wallet that doubles every time enough volume trades.', exempt: true,
    params: [{ key: 'capPct', label: 'Starting max per wallet', type: 'pct', min: 0.1, max: 5, step: 0.1, default: 1, unit: '% supply' }, { key: 'stepTokens', label: 'Volume per chapter', help: 'the cap doubles every time this many more tokens have traded', type: 'range', min: 1_000_000, max: 100_000_000, step: 1_000_000, default: 10_000_000, unit: 'tokens traded' }],
    summary: (p) => `Every wallet's max starts at ${num(p.capPct, 1)}% of supply and doubles each time another ${Math.round(num(p.stepTokens, 1e7)).toLocaleString('en-US')} tokens have traded, until there is no cap. The pool and your wallet are exempt.`,
    build: ({ mint, payer, params, decimals }) => [[genericInit({ prog: PROG.evolve, mint, payer, prefix: 'ev', data: Buffer.concat([u8(0), u16(Math.round(100 * num(params.capPct, 1))), u64(BigInt(Math.round(num(params.stepTokens, 1e7))) * 10n ** BigInt(decimals))]) })]] },
  { key: 'guard', family: 'Fair launch', label: 'Trade guard', program: PROG.guard, blurb: 'No single trade can move more than a set share of supply.', exempt: false,
    params: [{ key: 'maxTrade', label: 'Max per trade', type: 'pct', min: 0.05, max: 10, step: 0.05, default: 0.5, unit: '% supply' }],
    summary: (p) => `No buy, sell or send can move more than ${num(p.maxTrade, 0.5)}% of supply at once; bigger trades are refused, whoever makes them. Split a large order into several trades.`,
    build: ({ mint, payer, params, supplyRaw }) => [[genericInit({ prog: PROG.guard, mint, payer, prefix: 'cfg', data: Buffer.concat([u8(1), u64(pctRaw(num(params.maxTrade, 0.5), supplyRaw)), ZERO.toBuffer()]) })]] },
  { key: 'antibundle', family: 'Fair launch', label: 'Anti-bundle', program: PROG.antibundle, blurb: 'Only a few trades per block, so bundlers cannot sweep the launch.', exempt: false,
    params: [{ key: 'maxPerSlot', label: 'Max trades per block', type: 'range', min: 1, max: 20, step: 1, default: 3, unit: 'trades' }],
    summary: (p) => `The hook counts trades in each Solana block and refuses any past ${Math.round(num(p.maxPerSlot, 3))}. A bundler packing many buys into one block gets the first few at most.`,
    build: ({ mint, payer, params }) => [[genericInit({ prog: PROG.antibundle, mint, payer, prefix: 'lim', data: u32(Math.round(num(params.maxPerSlot, 3))) })]] },
  { key: 'feecap', family: 'Fair launch', label: 'Sniper-fee cap', program: PROG.feecap, blurb: 'Buys paying sniper-sized priority fees or tips are refused at launch.', exempt: true,
    params: [{ key: 'windowMinutes', label: 'Launch window', help: 'how long the cap applies after launch; 0 = forever', type: 'range', min: 0, max: 1440, step: 1, default: 10, unit: 'minutes' }, { key: 'maxPrioritySol', label: 'Max priority fee per buy', help: 'normal buyers pay well under 0.001 SOL', type: 'range', min: 0.0001, max: 0.05, step: 0.0001, default: 0.002, unit: 'SOL' }, { key: 'maxTipSol', label: 'Max Jito tip per buy', type: 'range', min: 0, max: 0.05, step: 0.0001, default: 0.002, unit: 'SOL' }],
    summary: (p) => { const t = num(p.windowMinutes, 10); return `${t > 0 ? `For the first ${minutesWord(t)} after launch` : 'For the life of the token'}, a buy paying more than ${num(p.maxPrioritySol, 0.002)} SOL in priority fee or ${num(p.maxTipSol, 0.002)} SOL in Jito tips is refused. Sells are never blocked and your wallet is exempt.`; },
    build: ({ mint, payer, params }) => [[genericInit({ prog: PROG.feecap, mint, payer, prefix: 'cfg', data: Buffer.concat([u64(Math.max(0, Math.round(60 * num(params.windowMinutes, 10)))), u64(lam(num(params.maxPrioritySol, 0.002))), u64(lam(num(params.maxTipSol, 0.002)))]) })]] },
  // ---- Caps on selling
  { key: 'antidump', family: 'Selling', label: 'Anti-dump caps', program: PROG.antidump, blurb: 'A loose cap on buys and a tight cap on sells, enforced in the swap.', exempt: false,
    params: [{ key: 'buyCap', label: 'Max per buy', help: 'the largest amount one buy can acquire (0 = no buy cap)', type: 'pct', min: 0, max: 5, step: 0.05, default: 2, unit: '% supply' }, { key: 'sellCap', label: 'Max per sell', help: 'the largest amount one sell can offload; set it tighter than the buy cap', type: 'pct', min: 0.1, max: 2, step: 0.01, default: 0.25, unit: '% supply' }],
    summary: (p) => `${num(p.buyCap, 2) > 0 ? `One buy can take at most ${num(p.buyCap, 2)}% of supply and one` : 'Buys are uncapped; one'} sell can offload at most ${num(p.sellCap, 0.25)}% of supply. Bigger swaps are refused, nobody is exempt.`,
    build: ({ mint, payer, params, supplyRaw }) => [[genericInit({ prog: PROG.antidump, mint, payer, prefix: 'cfg', data: Buffer.concat([u64(pctRaw(num(params.buyCap, 2), supplyRaw)), u64(pctRaw(num(params.sellCap, 0.25), supplyRaw)), DBC_POOL_AUTHORITY.toBuffer()]) })]] },
  { key: 'sellcaps', family: 'Selling', label: 'Graduated sell caps', program: PROG.sellcaps, blurb: 'The bigger your bag, the less you can sell in one go.', exempt: false,
    params: [{ key: 'baseSellCap', label: 'Sell cap for small holders', help: 'the most a small holder can sell in one go', type: 'pct', min: 0.05, max: 5, step: 0.05, default: 1, unit: '% supply' }, { key: 'floorSellCap', label: 'Sell cap for the biggest bags', help: 'the least any wallet can sell in one go', type: 'pct', min: 0.01, max: 1, step: 0.01, default: 0.1, unit: '% supply' }, { key: 'tightenAt', label: 'Bag size that gets the smallest cap', help: 'a wallet holding this much or more can only sell the smallest cap at a time', type: 'pct', min: 0.5, max: 10, step: 0.5, default: 3, unit: '% supply' }],
    summary: (p) => { const t = num(p.baseSellCap, 1), a = Math.min(num(p.floorSellCap, 0.1), t), n = num(p.tightenAt, 3); return `A wallet with a tiny bag can sell up to ${t}% of supply at once; the cap shrinks with the bag, down to ${a}% per sell for anyone holding ${n}% or more.`; },
    build: ({ mint, payer, params, supplyRaw }) => { const base = pctRaw(num(params.baseSellCap, 1), supplyRaw); let floor = pctRaw(num(params.floorSellCap, 0.1), supplyRaw); if (floor > base) floor = base; return [[genericInit({ prog: PROG.sellcaps, mint, payer, prefix: 'cfg', data: Buffer.concat([u64(base), u64(floor), u64(pctRaw(num(params.tightenAt, 3), supplyRaw))]) })]]; } },
  { key: 'vesting', family: 'Selling', label: 'Holder vesting', program: PROG.drip, blurb: 'Each wallet unlocks its bag on its own clock.', exempt: false, warn: 'Buyers cannot sell what has not unlocked yet.',
    params: [{ key: 'presaleHours', label: 'Only vest early buyers', help: '0 = every wallet vests; otherwise only wallets whose first buy lands within this many hours of launch vest, later buyers are free', type: 'range', min: 0, max: 168, step: 1, default: 0, unit: 'hours' }, { key: 'cliffHours', label: 'Cliff', help: 'no tokens unlock until this long after a wallet’s first buy', type: 'range', min: 0, max: 168, step: 1, default: 24, unit: 'hours' }, { key: 'unlockPct', label: 'Unlock each period', help: 'how much of a wallet’s bag unlocks every period after the cliff', type: 'range', min: 0.1, max: 100, step: 0.1, default: 10, unit: '%' }, { key: 'unlockEveryHours', label: 'Unlock period', help: '1 = hourly, 24 = daily, 168 = weekly', type: 'range', min: 1, max: 168, step: 1, default: 24, unit: 'hours' }, { key: 'poolSol', label: 'Slot-rent pool', help: 'pre-funds the per-wallet slots created on each first buy (about 0.0014 SOL each)', type: 'range', min: 0.1, max: 10, step: 0.1, default: 0.5, unit: 'SOL' }, { key: 'minBuy', label: 'Minimum qualifying buy', help: 'a buy must be at least this big to open a slot, so dust cannot drain the pool', type: 'pct', min: 0.001, max: 1, step: 0.001, default: 0.05, unit: '% supply' }],
    sol: (p) => num(p.poolSol, 0.5),
    summary: (p) => { const a = num(p.unlockPct, 10), n = Math.max(1, Math.round(num(p.unlockEveryHours, 24))), o = num(p.cliffHours, 24), pre = num(p.presaleHours, 0); const every = n === 1 ? 'every hour' : n % 24 === 0 ? (n === 24 ? 'every day' : `every ${n / 24} days`) : `every ${n} hours`; const full = o + (Math.ceil(100 / Math.max(0.01, a)) - 1) * n; const wallets = Math.max(0, Math.floor((num(p.poolSol, 0.5) - 0.00089088) / 0.00139896)); return `${pre > 0 ? `Only wallets that first buy in the first ${pre} hours vest; later buyers are free. Early wallets` : 'Wallets'} unlock ${+a.toFixed(2)}% ${every}, starting ${o ? `${hoursWord(o)} after their first buy` : 'at their first buy'}; fully unlocked after about ${hoursWord(full)}. The ${num(p.poolSol, 0.5)} SOL slot-rent pool covers about ${wallets.toLocaleString('en-US')} wallets' first buys.`; },
    build: ({ mint, payer, params, supplyRaw, slot }) => { const pre = num(params.presaleHours, 0); const data = Buffer.concat([u8(pre > 0 ? 5 : 1), u64(pre > 0 ? BigInt(slot + Math.round(SLOTS_PER_HOUR * pre)) : 0n), u64(pctRaw(num(params.minBuy, 0.05), supplyRaw)), u64(Math.round(SLOTS_PER_HOUR * num(params.cliffHours, 24))), u64(SLOTS_PER_HOUR * Math.max(1, Math.round(num(params.unlockEveryHours, 24)))), u64(clamp(Math.round(100 * num(params.unlockPct, 10)), 1, 1e4)), DBC_POOL_AUTHORITY.toBuffer(), u64(lam(num(params.poolSol, 0.5))), ZERO.toBuffer()]); return [[genericInit({ prog: PROG.drip, mint, payer, prefix: 'cfg', data, poolSeed: 'pool' })]]; } },
  { key: 'potato', family: 'Selling', label: 'Hot potato', program: PROG.potato, blurb: 'The latest buyer cannot sell until someone buys after them.', exempt: false,
    params: [{ key: 'minPassPct', label: 'Minimum buy to pass the potato', help: 'smaller buys go through but do not pass it on', type: 'pct', min: 0, max: 1, step: 0.001, default: 0.01, unit: '% supply' }, { key: 'coldAfterMin', label: 'Potato goes cold after', help: 'if nobody buys this long, the holder can sell again; 0 = never', type: 'range', min: 0, max: 1440, step: 1, default: 0, unit: 'minutes' }],
    summary: (p) => { const t = num(p.minPassPct, 0.01), a = num(p.coldAfterMin, 0); return `The latest buyer cannot sell or send until another wallet buys at least ${t}% of supply after them. ${a > 0 ? `If nobody does for ${minutesWord(a)}, the potato goes cold and they can sell again.` : 'It never goes cold on its own.'} Nobody is exempt, you included.`; },
    build: ({ mint, pool, payer, params, supplyRaw }) => { const data = Buffer.concat([u64(pctRaw(Math.max(0, num(params.minPassPct, 0.01)), supplyRaw)), u32(Math.min(60 * Math.max(0, Math.round(num(params.coldAfterMin, 0))), 4e9))]); return [[genericInit({ prog: PROG.potato, mint, payer, prefix: 'cfg', data, poolKey: pool })]]; } },
  { key: 'pingpong', family: 'Selling', label: 'Ping Pong', program: PROG.pingpong, blurb: 'Buys and sells take turns: one buy, then one sell, forever.', exempt: false,
    params: [{ key: 'minTurnPct', label: 'Minimum to take the turn', help: 'smaller trades still go through on their own turn but do not hand it over', type: 'pct', min: 0, max: 1, step: 0.001, default: 0.01, unit: '% supply' }, { key: 'freeAfterMin', label: 'Turn frees up after', help: 'if nobody takes the turn this long, either side can go next; 0 = never', type: 'range', min: 0, max: 1440, step: 1, default: 10, unit: 'minutes' }],
    summary: (p) => { const t = num(p.minTurnPct, 0.01), a = num(p.freeAfterMin, 10); return `Strictly one buy, then one sell. A trade needs at least ${t}% of supply to hand the turn over. ${a > 0 ? `If nobody takes the turn for ${minutesWord(a)}, either side can go next.` : 'The turn never frees up on its own.'} Nobody is exempt and the first trade must be a buy.`; },
    build: ({ mint, pool, payer, params, supplyRaw }) => { const data = Buffer.concat([u64(pctRaw(Math.max(0, num(params.minTurnPct, 0.01)), supplyRaw)), u32(Math.min(60 * Math.max(0, Math.round(num(params.freeAfterMin, 10))), 4e9))]); return [[genericInit({ prog: PROG.pingpong, mint, payer, prefix: 'cfg', data, poolKey: pool })]]; } },
  // ---- Who can hold / where it trades
  { key: 'dexonly', family: 'Where it trades', label: 'DEX-only', program: PROG.depth, blurb: 'Moves only through a DEX, never wallet to wallet.', exempt: false, params: [],
    summary: () => 'Every transfer has to be a swap with a pool; sending the token from one wallet to another is refused. Buying and selling are never blocked.',
    build: ({ mint, payer }) => [[genericInit({ prog: PROG.depth, mint, payer, prefix: 'cfg', data: u8(1) })]] },
  { key: 'venuelock', family: 'Where it trades', label: 'Venue-locked', program: PROG.gatekeep, blurb: 'Trades only through its Meteora pool, never wallet to wallet.', exempt: false, params: [],
    summary: () => 'The token only moves through its own Meteora pool: buys and sells there work, anything else — a wallet-to-wallet send, another pool — is refused.',
    build: ({ mint, payer }) => [[genericInit({ prog: PROG.gatekeep, mint, payer, prefix: 'gk', data: Buffer.concat([u8(0), DBC_PROGRAM_ID.toBuffer(), u64(0), ZERO.toBuffer(), Buffer.alloc(32)]) })]] },
  { key: 'holdergated', family: 'Where it trades', label: 'Holder-gated', program: PROG.holdergated, blurb: 'Only wallets holding a token you choose can receive it.', exempt: false,
    params: [{ key: 'gateMint', label: 'Gate token mint', help: 'wallets must hold this token to receive yours', type: 'pubkey', default: '', required: true }],
    summary: (p) => `A wallet can only receive the token — by buying or by transfer — while it holds at least one unit of ${String(p.gateMint || '').slice(0, 4)}…${String(p.gateMint || '').slice(-4)}. Selling is never blocked.`,
    build: ({ mint, payer, params }) => [[genericInit({ prog: PROG.holdergated, mint, payer, prefix: 'cfg', noState: true, data: new PublicKey(String(params.gateMint).trim()).toBuffer() })]] },
  { key: 'blocklist', family: 'Where it trades', label: 'Blocklist', program: PROG.blocklist, blurb: 'Named wallets can never receive the token.', exempt: false, warn: 'You hold this list for ever; holders are trusting you with it.',
    params: [{ key: 'wallets', label: 'Blocked wallets', help: 'one address per line, up to 200', type: 'list', default: '', required: true }],
    summary: (p) => { const n = parseList(p.wallets).length; return `${n} wallet${n === 1 ? '' : 's'} can never receive the token, by buy or by transfer. The list is sealed at launch and cannot be changed.`; },
    build: ({ mint, pool, payer, params }) => { const list = parseList(params.wallets); if (!list.length) throw new Error('add at least one wallet to the blocklist'); if (list.length > 200) throw new Error('the blocklist holds up to 200 wallets'); const P = PROG.blocklist; const listPda = pda([Buffer.from('list'), mint.toBuffer()], P); const base = [K(payer, true, true), K(mint), K(listPda, true)];
      const groups = [[genericInit({ prog: P, mint, payer, prefix: 'list', data: u16(list.length), poolKey: pool })]];
      for (let i = 0; i < list.length; i += 24) { const chunk = list.slice(i, i + 24); const ixs = [new TransactionInstruction({ programId: P, keys: base, data: Buffer.concat([disc('add'), u32(chunk.length), ...chunk.map((w) => w.toBuffer())]) })]; if (i + 24 >= list.length) ixs.push(new TransactionInstruction({ programId: P, keys: base, data: disc('seal') })); groups.push(ixs); }
      return groups; } },
  // ---- When it trades
  { key: 'schedule', family: 'When it trades', label: 'Trading hours', program: PROG.schedule, blurb: 'Trades only on the days and hours you set, in any time zone.', exempt: true, warn: 'Outside the hours you set, holders may not be able to sell.',
    params: [{ key: 'hours', label: 'Open hours', type: 'hours', default: '1:540-1020;2:540-1020;3:540-1020;4:540-1020;5:540-1020' }, { key: 'tz', label: 'Time zone', type: 'tz', default: 'UTC' }, { key: 'afterHours', label: 'Outside your hours', type: 'choice', default: 'closed', options: [{ value: 'closed', label: 'Buys and sells closed' }, { value: 'sells', label: 'Sells stay open' }] }],
    summary: (p) => `Trading is open ${describeHours(parseHours(p.hours))}, ${String(p.tz || 'UTC').replace(/_/g, ' ')} time. Outside those hours ${String(p.afterHours ?? 'closed') === 'sells' ? 'buys are refused but holders can still sell' : 'both buys and sells are refused, so holders cannot exit until trading reopens'}. Wallet-to-wallet sends always work and your wallet can always buy.`,
    build: ({ mint, pool, payer, params }) => { const tz = String(params.tz || 'UTC'); const zone = zoneRule(tz); const days = parseHours(params.hours); if (!days.some((d) => d.on)) throw new Error('pick at least one trading day'); const sched = Buffer.alloc(43); sched[0] = days.reduce((a, d, i) => (d.on ? a | (1 << i) : a), 0); sched.writeInt16LE(zone.stdOff, 1); sched.writeInt16LE(zone.dstShift, 3); for (const [at, r] of [[5, zone.dstStart], [10, zone.dstEnd]]) { sched[at] = r.month; sched[at + 1] = r.fromDay; sched[at + 2] = r.weekday; sched.writeInt16LE(r.minute, at + 3); } days.forEach((d, i) => { sched.writeUInt16LE(d.open, 15 + 4 * i); sched.writeUInt16LE(d.close, 17 + 4 * i); }); const tzb = Buffer.from(tz.slice(0, 40)); const data = Buffer.concat([u8(String(params.afterHours ?? 'closed') === 'sells' ? 1 : 0), sched, u32(tzb.length), tzb]); return [[genericInit({ prog: PROG.schedule, mint, payer, prefix: 'hours', data, poolKey: pool })]]; } },
  { key: 'hours', family: 'When it trades', label: 'Market hours', program: PROG.hours, blurb: 'Trades like a stock: Monday to Friday, 9:30am to 4pm New York time.', exempt: true, warn: 'Outside market hours, holders may not be able to sell.',
    params: [{ key: 'afterHours', label: 'After hours', type: 'choice', default: 'closed', options: [{ value: 'closed', label: 'Buys and sells closed' }, { value: 'sells', label: 'Sells stay open' }] }, { key: 'holidays', label: 'Stock-market holidays', type: 'choice', default: 'observe', options: [{ value: 'observe', label: 'Closed on holidays' }, { value: 'ignore', label: 'Ignore holidays' }] }],
    summary: (p) => `Trading is open Monday to Friday, 9:30am to 4:00pm New York time${String(p.holidays ?? 'observe') === 'observe' ? ', and closed on stock-market holidays' : ''}. Outside those hours ${String(p.afterHours ?? 'closed') === 'sells' ? 'buys are refused but holders can still sell' : 'both buys and sells are refused'}. Wallet-to-wallet sends always work and your wallet can always buy.`,
    build: ({ mint, payer, params }) => [[genericInit({ prog: PROG.hours, mint, payer, prefix: 'cfg', data: Buffer.from([String(params.afterHours ?? 'closed') === 'sells' ? 1 : 0, String(params.holidays ?? 'observe') === 'observe' ? 1 : 0]) })]] },
  // ---- Who gets paid
  { key: 'dividends', family: 'Who gets paid', label: 'SOL dividends', program: PROG.drip, blurb: 'Every buy pays the buyer a SOL dividend from a pool you fund.', exempt: false,
    params: [{ key: 'dividendSol', label: 'Dividend per buy', help: 'SOL paid into each buyer’s claim slot on every buy', type: 'range', min: 0.0005, max: 0.05, step: 0.0005, default: 0.002, unit: 'SOL' }, { key: 'poolSol', label: 'Dividend pool', help: 'the SOL you pre-fund at launch; dividends stop once it runs dry', type: 'range', min: 0.1, max: 20, step: 0.1, default: 1, unit: 'SOL' }, { key: 'minBuy', label: 'Minimum qualifying buy', help: 'a buy must be at least this big to earn, so dust cannot drain the pool', type: 'pct', min: 0.001, max: 1, step: 0.001, default: 0.05, unit: '% supply' }],
    sol: (p) => num(p.poolSol, 1),
    summary: (p) => `Every buy of at least ${num(p.minBuy, 0.05)}% of supply earns the buyer ${num(p.dividendSol, 0.002)} SOL, claimable on Hooked, out of the ${num(p.poolSol, 1)} SOL pool you fund at launch — about ${Math.floor(num(p.poolSol, 1) / Math.max(0.0005, num(p.dividendSol, 0.002))).toLocaleString('en-US')} buys.`,
    build: ({ mint, payer, params, supplyRaw }) => [[genericInit({ prog: PROG.drip, mint, payer, prefix: 'cfg', poolSeed: 'pool', data: Buffer.concat([u8(0), u64(lam(num(params.dividendSol, 0.002))), u64(pctRaw(num(params.minBuy, 0.05), supplyRaw)), u64(0), u64(1), u64(0), DBC_POOL_AUTHORITY.toBuffer(), u64(lam(num(params.poolSol, 1))), ZERO.toBuffer()]) })]] },
  { key: 'tithe', family: 'Who gets paid', label: 'Tithe', program: PROG.gatekeep, blurb: 'Every trade donates SOL to a cause you choose.', exempt: false,
    params: [{ key: 'charity', label: 'Recipient address', help: 'the wallet every trade donates to (a charity or a treasury)', type: 'pubkey', default: '', required: true }, { key: 'donationSol', label: 'Donation per trade', type: 'range', min: 0.0005, max: 0.5, step: 0.0005, default: 0.005, unit: 'SOL' }],
    summary: (p) => `Every buy and every sell sends ${num(p.donationSol, 0.005)} SOL from the trader to ${String(p.charity || '').slice(0, 4)}…${String(p.charity || '').slice(-4)}; a trade that cannot pay it is refused.`,
    build: ({ mint, payer, params }) => [[genericInit({ prog: PROG.gatekeep, mint, payer, prefix: 'gk', data: Buffer.concat([u8(1), ZERO.toBuffer(), u64(lam(num(params.donationSol, 0.005))), new PublicKey(String(params.charity).trim()).toBuffer(), Buffer.alloc(32)]) })]] },
  { key: 'airdrop', family: 'Who gets paid', label: 'Buyer rewards', program: PROG.airdrop, blurb: 'Every buy earns the buyer a token you choose, from a vault you fill.', exempt: false,
    params: [{ key: 'rewardMint', label: 'Reward token mint', help: 'the existing token buyers are rewarded with', type: 'pubkey', default: '', required: true }, { key: 'perBuy', label: 'Reward per buy', help: 'how many reward tokens each qualifying buy earns', type: 'range', min: 0.01, max: 1_000_000, step: 0.01, default: 100, unit: 'reward tokens' }, { key: 'fund', label: 'Vault funding', help: 'how many reward tokens move from your wallet into the vault at launch', type: 'range', min: 1, max: 1_000_000_000, step: 1, default: 10_000, unit: 'reward tokens' }, { key: 'minBuy', label: 'Minimum buy to earn', help: 'smaller buys earn nothing, so dust cannot drain the vault', type: 'pct', min: 0.001, max: 1, step: 0.001, default: 0.05, unit: '% supply' }, { key: 'poolSol', label: 'Reward-record rent pool', help: 'pays the one-time rent for each new buyer’s reward record (about 0.0011 SOL each); unused SOL can be withdrawn', type: 'range', min: 0.01, max: 5, step: 0.01, default: 0.05, unit: 'SOL' }],
    sol: (p) => num(p.poolSol, 0.05),
    summary: (p) => `Every buy of at least ${num(p.minBuy, 0.05)}% of supply earns the buyer ${num(p.perBuy, 100).toLocaleString('en-US')} reward tokens, claimable on Hooked, from a vault you fill with ${num(p.fund, 1e4).toLocaleString('en-US')} at launch. The ${num(p.poolSol, 0.05)} SOL rent pool covers about ${Math.floor(num(p.poolSol, 0.05) / 0.0011).toLocaleString('en-US')} first-time buyers.`,
    build: async ({ mint, payer, params, supplyRaw }) => { const P = PROG.airdrop; const rewardMint = new PublicKey(String(params.rewardMint).trim()); const { owner: tokenProg, decimals: dec } = await mintInfoOf(params.rewardMint);
      const cfg = pda([Buffer.from('cfg'), mint.toBuffer()], P), poolPda = pda([Buffer.from('pool'), mint.toBuffer()], P), vaultAuth = pda([Buffer.from('vault'), mint.toBuffer()], P); const vaultAta = getAssociatedTokenAddressSync(rewardMint, vaultAuth, true, tokenProg); const perBuyRaw = BigInt(Math.round(num(params.perBuy, 100) * 10 ** dec)), fundRaw = BigInt(Math.round(num(params.fund, 1e4) * 10 ** dec));
      const ixs = [createAssociatedTokenAccountIdempotentInstruction(payer, vaultAta, vaultAuth, rewardMint, tokenProg), new TransactionInstruction({ programId: P, keys: [K(payer, true, true), K(eamlOf(mint, P), true), K(mint), K(cfg, true), K(poolPda, true), K(vaultAuth), K(rewardMint), K(vaultAta), K(SystemProgram.programId)], data: Buffer.concat([disc('initialize'), u8(0), u64(perBuyRaw), u64(pctRaw(num(params.minBuy, 0.05), supplyRaw)), DBC_POOL_AUTHORITY.toBuffer(), u64(lam(num(params.poolSol, 0.05)))]) })];
      if (fundRaw > 0n) ixs.push(createTransferCheckedInstruction(getAssociatedTokenAddressSync(rewardMint, payer, false, tokenProg), rewardMint, vaultAta, payer, fundRaw, dec, [], tokenProg));
      return [ixs]; } },
  // ---- Who gets paid, continued: games with their own treasury
  { key: 'king', family: 'Who gets paid', label: 'King of the Hill', program: PROG.king, blurb: 'The biggest buy takes the crown and earns from every trade.', exempt: false, warn: 'The King is paid out of the launcher’s share of the pool fee: as launcher you give that share up to the crown.',
    params: [{ key: 'minBuySol', label: 'Smallest buy that can take the crown', type: 'range', min: 0.01, max: 10, step: 0.01, default: 0.1, unit: 'SOL' }, { key: 'stepPct', label: 'A challenger must beat the King by', type: 'range', min: 0, max: 50, step: 1, default: 5, unit: '%' }, { key: 'halfLifeUnit', label: 'The bar to beat halves every', type: 'choice', default: 'hour', options: [{ value: 'minute', label: 'Minutes' }, { value: 'hour', label: 'Hours' }, { value: 'day', label: 'Days' }, { value: 'never', label: 'Never (it only rises)' }] }, { key: 'halfLifeEvery', label: 'How many', type: 'range', min: 1, max: 60, step: 1, default: 6, unit: '' }, { key: 'creatorCanRule', label: 'Can your own wallet be King?', type: 'choice', default: 'no', options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] }],
    summary: (p) => { const never = String(p.halfLifeUnit ?? 'hour') === 'never', a = Math.round(num(p.halfLifeEvery, 6)), u = String(p.halfLifeUnit ?? 'hour'); return `The first buy of ${num(p.minBuySol, 0.1)} SOL or more takes the crown. After that a wallet has to beat the King's winning buy by ${num(p.stepPct, 5)}% in a single buy. ${never ? 'The bar never comes down, so each takeover has to be bigger than the last.' : `The bar halves every ${a} ${u}${a === 1 ? '' : 's'}, down to ${num(p.minBuySol, 0.1)} SOL.`} The King is paid the launcher's fee share of every trade in SOL and loses the crown by selling or sending any tokens. ${String(p.creatorCanRule ?? 'no') === 'yes' ? 'Your own wallet can be King too.' : 'Your own wallet cannot be King.'}`; },
    build: async ({ mint, pool, payer, params, poolConfig: knownConfig }) => { const P = PROG.king; const poolConfig = await poolConfigOf(pool, knownConfig); const u = String(params.halfLifeUnit ?? 'hour'); const every = Math.max(1, Math.round(num(params.halfLifeEvery, 6))); const halfLife = u === 'never' ? 0 : every * (u === 'minute' ? 60 : u === 'day' ? 86400 : 3600);
      const data = Buffer.alloc(15); data.writeBigUInt64LE(lam(Math.max(0.001, num(params.minBuySol, 0.1))), 0); data.writeUInt32LE(Math.round(halfLife), 8); data.writeUInt16LE(Math.round(100 * clamp(num(params.stepPct, 5), 0, 100)), 12); data[14] = String(params.creatorCanRule ?? 'no') === 'yes' ? 1 : 0;
      const kingState = pda([Buffer.from('king'), mint.toBuffer()], P), throne = pda([Buffer.from('throne'), mint.toBuffer()], P); const throneAta = getAssociatedTokenAddressSync(mint, throne, true, TOKEN_2022_PROGRAM_ID);
      return [[new TransactionInstruction({ programId: P, keys: [K(payer, true, true), K(eamlOf(mint, P), true), K(mint), K(kingState, true), K(pool, true), K(poolConfig), K(throne, true), K(throneAta, true), K(TOKEN_2022_PROGRAM_ID), K(ATA_PROGRAM), K(DBC_PROGRAM_ID), K(dbcEventAuthority()), K(SystemProgram.programId)], data: Buffer.concat([disc('initialize'), data]) })]]; } },
  { key: 'lockin', family: 'Who gets paid', label: 'Lock & earn', program: PROG.lockin, blurb: 'Holders lock tokens in their own wallet and earn SOL from every trade.', exempt: false, warn: 'Locked wallets are paid out of the launcher’s share of the pool fee; the lock table is rent you pay at launch.',
    params: [{ key: 'template', label: 'Setup', type: 'choice', default: 'earn', options: [{ value: 'earn', label: 'Lock to earn' }, { value: 'longterm', label: 'Long-term boost' }, { value: 'loyalty', label: 'Loyalty tiers' }, { value: 'diamond', label: 'Diamond hands' }, { value: 'custom', label: 'Custom' }] }, { key: 'minDays', label: 'Shortest lock', type: 'range', min: 1, max: 365, step: 1, default: 7, unit: 'days', showIf: { key: 'template', value: 'custom' } }, { key: 'maxDays', label: 'Longest lock', type: 'range', min: 1, max: 1460, step: 1, default: 90, unit: 'days', showIf: { key: 'template', value: 'custom' } }, { key: 'maxBoost', label: 'The longest lock earns', help: 'times what the shortest lock earns on the same tokens (1 = every lock earns the same)', type: 'range', min: 1, max: 10, step: 0.5, default: 2, unit: 'x', showIf: { key: 'template', value: 'custom' } }, { key: 'capPct', label: 'Most one buy can take', help: '0 = no limit', type: 'range', min: 0, max: 5, step: 0.1, default: 0, unit: '% supply', showIf: { key: 'template', value: 'custom' } }, { key: 'lockerCapPct', label: 'Most one buy can take, for a wallet with a lock', help: 'only used when the limit above is on', type: 'range', min: 0, max: 10, step: 0.1, default: 2, unit: '% supply', showIf: { key: 'template', value: 'custom' } }, { key: 'capacity', label: 'Wallets that can be locked at once', help: 'more wallets is more rent for the lock table', type: 'choice', default: '500', options: [{ value: '250', label: '250' }, { value: '500', label: '500' }, { value: '1000', label: '1,000' }, { value: '2500', label: '2,500' }] }, { key: 'teamEarns', label: 'Does your own lock earn?', type: 'choice', default: 'no', options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] }],
    sol: (p) => +((lockTableBytes(lockSettings(p).capacity) + 1024) * 0.00000696).toFixed(3),
    summary: (p) => { const t = lockSettings(p); const tpl = LOCK_TEMPLATES[String(p.template ?? 'earn')]; const span = t.minSecs === t.maxSecs ? `for ${secsWord(t.minSecs)}` : `for ${secsWord(t.minSecs)} to ${secsWord(t.maxSecs)}`; return `${tpl ? tpl.what : 'Your own setup.'} Holders lock tokens ${span} without them leaving their wallet and share the launcher's fee share of every trade in SOL.${t.maxBoostBps > 1e4 && t.maxSecs > t.minSecs ? ` The longest lock earns ${+(t.maxBoostBps / 1e4).toFixed(2)}x what the shortest does.` : ''}${t.capPpm ? ` One buy can take at most ${+(t.capPpm / 1e4).toFixed(2)}% of supply${t.lockerCapPpm > t.capPpm ? `, or ${+(t.lockerCapPpm / 1e4).toFixed(2)}% for a wallet with a lock` : ''}.` : ''} Up to ${t.capacity.toLocaleString('en-US')} wallets can be locked at once.`; },
    build: async ({ mint, pool, payer, params, poolConfig: knownConfig }) => { const P = PROG.lockin; const poolConfig = await poolConfigOf(pool, knownConfig); const t = lockSettings(params); const data = Buffer.alloc(25); data.writeUInt32LE(t.minSecs, 0); data.writeUInt32LE(t.maxSecs, 4); data.writeUInt32LE(t.maxBoostBps, 8); data.writeUInt32LE(t.capPpm, 12); data.writeUInt32LE(t.lockerCapPpm, 16); data.writeUInt32LE(t.capacity, 20); data[24] = t.teamEarns ? 1 : 0;
      const cfgPda = pda([Buffer.from('lock'), mint.toBuffer()], P), table = pda([Buffer.from('locks'), mint.toBuffer()], P), vault = pda([Buffer.from('vault'), mint.toBuffer()], P); const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, TOKEN_2022_PROGRAM_ID);
      const init = new TransactionInstruction({ programId: P, keys: [K(payer, true, true), K(eamlOf(mint, P), true), K(mint), K(cfgPda, true), K(table, true), K(pool, true), K(poolConfig), K(vault, true), K(vaultAta, true), K(TOKEN_2022_PROGRAM_ID), K(ATA_PROGRAM), K(DBC_PROGRAM_ID), K(dbcEventAuthority()), K(SystemProgram.programId)], data: Buffer.concat([disc('initialize'), data]) });
      const grow = () => new TransactionInstruction({ programId: P, keys: [K(payer, true, true), K(mint), K(cfgPda), K(table, true), K(SystemProgram.programId)], data: disc('grow_table') });
      const need = lockTableBytes(t.capacity); let have = Math.min(need, 10240); const groups = [[init]]; let cur = []; while (have < need) { cur.push(grow()); have = Math.min(need, have + 10240); if (cur.length === 8) { groups.push(cur); cur = []; } } if (cur.length) groups.push(cur); /* the table grows 10 KB per instruction, eight per transaction, until it holds every lock */
      return groups; } },
  // ---- Where it trades, continued: app gates (the hook checks the swap's router)
  { key: 'pumpapp', family: 'Where it trades', label: 'Pump App only', program: PROG.pumpapp, blurb: 'It can only be bought in the Pump app.', exempt: true, warn: 'Buys anywhere else, including on this site, are refused for everyone but your wallet. Sells are never blocked.', params: [],
    summary: () => 'Every buy from the pool has to be made in the Pump app (its swaps carry a router tag the hook checks). Buying here, on jup.ag, in FOMO or through trading terminals is refused. Sells and wallet-to-wallet sends are never blocked, and your wallet can buy anywhere.',
    build: ({ mint, payer }) => [[genericInit({ prog: PROG.pumpapp, mint, payer, prefix: 'cfg', data: Buffer.concat([PUMP_APP_PROGRAM.toBuffer(), payer.toBuffer()]) })]] },
  { key: 'social', family: 'Where it trades', label: 'Social trading', program: PROG.social, blurb: 'It only trades in FOMO or the Pump app: buys and sells.', exempt: true, warn: 'Buys AND sells anywhere else, including on this site, are refused for everyone but your wallet.', params: [],
    summary: () => 'Every trade with the pool, buying and selling, has to be made in FOMO or the Pump app; trades from anywhere else are refused both ways. Wallet-to-wallet sends always work, and your wallet can trade anywhere.',
    build: ({ mint, pool, payer }) => [[genericInit({ prog: PROG.social, mint, payer, prefix: 'cfg', data: Buffer.concat([payer.toBuffer(), ZERO.toBuffer(), ZERO.toBuffer(), ZERO.toBuffer()]), poolKey: pool })]] },
  // ---- Physics
  { key: 'breathing', family: 'Physics', label: 'Breathing cap', program: PROG.physics, blurb: 'The buy cap rises and falls on the clock, forever.', exempt: true,
    params: [{ key: 'period', label: 'Cycle length', help: 'one full breath, open to tight and back', type: 'range', min: 30, max: 3600, step: 10, default: 300, unit: 'seconds' }, { key: 'base', label: 'Base cap', help: 'the cap halfway through a breath', type: 'pct', min: 0.1, max: 10, step: 0.1, default: 1, unit: '% supply' }, { key: 'swing', label: 'Swing', help: 'how far above and below the base it breathes', type: 'range', min: 10, max: 100, step: 5, default: 60, unit: '% of the base' }, { key: 'floor', label: 'Floor', help: 'the cap never drops below this', type: 'pct', min: 0.01, max: 5, step: 0.01, default: 0.1, unit: '% supply' }],
    summary: (p) => { const t = num(p.base, 1), a = num(p.swing, 60) / 100, n = num(p.period, 300); return `The most one buy can take swings between ${Math.max(num(p.floor, 0.1), +(t * (1 - a)).toFixed(3))}% and ${+(t * (1 + a)).toFixed(3)}% of supply, one full breath every ${n >= 120 ? `${+(n / 60).toFixed(1)} minutes` : `${n} seconds`}. Sells and sends are never capped and your wallet is exempt.`; },
    build: physicsIx('breathing') },
  { key: 'momentum', family: 'Physics', label: 'Momentum', program: PROG.physics, blurb: 'Buying revs the cap up; a quiet market lets it ring down.', exempt: true,
    params: physicsParams(120, { periodLabel: 'Natural period', periodHelp: 'one full swing', before: [{ key: 'damping', label: 'Damping', help: 'how fast it settles when trading stops', type: 'range', min: 1, max: 40, step: 1, default: 8, unit: '% per second' }, { key: 'kick', label: 'Buy energy', help: 'how hard each buy kicks it', type: 'range', min: 5, max: 100, step: 5, default: 40, unit: '%' }] }),
    summary: (p) => `At rest one buy can take ${num(p.base, 1)}% of supply. Every buy kicks the oscillator, so a run of buying opens room for bigger buys; then it swings back, never below ${num(p.floor, 0.25)}%, and settles when trading goes quiet. Sells and sends are never capped and your wallet is exempt.`,
    build: physicsIx('momentum') },
  { key: 'resonance', family: 'Physics', label: 'Resonance', program: PROG.physics, blurb: 'Buy in rhythm and the cap swings wide open.', exempt: true,
    params: physicsParams(60, { periodLabel: 'The beat', periodHelp: 'buy once every this long to resonate', before: [{ key: 'damping', label: 'Damping', help: 'low keeps the energy ringing between beats', type: 'range', min: 1, max: 20, step: 1, default: 2, unit: '% per second' }, { key: 'kick', label: 'Buy energy', help: 'how hard each buy kicks it', type: 'range', min: 5, max: 100, step: 5, default: 40, unit: '%' }] }),
    summary: (p) => { const t = num(p.period, 60); return `Buys landing once every ${t >= 120 ? `${+(t / 60).toFixed(1)} minutes` : `${t} seconds`} build on each other and swing the cap wide open; scattered buys mostly cancel out. At rest one buy can take ${num(p.base, 1)}% of supply, never less than ${num(p.floor, 0.25)}%. Sells and sends are never capped and your wallet is exempt.`; },
    build: physicsIx('resonance') },
  { key: 'coupled', family: 'Physics', label: 'Coupled resonator', program: PROG.physics, blurb: 'Two oscillators inside one token, trading energy in beats.', exempt: true,
    params: physicsParams(180, { periodLabel: 'Natural period', periodHelp: 'one swing of each oscillator', before: [{ key: 'coupling', label: 'Coupling', help: 'stronger coupling trades energy faster', type: 'range', min: 1, max: 60, step: 1, default: 20, unit: '%' }, { key: 'damping', label: 'Damping', help: 'how fast it settles when trading stops', type: 'range', min: 0, max: 20, step: 1, default: 2, unit: '% per second' }, { key: 'kick', label: 'Buy energy', help: 'how hard each buy kicks the first oscillator', type: 'range', min: 5, max: 100, step: 5, default: 40, unit: '%' }] }),
    summary: (p) => `At rest one buy can take ${num(p.base, 1)}% of supply. Buys kick the first oscillator and the cap swings with it, while the coupling (${num(p.coupling, 20)}%) passes the energy to the second and back, so the cap swells and fades in beats, never below ${num(p.floor, 0.25)}%. Sells and sends are never capped and your wallet is exempt.`,
    build: physicsIx('coupled') },
];
export const ruleByKey = (k) => RULES.find((r) => r.key === k) || null;
export const ruleByProgram = (p) => RULES.filter((r) => r.program.toBase58() === String(p));

// ---- parameter hygiene: everything the browser sends is clamped to the schema before it is written on chain or shown back
export function cleanParams(rule, raw = {}) {
  const out = {};
  for (const p of rule.params) {
    const v = raw?.[p.key];
    if (p.type === 'pct' || p.type === 'range') { const n = num(v, p.default); out[p.key] = clamp(Math.round(n / p.step) * p.step, p.min, p.max); out[p.key] = +out[p.key].toFixed(6); }
    else if (p.type === 'choice') out[p.key] = p.options.some((o) => o.value === String(v)) ? String(v) : p.default;
    else if (p.type === 'pubkey') { const s = String(v ?? '').trim(); if (s) { try { new PublicKey(s); } catch { throw new Error(`${p.label}: that is not a Solana address`); } } else if (p.required) throw new Error(`${p.label} is required`); out[p.key] = s; }
    else if (p.type === 'list') { const s = String(v ?? ''); const list = parseList(s); if (p.required && !list.length) throw new Error(`${p.label}: add at least one wallet`); out[p.key] = list.map((k) => k.toBase58()).join('\n'); }
    else if (p.type === 'hours') { const d = parseHours(String(v ?? p.default)); if (!d.some((x) => x.on)) throw new Error('pick at least one trading day'); out[p.key] = formatHours(d); }
    else if (p.type === 'tz') { const s = String(v || 'UTC'); try { new Intl.DateTimeFormat('en-US', { timeZone: s }); } catch { throw new Error('unknown time zone'); } out[p.key] = s; }
  }
  return out;
}
export function parseList(s) { const out = []; const seen = new Set(); for (const w of String(s ?? '').split(/[\s,;]+/).filter(Boolean)) { try { const k = new PublicKey(w); if (!seen.has(k.toBase58())) { seen.add(k.toBase58()); out.push(k); } } catch { throw new Error(`"${w.slice(0, 12)}…" is not a Solana address`); } } return out; }

// ---- Trading hours: a weekly timetable in minutes, and the time zone's offset/DST rule derived the way Hooked derives it (by probing Intl
// for the zone's offset changes over the coming year and fitting month/weekday rules to them), so the hook can compute local time on chain.
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function parseHours(s) { const t = Array.from({ length: 7 }, () => ({ on: false, open: 540, close: 1020 })); for (const part of String(s ?? '').split(';')) { const m = /^([0-6]):(\d{1,4})-(\d{1,4})$/.exec(part.trim()); if (m) t[Number(m[1])] = { on: true, open: Math.min(1439, Number(m[2])), close: Math.min(1440, Number(m[3])) }; } return t; }
export const formatHours = (days) => days.map((d, i) => (d.on ? `${i}:${d.open}-${d.close}` : '')).filter(Boolean).join(';');
const clock = (m) => { const h = Math.floor(m / 60) % 24, n = m % 60; return `${h % 12 === 0 ? 12 : h % 12}${n ? `:${String(n).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`; };
export function describeHours(days) { const runs = []; days.forEach((d, i) => { if (!d.on) return; const text = d.open === d.close ? 'all day' : `${clock(d.open)}–${d.close === 1440 ? 'midnight' : clock(d.close)}${d.close < d.open ? ' (next day)' : ''}`; const last = runs[runs.length - 1]; if (last && last.to === i - 1 && last.text === text) last.to = i; else runs.push({ from: i, to: i, text }); }); return runs.length ? runs.map((r) => `${r.from === r.to ? DAY_NAMES[r.from] : `${DAY_NAMES[r.from]} to ${DAY_NAMES[r.to]}`} ${r.text}`).join(', ') : 'never'; }
const fdiv = (a, b) => Math.floor(a / b), fmod = (a, b) => ((a % b) + b) % b;
function daysFromCivil(y, m, d) { if (m <= 2) y -= 1; const era = fdiv(y, 400), yoe = y - 400 * era, doy = fdiv(153 * (m > 2 ? m - 3 : m + 9) + 2, 5) + d - 1; return 146097 * era + 365 * yoe + fdiv(yoe, 4) - fdiv(yoe, 100) + doy - 719468; }
function civilFromDays(z) { z += 719468; const era = fdiv(z, 146097), doe = z - 146097 * era, yoe = fdiv(doe - fdiv(doe, 1460) + fdiv(doe, 36524) - fdiv(doe, 146096), 365), doy = doe - (365 * yoe + fdiv(yoe, 4) - fdiv(yoe, 100)), mp = fdiv(5 * doy + 2, 153), d = doy - fdiv(153 * mp + 2, 5) + 1, m = mp < 10 ? mp + 3 : mp - 9; return [yoe + 400 * era + +(m <= 2), m, d]; }
export const weekdayOf = (days) => fmod(days + 4, 7);
function ruleDay(rule, year) { if (rule.fromDay === 0) { const n = daysFromCivil(rule.month === 12 ? year + 1 : year, rule.month === 12 ? 1 : rule.month + 1, 1) - 1; return n - fmod(weekdayOf(n) - rule.weekday, 7); } const n = daysFromCivil(year, rule.month, rule.fromDay); return n + fmod(rule.weekday - weekdayOf(n), 7); }
function offsetAt(zone, t) { const base = 60 * zone.stdOff; if (!zone.dstShift) return base; const shift = 60 * zone.dstShift, local = t + base, year = civilFromDays(fdiv(local, 86400))[0]; const s = 86400 * ruleDay(zone.dstStart, year) + 60 * zone.dstStart.minute, e = 86400 * ruleDay(zone.dstEnd, year) + 60 * zone.dstEnd.minute - shift; return base + ((s < e ? local >= s && local < e : local >= s || local < e) ? shift : 0); }
const fmtCache = new Map();
function intlOffsetMin(tz, t) { let f = fmtCache.get(tz); if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }); fmtCache.set(tz, f); } const name = f.formatToParts(new Date(1000 * t)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'; const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name); return m ? (m[1] === '-' ? -1 : 1) * (60 * Number(m[2]) + Number(m[3] ?? 0)) : 0; }
const NO_RULE = { month: 0, fromDay: 0, weekday: 0, minute: 0 };
/** The zone's standard offset (minutes), DST shift and the month/weekday rules its transitions follow this year — fitted, never assumed. */
export function zoneRule(tz, now = Math.floor(Date.now() / 1000)) {
  const year = civilFromDays(fdiv(now, 86400))[0], from = 86400 * daysFromCivil(year, 1, 1), to = 86400 * daysFromCivil(year + 6, 1, 1);
  const flat = (off, exact) => ({ stdOff: off, dstShift: 0, dstStart: NO_RULE, dstEnd: NO_RULE, exact });
  const trans = []; let cur = intlOffsetMin(tz, from);
  for (let i = from + 21600; i <= to; i += 21600) { const o = intlOffsetMin(tz, i); if (o === cur) continue; let lo = i - 21600, hi = i; while (hi - lo > 60) { const mid = lo + 60 * fdiv((hi - lo) / 60, 2); if (intlOffsetMin(tz, mid) === cur) lo = mid; else hi = mid; } trans.push({ at: hi, before: cur, after: o }); cur = o; }
  if (!trans.length) return flat(intlOffsetMin(tz, now), true);
  const offs = [...new Set(trans.flatMap((x) => [x.before, x.after]))]; if (offs.length !== 2) return flat(intlOffsetMin(tz, now), false);
  const std = Math.min(...offs), shift = Math.max(...offs) - std; const thisYear = trans.filter((x) => civilFromDays(fdiv(x.at + 60 * std, 86400))[0] === year); const up = thisYear.find((x) => x.after > x.before), down = thisYear.find((x) => x.after < x.before); if (!up || !down) return flat(intlOffsetMin(tz, now), false);
  const candidates = (t) => { const out = []; for (const dn of [0, -1, 1]) { const dayN = fdiv(t, 86400) + dn, [y, m, d] = civilFromDays(dayN), dim = daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - daysFromCivil(y, m, 1); const base = { month: m, weekday: weekdayOf(dayN), minute: fdiv(fmod(t, 86400), 60) - 1440 * dn }; for (const fromDay of new Set([7 * (Math.ceil(d / 7) - 1) + 1, ...(d + 7 > dim ? [0] : []), ...Array.from({ length: 7 }, (_, i) => d - i).filter((x) => x >= 1)])) out.push({ ...base, fromDay }); } return out; };
  const probes = Array.from({ length: 438 }, (_, i) => from + 5 * i * 86400 + (i % 24) * 3600).map((t) => [t, 60 * intlOffsetMin(tz, t)]);
  for (const s of candidates(up.at + 60 * std)) for (const e of candidates(down.at + (std + shift) * 60)) { const z = { stdOff: std, dstShift: shift, dstStart: s, dstEnd: e }; if (trans.every((x) => offsetAt(z, x.at - 60) === 60 * x.before && offsetAt(z, x.at) === 60 * x.after) && probes.every(([t, o]) => offsetAt(z, t) === o)) return { ...z, exact: true }; }
  return flat(intlOffsetMin(tz, now), false);
}

// ---- the chain: a hook is offered only while its program is an executable BPF program on this cluster (Hooked's docs list ids that are not)
const BPF_LOADERS = new Set(['BPFLoaderUpgradeab1e11111111111111111111111', 'BPFLoader2111111111111111111111111111111111', 'BPFLoader1111111111111111111111111111111111']);
export async function verifyHook(programId) {
  let key; try { key = new PublicKey(String(programId)); } catch { return { ok: false, reason: 'not a valid Solana address' }; }
  let info; try { info = await (await rpc()).getAccountInfo(key); } catch (e) { return { ok: false, unknown: true, reason: `the chain could not be reached (${e.message})` }; }
  if (!info) return { ok: false, reason: 'no account exists at that address on this cluster' };
  if (!info.executable) return { ok: false, reason: 'that address holds data, not a program' };
  if (!BPF_LOADERS.has(info.owner.toBase58())) return { ok: false, reason: 'not a BPF program' };
  // ⛔ `executable` IS A FLAG, NOT CODE. An upgradeable program is TWO accounts: the one at this
  // address, which is a 36-byte pointer and is marked executable, and the programdata account that
  // actually holds the bytes. Close or never fill the second and the first still looks perfect —
  // which is how a hook program with nothing behind it passed every check here on 7 Oct and was
  // reported as verified. Follow the pointer.
  if (info.owner.toBase58() === 'BPFLoaderUpgradeab1e11111111111111111111111') {
    let data;
    try { data = await (await rpc()).getAccountInfo(new PublicKey(info.data.subarray(4, 36))); }
    catch (e) { return { ok: false, unknown: true, reason: `the chain could not be reached (${e.message})` }; }
    if (!data || !(data.data?.length > 45)) {
      return { ok: false, reason: 'that program has no code deployed — its programdata account is empty or missing' };
    }
  }
  return { ok: true };
}
/** Re-checks every program; a verdict is only written when the chain answered (an unreachable RPC never empties the menu). */
export async function hookSweep() {
  const blocks = JSON.parse(meta.get('hook_blocks') || '{}'); let n = 0;
  for (const prog of new Set(RULES.map((r) => r.program.toBase58()))) { const v = await verifyHook(prog); if (v.unknown) continue; if (v.ok) delete blocks[prog]; else blocks[prog] = v.reason; n++; }
  meta.set('hook_blocks', JSON.stringify(blocks)); meta.set('hook_swept_at', String(Date.now())); return { checked: n, blocked: Object.keys(blocks).length };
}
const blockedReason = (rule) => { try { return JSON.parse(meta.get('hook_blocks') || '{}')[rule.program.toBase58()] || null; } catch { return null; } };
/** The catalogue as the browser sees it. */
export const ruleList = () => RULES.map((r) => ({ key: r.key, family: r.family, label: r.label, blurb: r.blurb, program: r.program.toBase58(), params: r.params, exempt: r.exempt, warn: r.warn || null, sol: r.sol ? r.sol(Object.fromEntries(r.params.map((p) => [p.key, p.default]))) : 0, unavailable: blockedReason(r) }));
/** Resolve a launcher's choice to a rule + clean params, refusing anything not offered. */
export async function resolveRule(key, rawParams) {
  if (!key || key === 'none') return null; const rule = ruleByKey(String(key)); if (!rule) throw new Error('that rule is not offered here');
  const why = blockedReason(rule); if (why) throw new Error(`${rule.label} cannot be used right now: ${why}`);
  const v = await verifyHook(rule.program); if (!v.ok && !v.unknown) throw new Error(`${rule.label} cannot be used: ${v.reason}`);
  const params = cleanParams(rule, rawParams || {}); return { rule, params, summary: rule.summary(params), sol: rule.sol ? rule.sol(params) : 0 };
}
/** The "switch the rule on" transactions, as instruction groups in order, for the launcher's wallet to pay and sign. */
export async function buildRuleOn({ rule, params, mint, pool, payer, supplyRaw, decimals = 6, poolConfig = null }) {
  // ⛔ ONE RULE NEEDS THE CURRENT SLOT, AND IT WAS BEING FETCHED FOR ALL TWENTY-EIGHT.
  //
  // Only `vesting` uses it, and only when a presale window is set — it converts hours into a slot
  // deadline. Reading it unconditionally meant every rule paid for a chain round trip it never
  // used, and, far worse, that switching ANY rule on failed outright whenever the RPC breaker was
  // open: "rpc paused: every endpoint is rate limited". That is a launch collapsing on a busy
  // minute for a number twenty-seven of the rules do not look at.
  //
  // The deploy gate found this, not a person — an earlier suite in the same run had tripped the
  // breaker and this was the next thing to touch the chain.
  let slot = 0;
  if (rule.key === 'vesting' && num(params.presaleHours, 0) > 0) {
    try { slot = await (await rpc()).getSlot('confirmed'); }
    catch (e) {
      throw new Error('Could not read the chain to set the presale window just now — try again in '
        + `a moment, or set the presale to 0 to vest every wallet. (${e.message})`);
    }
  }
  const groups = await rule.build({ mint: new PublicKey(mint), pool: new PublicKey(pool), payer: new PublicKey(payer), params, supplyRaw: BigInt(supplyRaw), decimals, slot, poolConfig });
  return groups;
}
/** Is the rule switched on? The token program needs the hook's extra-account-metas list; it exists only after `initialize` landed. */
export async function ruleIsOn(mint, program) { const info = await (await rpc()).getAccountInfo(eamlOf(new PublicKey(mint), new PublicKey(program))); return !!info; }
export const summaryOf = (key, params) => { const r = ruleByKey(key); if (!r) return null; try { return r.summary(params || {}); } catch (e) { warn('hook summary', e.message); return r.blurb; } };

// ---- live state of a rule, for the coin page's scoreboard (trenchers play what they can see). Every reader decodes the rule's own account
// with the layout Hooked's front end uses; a rule without on-chain state worth showing is computed from its settings and the launch time.
const u64r = (b, o) => Number(b.readBigUInt64LE(o)), i64r = (b, o) => Number(b.readBigInt64LE(o));
const pk58 = (b, o) => new PublicKey(b.subarray(o, o + 32)).toBase58(); const ZERO58 = PublicKey.default.toBase58();
/** Trading hours: open right now, and when that changes. */
export function scheduleNow(params, t = Math.floor(Date.now() / 1000)) {
  const days = parseHours(params.hours); const zone = zoneRule(String(params.tz || 'UTC'), t);
  const openAt = (ts) => { const loc = ts + offsetAt(zone, ts); const dow = weekdayOf(fdiv(loc, 86400)), m = fdiv(fmod(loc, 86400), 60); const d = days[dow]; if (d.on && (d.open === d.close || (d.open < d.close && m >= d.open && m < d.close) || (d.close < d.open && m >= d.open))) return true; const pd = days[(dow + 6) % 7]; return pd.on && pd.close < pd.open && m < pd.close; };
  const now = openAt(t); let next = null; for (let s = t - fmod(t, 60) + 60, i = 0; i < 11520; i++, s += 60) if (openAt(s) !== now) { next = s; break; }
  return { open: now, nextChangeAt: next ? next * 1000 : null, sellsOpen: String(params.afterHours ?? 'closed') === 'sells' };
}
export async function ruleState({ rule, params = {}, mint, liveAt = null, decimals = 6, supply = 1_000_000_000 }) {
  const M = new PublicKey(mint); const now = Math.floor(Date.now() / 1000); const pctOf = (raw) => (raw / 10 ** decimals) / supply * 100;
  if (rule === 'king') {
    const info = await (await rpc()).getAccountInfo(pda([Buffer.from('king'), M.toBuffer()], PROG.king)); if (!info) return { rule, on: false };
    const b = Buffer.from(info.data); if (b.length < 4384 || b.subarray(0, 8).toString() !== 'KINGHILL') return { rule, on: false };
    const k = { king: pk58(b, 104), minBuy: b.readBigUInt64LE(80), halfLife: b.readUInt32LE(88), stepBps: b.readUInt16LE(92), bid: b.readBigUInt64LE(136), crownedAt: i64r(b, 144), bidAt: i64r(b, 152), pot: u64r(b, 176), paid: u64r(b, 272), crowns: b.readUInt32LE(184) };
    const has = k.king !== ZERO58; let bar = k.minBuy; if (has) { if (!k.halfLife) bar = k.bid > k.minBuy ? k.bid : k.minBuy; else { const el = BigInt(Math.max(0, now - k.bidAt)), hl = BigInt(k.halfLife), n = el / hl; if (n >= 64n) bar = k.minBuy; else { const half = k.bid >> n; const v = half - (el % hl) * half / (2n * hl); bar = v > k.minBuy ? v : k.minBuy; } } }
    const toTake = has ? bar * BigInt(1e4 + k.stepBps) / 10000n + 1n : k.minBuy;
    const entries = []; const cnt = Math.min(64, b.readUInt16LE(188)); for (let i = 0; i < cnt; i++) { const o = 288 + 64 * i; entries.push({ wallet: pk58(b, o), earnedSol: u64r(b, o + 40) / 1e9, crowns: b.readUInt32LE(o + 60), reignSecs: b.readUInt32LE(o + 56) }); }
    return { rule, on: true, king: has ? k.king : null, kingBidSol: Number(k.bid) / 1e9, crownedAt: has ? k.crownedAt * 1000 : null, toTakeSol: Number(toTake) / 1e9, potSol: k.pot / 1e9, paidSol: k.paid / 1e9, crowns: k.crowns, top: entries.sort((a, z) => z.earnedSol - a.earnedSol).slice(0, 5) };
  }
  if (rule === 'potato') {
    const info = await (await rpc()).getAccountInfo(pda([Buffer.from('cfg'), M.toBuffer()], PROG.potato)); if (!info || info.data.length < 101) return { rule, on: false }; const b = Buffer.from(info.data);
    const holder = pk58(b, 53), heldSince = i64r(b, 85), freeAfter = b.readUInt32LE(49); const has = holder !== ZERO58; const hot = has && !(freeAfter > 0 && now - heldSince >= freeAfter);
    return { rule, on: true, holder: has ? holder : null, hot, heldSince: has ? heldSince * 1000 : null, coldAt: has && freeAfter ? (heldSince + freeAfter) * 1000 : null, minPassPct: pctOf(u64r(b, 41)), passes: u64r(b, 93) };
  }
  if (rule === 'pingpong') {
    const info = await (await rpc()).getAccountInfo(pda([Buffer.from('cfg'), M.toBuffer()], PROG.pingpong)); if (!info || info.data.length < 118) return { rule, on: false }; const b = Buffer.from(info.data);
    const freeAfter = b.readUInt32LE(49), lastDir = b[53] === 1 ? 'buy' : 'sell', turnAt = i64r(b, 54); const next = freeAfter > 0 && now - turnAt >= freeAfter ? 'either' : lastDir === 'buy' ? 'sell' : 'buy';
    return { rule, on: true, next, since: turnAt * 1000, freeAt: freeAfter ? (turnAt + freeAfter) * 1000 : null, buys: u64r(b, 102), sells: u64r(b, 110), minTurnPct: pctOf(u64r(b, 41)) };
  }
  if (['breathing', 'momentum', 'resonance', 'coupled'].includes(rule)) {
    const info = await (await rpc()).getAccountInfo(pda([Buffer.from('ph'), M.toBuffer()], PROG.physics)); if (!info || info.data.length < 145) return { rule, on: false }; const b = Buffer.from(info.data);
    const e = { omega2: u64r(b, 41), k: u64r(b, 49), gamma: u64r(b, 57), base: i64r(b, 73), floor: i64r(b, 81), x1: i64r(b, 105), v1: i64r(b, 113), x2: i64r(b, 121), v2: i64r(b, 129), t: i64r(b, 137) };
    const capAt = (ts) => { let { x1, v1, x2, v2 } = e; const o = e.omega2 / 1e6, kk = e.k / 1e6, g = e.gamma / 1e6; for (let s = Math.min(90, Math.max(0, ts - e.t)); s > 0; s--) { const a1 = -(o * x1 + kk * (x1 - x2) + g * v1), a2 = -(o * x2 + kk * (x2 - x1) + g * v2); v1 += a1; v2 += a2; x1 += v1; x2 += v2; } return Math.max(e.floor, e.base + x1); };
    const series = Array.from({ length: 31 }, (_, i) => pctOf(capAt(now + i * 2)));
    return { rule, on: true, capPct: pctOf(capAt(now)), basePct: pctOf(e.base), floorPct: pctOf(e.floor), next60s: series };
  }
  if (rule === 'timecap' && liveAt) {
    const t0 = num(params.capStart, 0.1), step = num(params.capStep, 0.1), every = Math.max(1, num(params.everyMinutes, 5)) * 60, dbl = String(params.growth ?? 'step') === 'double'; const n = Math.floor(Math.max(0, now - Math.floor(liveAt / 1000)) / every);
    const cap = dbl ? t0 * 2 ** Math.min(n, 40) : t0 + step * n; return { rule, on: true, capPct: Math.min(100, cap), uncapped: cap >= 100, nextAt: (Math.floor(liveAt / 1000) + (n + 1) * every) * 1000 };
  }
  if (rule === 'schedule') return { rule, on: true, ...scheduleNow(params) };
  return { rule, on: true };
}
