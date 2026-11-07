// Can a dead RPC take the website down? It did, so this asks the question directly.
//
// ⛔ WHAT WENT WRONG IN PRODUCTION. The Helius key hit "max usage reached", every read fell through
// to the public RPC, and the public RPC answered 429. web3.js retried each one five times on its
// own; the failover then retried the whole call on the other endpoint, which was the throttled one;
// and the indexer, crank, holder lists and price refresh kept adding more without waiting for any
// of it. On a shared single-core machine that was enough to starve the HTTP server: rexpad.fly.dev
// answered in nine seconds or not at all, and Julz reported it as "the search bar doesn't load".
//
// So the thing worth testing is not whether a read succeeds. It is whether a FLOOD of failing reads
// leaves the process able to do anything else.
//
//   node tools/rpc_breaker_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-rpc-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'rpc.sqlite';
process.env.RPC_URL = 'http://127.0.0.1:59999';   // never connected to; the proxy is what is under test
process.env.RPC_BREAK_MS = '400';

const CH = await import('../lib/chain.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

// A stand-in for a provider that answers every call with a rate limit, after a realistic delay.
let served = 0, peak = 0, live = 0;
const limited = {
  rpcEndpoint: 'http://stub',
  async getAccountInfo() {
    served++; live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 25));
    live--;
    throw new Error('429 Too Many Requests: max usage reached');
  },
  onLogs() { return 7; },
  removeOnLogsListener() { return 7; },
};

// Reach into the module's own wrapper by building a connection the same way conn() does.
const wrapped = CH.__wrapForTest ? CH.__wrapForTest(limited, null) : null;
ok(!!wrapped, 'the module exposes its wrapper for testing');
if (!wrapped) { console.log('\n❌ cannot continue'); process.exit(1); }

ok(wrapped.onLogs() === 7, 'onLogs still returns a subscription id synchronously, not a promise');
ok(wrapped.removeOnLogsListener(7) === 7, 'removeOnLogsListener is left alone too');

// 200 reads at once — what the timers actually produce when everything fires together. The event
// loop has to stay responsive THROUGHOUT this, which is the whole point: a web request arriving
// mid-flood is exactly the case that was failing.
// ⛔ MEASURE THE LONGEST STALL, NOT THE TICK COUNT. The claim is "the event loop was never
// blocked", and a count is a poor proxy for it: on a loaded machine — forty-eight suites running
// back to back — a 10ms interval simply fires fewer times, with no stall at all. That made this
// assertion fail about one run in twenty, and a test that cries wolf is one people stop reading.
// The gap between consecutive ticks answers the actual question.
let ticks = 0, worstGap = 0, lastTick = Date.now();
const timer = setInterval(() => { const now = Date.now(); worstGap = Math.max(worstGap, now - lastTick); lastTick = now; ticks++; }, 10);
const t0 = Date.now();
const results = await Promise.allSettled(Array.from({ length: 200 }, () => wrapped.getAccountInfo('x')));
const elapsed = Date.now() - t0;
clearInterval(timer);

ok(results.every((r) => r.status === 'rejected'), 'every read against a rate-limited endpoint fails rather than hanging');
ok(peak <= 6, `never more than 6 reads in flight at once (peak was ${peak})`);
ok(served < 200, `the breaker stopped the flood before it was all sent (${served} of 200 reached the endpoint)`);
ok(CH.rpcPaused(), 'the breaker is open after a burst of 429s');
console.log(`   … ${served} requests, peak ${peak} in flight, ${elapsed}ms`);

// Blocked means a long silence, not a lower count. 250ms is far beyond any scheduling jitter and
// far below the multi-second freeze this test exists to catch.
ok(ticks > 0, `the event loop kept running during the flood (${ticks} ticks in ${elapsed}ms)`);
ok(worstGap < 250, `and was never stalled for long (worst gap ${worstGap}ms)`);

// A second flood while the breaker is open must cost nothing at all — not one request.
const before = served;
await Promise.allSettled(Array.from({ length: 200 }, () => wrapped.getAccountInfo('x')));
// At most the half-open probe gets out — never the flood. One is the mechanism working; two
// hundred is the bug this whole file is about.
ok(served - before <= 1, `a flood arriving while the breaker is open sends at most the probe (${served - before} sent)`);

// And it has to come back on its own — but ONLY once a read has actually succeeded. After the
// cooldown it is half-open, not closed: the clock running out is not evidence the endpoint is well,
// and treating it as evidence is what let the whole backlog through at once.
await new Promise((r) => setTimeout(r, 500));
ok(CH.rpcStats().needProbe === true, 'after the cooldown it is half-open, waiting for a probe');
ok(CH.rpcPaused(), 'and still refuses ordinary reads until one succeeds');

const stats = CH.rpcStats();
ok(stats.inflight === 0 && stats.queued === 0, `nothing is left stuck in the queue (${JSON.stringify(stats)})`);

