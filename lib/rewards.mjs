// Live bridge to the $REX holder-rewards program (rewards.rex.fun / rex-rewards.fly.dev).
// Read-only: we proxy and cache its public endpoints so REX Chain can show the same truth without CORS or hammering it.
import { cfg, warn } from './config.mjs';
import { meta } from './db.mjs';

const cache = new Map();   // path -> { at, data }
const inflight = new Map(); // path -> promise, so N readers cause one upstream call

/**
 * Fetch with stale-while-revalidate.
 *
 * `/api/burn` takes a consistent 15.3 SECONDS to answer — it reads the chain — and the old 12s
 * ceiling meant it timed out on every single request, forever. The burn panel was not empty because
 * nothing had burned; 92k REX had. It was empty because this function never once got an answer and
 * quietly returned null, and a null rendered as "no burn yet".
 *
 * So: per-path timeouts, and a stale entry is served IMMEDIATELY while a refresh runs behind it. A
 * slow upstream now costs one stale render, not a dead panel and not a blocked page.
 */
async function get(path, ttl = 60_000, timeout = 12_000) {
  const hit = cache.get(path);
  const fresh = hit && Date.now() - hit.at < ttl;
  if (fresh) return hit.data;

  const run = inflight.get(path) || (async () => {
    try {
      const r = await fetch(cfg.rewardsBase + path, { headers: { 'user-agent': 'REX Chain/1.0' }, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      cache.set(path, { at: Date.now(), data });
      return data;
    } catch (e) {
      warn('rewards fetch', path, e.message);
      // Mark the attempt so a hard-down upstream is not retried on every single request.
      if (hit) cache.set(path, { at: Date.now() - Math.floor(ttl / 2), data: hit.data });
      return hit ? hit.data : null;
    } finally { inflight.delete(path); }
  })();
  inflight.set(path, run);

  // Something cached, however old? Serve it now and let the refresh land for the next reader.
  if (hit) return hit.data;
  return run;
}

const BURN = '/api/burn';

/** Warm the slow one at startup so the first visitor is not the one who waits 15 seconds for it. */
export function warm() { get(BURN, 0, 30_000).catch(() => {}); }

/**
 * ⛔ A LAZY CACHE IS NOT A FEED, AND THE BURN PANEL IS A FEED.
 *
 * Everything here refreshed only when somebody asked for it, and then served the stale copy to the
 * asker while the new one landed for the next. On a busy page that is invisible; on this one it
 * meant the panel could be an hour old, and the person looking at it had no way to tell. Julz sent
 * a screenshot of it twice — "Doesn't update" — and Elio asked for it on the epoch: "Tell it to
 * update each epoch please. All data accurate like Santa."
 *
 * So the figures are pulled on a schedule whether or not anyone is watching, and every payload now
 * carries when it was fetched, so "it updates" is something the page can show rather than claim.
 */
export async function refreshAll({ force = false } = {}) {
  const ttl = force ? 0 : 60_000;
  await Promise.allSettled([
    get(BURN, ttl, 30_000),
    get('/api/analytics', ttl),
    get('/ledger.json', ttl),
    get('/config.public.json', force ? 0 : 300_000),
  ]);
  return fetchedAt();
}

/** When each cached path was last successfully fetched — and the oldest of them, which is the one
 *  that matters to a reader deciding whether to believe the panel. */
export function fetchedAt() {
  const out = {};
  for (const [path, v] of cache) out[path] = v.at;
  const ages = Object.values(out);
  return { paths: out, oldestAt: ages.length ? Math.min(...ages) : null, newestAt: ages.length ? Math.max(...ages) : null };
}

export async function overview() {
  const [analytics, burn, ledger, config] = await Promise.all([
    get('/api/analytics'),
    // Ten minutes, thirty second ceiling: expensive to produce and it changes only when a burn fires.
    get(BURN, 600_000, 30_000),
    get('/ledger.json', 120_000), get('/config.public.json', 300_000),
  ]);
  const rounds = (ledger?.rounds || []).slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  // Every individual burn, newest first, each with the signature that proves it. A total is a claim;
  // a list of transactions is a receipt, and the difference is what makes the number believable.
  const burns = rounds.flatMap((r) => (r.buckets || [])
    .filter((b) => /burn/i.test(b.type || b.key || '') && Number(b.rex) > 0)
    .map((b) => ({ at: Date.parse(r.at), round: r.round, rex: Number(b.rex), sig: b.sig || null, priceUsd: Number(r.priceUsd) || 0 })))
    .sort((a, b) => b.at - a.at);
  const at = fetchedAt();
  return {
    base: cfg.rewardsBase, analytics, burn: potBlock(burn, analytics), config, burns: burns.slice(0, 20),
    // A panel that says when it last refreshed can be trusted to be refreshing. One that does not
    // gets screenshotted with "doesn't update" under it, which is how this field came to exist.
    fetchedAt: at.newestAt, stalestAt: at.oldestAt, fetchedPaths: at.paths,
    rounds: rounds.slice(0, 25),
    totals: {
      rounds: rounds.length,
      paidUsd: analytics?.rewards?.paidUsd || 0,
      walletsRewarded: analytics?.rewards?.walletsRewarded || 0,
      burnedByProgram: analytics?.rewards?.burnedByProgram || 0,
      holders: analytics?.holders || 0,
      eligible: analytics?.eligible || 0,
      minHoldRex: analytics?.minHoldRex || 0,
      treasuryRex: analytics?.treasuryRex || 0,
      // The analytics feed does not carry an all-time figure, so the honest fallback is the sum of
      // the burns we can actually enumerate — never a zero presented as if it meant none.
      burnedTotal: analytics?.burned || burns.reduce((a, b) => a + b.rex, 0),
    },
  };
}
/**
 * The burn block the page actually renders, with a recovered pot priced in dollars.
 *
 * `potUsd` arrives from upstream alongside the raw figures, so when that read fails it comes back 0
 * too — and restoring potRex without restoring potUsd would leave the panel showing a pot with REX
 * in it and "$0.00 in the pot" beside it. The price is right here in the analytics feed, so the
 * figure is rebuilt rather than carried over: a dollar value from twelve days ago would be wrong in
 * its own way.
 */
function potBlock(burn, analytics) {
  const mv = potMovement(burn);
  const out = { ...burn, ...mv };
  // ⛔ A SECOND WAY TO GET "$0.00 IN THE POT" WITH CORRECT FIGURES BESIDE IT, and the guard above
  // cannot see it. Upstream multiplies the dollar total out of two in-memory price caches that only
  // its own unrelated routes fill, so on a cold process — after every deploy and every restart —
  // potUsd comes back 0 while potRex and potSol are read straight off the chain and are right. The
  // movement guard keys off BOTH raw figures being zero, so it passes this straight through. The
  // components are sound here; only the multiplication is missing, so it is simply done again.
  const priced = mv.potUnverified || burn?.potUsdUnverified || !(Number(burn?.potUsd) > 0);
  if (priced) {
    // ⛔ `burn.solUsd` was the hole in the original repricing: /api/burn never sent it, so the
    // recovered total counted the REX side and called the SOL side nothing. Both prices now come
    // down with the feed, with the local analytics figure as the fallback it always was.
    const rexUsd = Number(burn?.rexUsd) || Number(analytics?.priceUsd) || 0;
    const solUsd = Number(burn?.solUsd) || 0;
    const rex = Number(mv.potRex ?? burn?.potRex) || 0, sol = Number(mv.potSol ?? burn?.potSol) || 0;
    const usd = rex * rexUsd + sol * solUsd;
    // Only overwrite with something we actually worked out. A pot that is genuinely empty, and a
    // priceless pot we cannot value, must not be made to look like each other.
    if (usd > 0) out.potUsd = usd;
    else if (!(Number(burn?.potUsd) > 0) && (rex > 0 || sol > 0)) out.potUnverified = true;
  }
  return out;
}
/** Test seam: the false-zero rule is the subtle part and is worth asserting directly. */
export const __potForTest = (burn) => potMovement(burn);
/** Test seam: and the repricing on top of it, which has now failed in two distinct ways. */
export const __potBlockForTest = (burn, analytics) => potBlock(burn, analytics);
export const holder = (w) => get('/api/holder?w=' + encodeURIComponent(w), 30_000);

/**
 * Driving the rewards distributor from REX Chain's own admin page.
 *
 * ⛔ THE ONE BUTTON THAT SPENDS THE BURN POT LIVED ON A SECOND SITE BEHIND A SECOND PASSWORD.
 * The owner looked for it here — the page they administer everything else from — and there was
 * nothing to find. Meanwhile the pot sat at 2.9x its threshold for eighteen days and the team read
 * the unmoving burn date as the figures being broken. A control nobody can find is a control that
 * does not exist, whatever the service is capable of.
 *
 * The shared key is a Fly secret on both apps and never reaches a browser. Authorisation is the
 * caller's owner-wallet check; this only carries the request across.
 */
const SERVICE_KEY = process.env.REWARDS_SERVICE_KEY || '';
async function admin(path, init = {}) {
  if (!SERVICE_KEY) throw new Error('REWARDS_SERVICE_KEY is not set on this app, so the rewards service cannot be driven from here');
  const r = await fetch(cfg.rewardsBase + path, {
    ...init,
    headers: { 'x-service-key': SERVICE_KEY, 'content-type': 'application/json', 'user-agent': 'REX Chain/1.0', ...(init.headers || {}) },
    signal: AbortSignal.timeout(init.method === 'POST' ? 120_000 : 15_000),
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(data?.error || `rewards service answered ${r.status}`);
  return data ?? {};
}

/** Everything the admin card needs to say what is happening and what pressing a button would do. */
export async function adminState() {
  const [st, burn] = await Promise.all([
    admin('/admin/status'),
    get(BURN, 30_000).catch(() => null),
  ]);
  const cfgr = st.config || {};
  return {
    mode: cfgr.mode === 'auto' ? 'auto' : 'manual',
    paused: !!cfgr.paused,
    autoOn: cfgr.mode === 'auto' && !cfgr.paused,
    armed: !!cfgr.sendingArmed,
    running: st.running || null,
    nextRun: st.nextRun || null,
    intervalMinutes: Number(cfgr.intervalMinutes) || 60,
    targetUsd: Number(cfgr.potTargetUsd) || 0,
    potUsd: Number(burn?.potUsd) || 0,
    potRex: Number(burn?.potRex) || 0,
    potSol: Number(burn?.potSol) || 0,
    lastBurn: burn?.lastBurn || null,
    lastRoundAt: burn?.lastRoundAt || null,
    // The split the next round would use, so the button is never pressed blind.
    buckets: (cfgr.buckets || []).map((b) => ({ key: b.key, label: b.label, pct: b.pct, type: b.type })),
  };
}

/** `auto` / `manual` set the mode (auto also clears paused, upstream); `run` executes one round. */
export async function adminDo(action, by) {
  if (action === 'run') {
    const r = await admin('/admin/run', { method: 'POST', body: '{}' });
    warnRun(r, by);
    return { ok: true, action, result: r.result || null, log: r.log || [] };
  }
  const r = await admin('/admin/mode', { method: 'POST', body: JSON.stringify({ mode: action }) });
  return { ok: true, action, mode: r.mode || action };
}
function warnRun(r, by) {
  const kind = r?.result?.kind, round = r?.result?.round;
  if (r?.result?.belowTarget) warn(`rewards run by ${String(by).slice(0, 6)}: held below target ($${Number(r.result.potUsd).toFixed(2)} of $${r.result.targetUsd})`);
  else if (round) warn(`rewards round ${round} (${kind}) run by ${String(by).slice(0, 6)}`);
}

/**
 * When did the pot last actually MOVE?
 *
 * ⛔ `potAt` FROM THE REWARDS FEED IS A CACHE TIMESTAMP, NOT A CHANGE TIMESTAMP. It advances every
 * minute whether or not a lamport arrived, so a panel built on it reports a pot that is filling
 * when nothing is happening — which is precisely what it did: potRex sat at 9870.16521 and potSol
 * at 0.0968669 for twelve days while the USD figure drifted with the REX price, and the strip went
 * on saying "next burn fires at $100" as though it were approaching one. Julz called it: "not
 * updating". The payer wallet had had no transactions at all since the last burn.
 *
 * Only the holdings themselves can answer this, so they are remembered and compared.
 */
function potMovement(burn) {
  const key = 'pot_seen';
  const now = Date.now();
  const rex = Number(burn?.potRex) || 0, sol = Number(burn?.potSol) || 0;
  let prev = null;
  try { prev = JSON.parse(meta.get(key) || 'null'); } catch { prev = null; }

  // ⛔ A ZERO FROM A FAILING UPSTREAM IS NOT AN EMPTY POT.
  //
  // The burn figures come from rex-rewards, a separate service on the same RPC key — so when that
  // key is exhausted it cannot read the payer wallet and reports the pot as 0. The chain says
  // otherwise: 9,870.165 REX has been sitting in 2DaEMgd9… throughout. Taken at face value a zero
  // is worse than a stale figure, because the panel states the pot is empty, the movement detector
  // reads the 9,870 → 0 drop as the pot MOVING, and the one honest signal we have — "no fees have
  // reached it in N days" — resets itself to zero at exactly the moment it should be loudest.
  //
  // A pot cannot empty without a burn, so a zero with no burn behind it is a failed read. Keep the
  // last figure we are sure of, say that it is unverified, and leave the staleness clock running.
  const burnedSince = prev && burn?.lastBurn?.at && burn.lastBurn.at > prev.at;
  if (prev && rex === 0 && sol === 0 && (prev.rex > 0 || prev.sol > 0) && !burnedSince) {
    return {
      potRex: prev.rex, potSol: prev.sol, potUnverified: true,
      potMovedAt: prev.at, potStaleMs: Math.max(0, now - prev.at),
    };
  }

  if (!prev || prev.rex !== rex || prev.sol !== sol) {
    try { meta.set(key, JSON.stringify({ rex, sol, at: now })); } catch (e) { warn('pot movement', e.message); }
    return { potMovedAt: now, potStaleMs: 0 };
  }
  return { potMovedAt: prev.at, potStaleMs: Math.max(0, now - prev.at) };
}
