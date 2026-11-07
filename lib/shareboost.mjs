/**
 * Post & earn — points for posting about REX Chain on X.
 *
 * Elio's ask, 7 Oct, pointing at @minersfamily's "share boost": "How to implement this system like
 * miner — to give people that share some points. We need bagwork incentives. People to post about
 * us." You post about the project, you paste the link, the post earns you points.
 *
 * ⛔ THE HONEST PART: WE CANNOT READ X WITHOUT CREDENTIALS, AND PRETENDING OTHERWISE IS THE BUG.
 * A server-side fetch of an x.com URL gets a JavaScript shell, not a post — there is no text in it
 * to check, no author, no date. So this does not claim to verify what it cannot:
 *
 *   · With `X_BEARER` set, a post is fetched through the real API and auto-approved when it both
 *     exists and mentions the project — a link to the site, the contract address, or the handle.
 *   · Without it, a submission is accepted as PENDING and earns nothing until a human approves it.
 *
 * A pending post is worth zero. That is deliberate and it is the same rule the referral programme
 * already follows — points for the unvested are points for the patient attacker. The queue is small
 * and the review is one click; paying first and checking later is how a boost becomes a faucet.
 *
 * Everything structural IS checked without credentials, because those checks are free and they stop
 * the obvious abuse: the URL has to be a real X status URL, every post can be claimed exactly once
 * by anybody, a wallet has a daily ceiling, and the same wallet cannot submit the same handle's
 * posts past that ceiling to farm the queue.
 */
import { db } from './db.mjs';
import { cfg, warn } from './config.mjs';

// The table and its indexes live in db.mjs with the rest of the schema — points.mjs reads it too,
// and a table created as a side effect of importing this module is a table that may not exist yet.

/** Points per approved post, and how many a wallet can be paid for in a rolling day. */
export const POINTS_PER_POST = Number(process.env.SHARE_POINTS || 150);
export const DAILY_CAP = Number(process.env.SHARE_DAILY_CAP || 3);
const DAY_MS = 86_400_000;

/**
 * Pull the status id out of whatever the user pasted.
 *
 * Accepts x.com and twitter.com, with or without a subdomain, with any query tail, and the
 * `/i/web/status/` shape the mobile app produces. Returns null for anything else — including a
 * profile link, which people paste constantly and which proves nothing.
 */