console.log('\n── it recovers through ONE probe, not a thundering herd');
{
  // ⛔ EVERYTHING IN THIS PROCESS RUNS ON TIMERS THAT KEEP FIRING WHILE THE BREAKER IS OPEN, so the
  // moment it closes the whole backlog arrives at once — which is exactly the burst that tripped it.
  // Without a half-open probe the breaker oscillates instead of recovering, and the oscillation
  // looks from the outside like an RPC that works but mysteriously never serves anything.
  let healthy = false, hits = 0;
  const recovering = {
    rpcEndpoint: 'http://stub',
    async getAccountInfo() {
      hits++;
      await new Promise((r) => setTimeout(r, 5));
      if (!healthy) throw new Error('429 Too Many Requests');
      return { ok: true };
    },
    onLogs() { return 7; },
  };
  const w = CH.__wrapForTest(recovering, null);

  // Trip it.
  await Promise.allSettled(Array.from({ length: 30 }, () => w.getAccountInfo('x')));
  ok(CH.rpcPaused(), 'the breaker is open');

  // Still unwell: the one probe that gets through must not let everyone else in behind it.
  await new Promise((r) => setTimeout(r, 450));
  hits = 0;
  await Promise.allSettled(Array.from({ length: 30 }, () => w.getAccountInfo('x')));
  ok(hits <= 1, `a failed probe admits at most one read, not the backlog (${hits})`);
  ok(CH.rpcPaused(), 'and the breaker stays shut');

  // Now it recovers. The breaker FAILS FAST by design — that is what keeps the site serving — so
  // the batch that happens to arrive on the same tick as the probe is still refused, and only the
  // probe itself gets through. What matters is that the NEXT batch, milliseconds later, is served:
  // callers here are timers that retry, and the alternative is making web requests queue behind a
  // health check, which is the latency this whole mechanism exists to avoid.
  healthy = true;
  await new Promise((r) => setTimeout(r, 450));
  const probeBatch = await Promise.allSettled(Array.from({ length: 20 }, () => w.getAccountInfo('x')));
  ok(probeBatch.filter((r) => r.status === 'fulfilled').length === 1,
    'the tick carrying the probe serves only the probe');
  const after = await Promise.allSettled(Array.from({ length: 20 }, () => w.getAccountInfo('x')));
  const served = after.filter((r) => r.status === 'fulfilled').length;
  ok(served === 20, `and every read after it is served (${served}/20)`);
  ok(!CH.rpcPaused(), 'and the breaker is closed again');
  ok(CH.rpcStats().probing === false, 'with no probe slot left held');
}

console.log('\n── a probe that dies in some OTHER way must not wedge the breaker shut');
{
  // rpcPaused() is true while probing, so a probe slot that is never handed back refuses every read
  // in the process for ever — a permanent outage caused by one flag nobody clears. A 429 clears it
  // via noteRateLimit; a timeout or a malformed response has to clear it too.
  const broken = {
    rpcEndpoint: 'http://stub',
    async getAccountInfo() { throw new Error('socket hang up'); },
    onLogs() { return 7; },
  };
  const w = CH.__wrapForTest(broken, null);
  await Promise.allSettled(Array.from({ length: 30 }, () => w.getAccountInfo('x')));
  await new Promise((r) => setTimeout(r, 450));
  await Promise.allSettled([w.getAccountInfo('x')]);        // the probe, which dies non-429
  await new Promise((r) => setTimeout(r, 450));
  ok(CH.rpcStats().probing === false, 'the probe slot is released even on a non-rate-limit failure');
}


// ── background work must not take the recovery probe from someone who is waiting ────────────────
//
// ⛔ THE PROBE WAS FIRST-COME-FIRST-SERVED, AND THE TIMERS ALWAYS COME FIRST. When the breaker
// opens exactly one read is let through to find out whether the endpoint is back. The pool sweep
// runs every 10 s and the indexer polls constantly, so they were taking that slot essentially every
// time — and a launcher who loaded the form during a pause was refused while a backfill tested the
// water for them. The site recovered; the person still got an error across their live preview.
console.log('\n── the recovery probe belongs to whoever is actually waiting');
{
  let answered = 0;
  const healthyStub = {
    rpcEndpoint: 'http://stub2',
    async getAccountInfo() { answered++; return { ok: true }; },
    onLogs() { return 1; }, removeOnLogsListener() { return 1; },
  };
  const w2 = CH.__wrapForTest(healthyStub, null);

  // Drive the breaker open, then wait out the pause so a probe is due.
  const hot = { rpcEndpoint: 'http://hot', async getAccountInfo() { throw new Error('429 Too Many Requests'); },
    onLogs() { return 1; }, removeOnLogsListener() { return 1; } };
  const wHot = CH.__wrapForTest(hot, null);
  await Promise.allSettled(Array.from({ length: 12 }, () => wHot.getAccountInfo('x')));
  ok(CH.rpcPaused(), 'breaker is open again for this case');
  await new Promise((r) => setTimeout(r, Number(process.env.RPC_BREAK_MS) + 60));

  // A background caller asks first — and must be refused rather than consuming the one probe.
  const bgResult = await CH.background(() => w2.getAccountInfo('bg')).then(() => 'through', (e) => e.message);
  ok(bgResult !== 'through', '⛔ background work is refused while paused, even when it asks first');
  ok(/rate-limiting|paused/i.test(String(bgResult)), '   and is told why');

  // The foreground caller that arrives afterwards still finds the probe available.
  const fgResult = await w2.getAccountInfo('fg').then(() => 'through', (e) => e.message);
  ok(fgResult === 'through', '⛔ and the probe is still there for the caller someone is waiting on');
}

