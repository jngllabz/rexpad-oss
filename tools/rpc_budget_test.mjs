// How many RPC requests does an idle site make per minute?
//
// ⛔ THE BILL IS THE SUM OF THE TIMERS, NOT THE SPEED OF ANY ONE CALL. Twenty-three live coins
// polled every ten seconds at two reads each is five requests a second, around the clock, and
// almost every one of them asks a coin nobody has traded since yesterday whether its price has
// moved. On top of that a getProgramAccounts scan per coin every four minutes — the most expensive
// call there is — to re-read a holder list that cannot have changed without a trade.
//
// This asserts the shape of the polling rather than running it: the refresh must be tiered off
// last_trade_at, and the holder scan must be skipped when nothing has traded since the last one.
//
//   node tools/rpc_budget_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const srv = fs.readFileSync('server.mjs', 'utf8');
const chain = fs.readFileSync('lib/chain.mjs', 'utf8');
const pass1 = srv.slice(srv.indexOf('async function refreshDbcPools'), srv.indexOf('// ---------- helpers'));

console.log('── the pool refresh is tiered by how recently a coin traded');
{
  ok(/last_trade_at/.test(pass1), 'the refresh reads last_trade_at');
  ok(/_lastPoolTick/.test(pass1), 'and keeps a per-coin clock so a quiet coin is skipped');
  // A dormant coin must not be polled at the hot cadence. The exact numbers are a judgement call;
  // that there ARE tiers is not.
  const tiers = (pass1.match(/quiet < /g) || []).length;
  ok(tiers >= 2, `there is more than one cadence (${tiers} thresholds)`);
}

console.log('\n── the holder scan is skipped when nothing has traded');
{
  ok(/tradedSince/.test(pass1), 'the mirror checks whether a trade has happened since the last scan');
  ok(/getProgramAccounts|scan/i.test(pass1), 'and says in the file why that matters');
}

console.log('\n── the client limits RATE, not only concurrency');
{
  ok(/RPC_MAX_INFLIGHT/.test(chain), 'concurrency is capped');
  ok(/RPC_RATE/.test(chain) && /takeToken/.test(chain), 'and so is requests per second');
  // ⛔ The distinction that cost a recovery: six in flight against a 20ms endpoint is three hundred
  // requests a second, and a semaphore does nothing about that.
  ok(/Connection rate limited|requests per\s*\n?\s*\*? ?second/i.test(chain),
    'with the reason recorded, because the two 429s look identical and are not');
  ok(/disableRetryOnRateLimit/.test(chain), 'and the library is not allowed to retry a 429 five times on its own');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