export function parsePost(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (!['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com'].includes(host)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const i = parts.findIndex((p) => p === 'status' || p === 'statuses');
  if (i < 0 || !parts[i + 1]) return null;
  const id = parts[i + 1].split('?')[0];
  if (!/^\d{6,25}$/.test(id)) return null;
  // ⛔ THE HANDLE IS ONLY A HANDLE WHEN IT SITS DIRECTLY AFTER THE HOST. The app's own share sheet
  // produces `/i/web/status/<id>`, where the segment before `status` is the literal "web" — read
  // positionally that becomes @web, and every post shared from a phone gets filed under one
  // imaginary account. It is advisory anyway; the post id is what identity rests on.
  const handle = i === 1 && /^[A-Za-z0-9_]{1,15}$/.test(parts[0]) && parts[0] !== 'i' ? parts[0] : null;
  return { id, handle, url: `https://x.com/${handle || 'i/web'}/status/${id}` };
}

/** How many approved posts a wallet has been paid for in the last 24h. */
const paidToday = (wallet) => db.prepare(
  `SELECT COUNT(*) n FROM share_posts WHERE wallet=? AND status='approved' AND ts > ?`
).get(wallet, Date.now() - DAY_MS).n;

/** Pending submissions count against the ceiling too, or the queue becomes the farm. */
const openToday = (wallet) => db.prepare(
  `SELECT COUNT(*) n FROM share_posts WHERE wallet=? AND status IN ('approved','pending') AND ts > ?`
).get(wallet, Date.now() - DAY_MS).n;

/**
 * Does this post mention us at all?
 *
 * Only reachable with credentials. The three things that count as a mention are the ones that
 * actually bring somebody here: the site, the contract, or the handle.
 */
function mentionsUs(text = '') {
  const t = String(text).toLowerCase();
  const needles = [
    'rex.fun', 'rexpad', 'rex chain',
    String(cfg.rexCa || '').toLowerCase(),
    String(process.env.X_HANDLE || '').replace(/^@/, '').toLowerCase(),
  ].filter((n) => n && n.length > 3);
  return needles.some((n) => t.includes(n));
}

/** Fetch a post through the real API. Returns null when we have no credentials or it did not answer. */
async function fetchPost(id) {
  const bearer = process.env.X_BEARER;
  if (!bearer) return null;
  try {
    const r = await fetch(`https://api.twitter.com/2/tweets/${id}?tweet.fields=created_at,text,author_id&expansions=author_id`, {
      headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.data) return null;
    return { text: j.data.text || '', createdAt: Date.parse(j.data.created_at || '') || null, handle: j.includes?.users?.[0]?.username || null };
  } catch (e) { warn('share fetch', e.message); return null; }
}

/**
 * Submit a post for a wallet.
 * @returns {Promise<{ok:boolean, status?:string, points?:number, error?:string, id?:number}>}
 */
export async function submit(wallet, rawUrl) {
  const post = parsePost(rawUrl);
  if (!post) return { ok: false, error: 'That is not a link to a post on X. Open the post, tap Share → Copy link, and paste that.' };
  const already = db.prepare('SELECT wallet, status FROM share_posts WHERE post_id=?').get(post.id);
  if (already) {
    return { ok: false, error: already.wallet === wallet ? 'You have already submitted that post.' : 'That post has already been claimed.' };
  }
  if (openToday(wallet) >= DAILY_CAP) {
    return { ok: false, error: `${DAILY_CAP} posts a day is the limit — the next one counts in 24 hours.` };
  }

  const live = await fetchPost(post.id);
  let status = 'pending', note = null;
  if (live) {
    if (!mentionsUs(live.text)) { status = 'rejected'; note = 'the post does not mention REX Chain'; }
    else if (live.createdAt && Date.now() - live.createdAt > 30 * DAY_MS) { status = 'rejected'; note = 'the post is more than 30 days old'; }
    else { status = 'approved'; }
  }
  const ts = Date.now();
  const r = db.prepare('INSERT INTO share_posts(wallet,url,post_id,handle,status,note,ts,decided_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(wallet, post.url, post.id, live?.handle || post.handle || null, status, note, ts, status === 'pending' ? null : ts);
  return {
    ok: status !== 'rejected', id: Number(r.lastInsertRowid), status, note,
    points: status === 'approved' ? POINTS_PER_POST : 0,
    error: status === 'rejected' ? `Not counted — ${note}.` : null,
  };
}

/** Admin: approve or reject a queued post. */
export function decide(id, status, note = null) {
  if (!['approved', 'rejected'].includes(status)) return { ok: false, error: 'bad status' };
  const row = db.prepare('SELECT * FROM share_posts WHERE id=?').get(Number(id));
  if (!row) return { ok: false, error: 'no such post' };
  db.prepare('UPDATE share_posts SET status=?, note=?, decided_at=? WHERE id=?').run(status, note, Date.now(), Number(id));
  return { ok: true, id: Number(id), status, wallet: row.wallet };
}

/** The review queue, oldest first — a queue is worked from the front. */
export const queue = (limit = 100) => db.prepare(
  `SELECT id, wallet, url, handle, ts FROM share_posts WHERE status='pending' ORDER BY ts ASC LIMIT ?`
).all(Math.min(500, Number(limit) || 100));

/** One wallet's posts, newest first. */
export const forWallet = (wallet, limit = 25) => db.prepare(
  `SELECT id, url, handle, status, note, ts FROM share_posts WHERE wallet=? ORDER BY ts DESC LIMIT ?`
).all(wallet, Math.min(100, Number(limit) || 25));

/**
 * Points earned from posting — derived, like every other figure on the board.
 *
 * ⛔ APPROVED ONLY. A pending row is a claim, not an achievement, and a rejected one must stop
 * counting the instant it is rejected. Both fall out of this query for free, which is the whole
 * reason the score is computed rather than credited.
 */
export const pointsOf = (wallet) => db.prepare(
  `SELECT COUNT(*) n FROM share_posts WHERE wallet=? AND status='approved'`
).get(wallet).n * POINTS_PER_POST;

/** Every wallet's post points in one pass, for the board. */
export const allPoints = () => db.prepare(
  `SELECT wallet, COUNT(*) n FROM share_posts WHERE status='approved' GROUP BY wallet`
).all().reduce((m, r) => (m[r.wallet] = r.n * POINTS_PER_POST, m), {});

export const stats = () => ({
  approved: db.prepare("SELECT COUNT(*) n FROM share_posts WHERE status='approved'").get().n,
  pending: db.prepare("SELECT COUNT(*) n FROM share_posts WHERE status='pending'").get().n,
  autoVerify: !!process.env.X_BEARER,
  pointsPerPost: POINTS_PER_POST,
  dailyCap: DAILY_CAP,
});