// ── the message a user reads ────────────────────────────────────────────────────────────────────
//
// 32 routes in server.mjs return `{ error: e.message }` verbatim, so this string is UI text.
console.log('\n── the refusal is written for the person reading it');
{
  const hot2 = { rpcEndpoint: 'http://hot2', async getAccountInfo() { throw new Error('429 Too Many Requests'); },
    onLogs() { return 1; }, removeOnLogsListener() { return 1; } };
  const w3 = CH.__wrapForTest(hot2, null);
  await Promise.allSettled(Array.from({ length: 12 }, () => w3.getAccountInfo('x')));
  const msg = await CH.background(() => w3.getAccountInfo('x')).then(() => '', (e) => String(e.message));
  ok(!/standing down|every endpoint is rate limited, reads/i.test(msg),
    '⛔ it no longer reads like a server log');
  ok(/nothing was sent/i.test(msg), '   it says the one thing a launcher needs: nothing was sent');
  ok(/try again/i.test(msg), '   and what to do about it');
  // ⛔ AND HOW LONG TO WAIT. It used to say "a few seconds" while the pause is RPC_BREAK_MS — twenty
  // by default — so somebody who came back after three was refused again and read it as a dead
  // site. The breaker knows the remaining wait at the moment it refuses.
  const secs = Number((msg.match(/about (\d+) seconds?/) || [])[1]);
  const pause = Math.max(1, Math.ceil(Number(process.env.RPC_BREAK_MS) / 1000));
  ok(secs === pause, `⛔ and names the wait in seconds, matching the pause actually configured (${secs}s of ${pause}s)`);
  // ⛔ This file runs on a 400ms pause so it stays quick, which means the figure above is 1 either
  // way — so the number alone cannot tell a derived value from a constant. The source can: it must
  // come off the breaker's own clock, and the old sentence must be gone.
  const src = fs.readFileSync(new URL('../lib/chain.mjs', import.meta.url), 'utf8');
  ok(/_breakUntil - Date\.now\(\)/.test(src), '   computed from the breaker clock rather than written into the sentence');
  ok(!/paused for a few seconds/.test(src), '   and "a few seconds" is gone — the pause is twenty of them by default');
}


// ── a claim must not give up on one refused read ────────────────────────────────────────────────
//
// ⛔ MiKOL PRESSED CLAIM ON 72.71 DOGE AND WAS TOLD "Could not read the pool just now". The money
// was there the whole time: pool BVVMVTbn… reads back creatorQuoteFee 7271224331 — 72.712 DOGE at
// 8 decimals — on every attempt, and the SAME call had just succeeded to draw that figure on his
// screen. The read that failed was the one behind the button, refused a second later while the
// breaker was open. `creatorFeesOf` and friends collapse every failure to null, so the route could
// not tell a throttled moment from a pool that does not exist, and answered a transient refusal
// with a dead end the user had no way to read as "press it again".
console.log('\n── a read someone is waiting on gets more than one attempt');
{
  let calls = 0;
  const flaky = async () => { calls++; return calls < 3 ? null : { quote: 7271224331n }; };
  const got = await CH.readWithRetry(flaky);
  ok(!!got && String(got.quote) === '7271224331', '⛔ a read that fails twice then succeeds returns the value');
  ok(calls === 3, `   and stopped as soon as it had it (${calls} attempts, not 4)`);

  let once = 0;
  await CH.readWithRetry(async () => { once++; return { ok: true }; });
  ok(once === 1, 'a read that succeeds first time is not retried');

  let always = 0;
  const none = await CH.readWithRetry(async () => { always++; return null; }, 3);
  ok(none === null, 'a read that never succeeds still gives up rather than hanging');
  ok(always === 3, `   after exactly the attempts it was given (${always})`);

  // Bounded: a button press, not a hang. 400 + 800 = 1.2s for the 3-try case above.
  const t0 = Date.now();
  await CH.readWithRetry(async () => null, 3);
  const spent = Date.now() - t0;
  ok(spent < 3000, `⛔ and the whole thing is bounded under 3s (${spent}ms) — a claim button, not a stall`);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
