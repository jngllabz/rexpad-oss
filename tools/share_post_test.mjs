// Post & earn, end to end — the points, the caps, and every way the same post can be claimed twice.
//
// ⛔ THE INTERESTING FAILURES ARE ALL ABOUT IDENTITY. One post has a dozen URL spellings, and a
// boost that keys on the string the user pasted pays out once per spelling. That is the bug this
// file mostly exists to prevent.
//
//   node tools/share_post_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-sp-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'sp.sqlite';
delete process.env.X_BEARER;            // no credentials: the review-queue path is the default one
process.env.SHARE_DAILY_CAP = '3';

const { db } = await import('../lib/db.mjs');
const E = await import('../lib/engine.mjs');
const S = await import('../lib/shareboost.mjs');
const P = await import('../lib/points.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const A = 'ShareWalletAAA', B = 'ShareWalletBBB';
for (const w of [A, B]) E.ensureWallet(w);

console.log('── a link to a post is recognised, and nothing else is');
{
  const good = [
    ['https://x.com/minersfamily/status/2107908050552004850', '2107908050552004850', 'minersfamily'],
    ['https://twitter.com/someone/status/123456789012', '123456789012', 'someone'],
    ['https://x.com/someone/status/123456789012?s=46', '123456789012', 'someone'],
    ['https://mobile.x.com/someone/status/123456789012/', '123456789012', 'someone'],
    ['https://x.com/i/web/status/123456789012', '123456789012', null],
  ];
  for (const [url, id, handle] of good) {
    const r = S.parsePost(url);
    ok(r?.id === id && r?.handle === handle, `parsed ${url.slice(0, 48)} → ${id}${handle ? ' @' + handle : ''}`);
  }
  const bad = ['', null, 'not a url', 'https://x.com/someone', 'https://example.com/status/123',
    'https://x.com/someone/status/abc', 'javascript:alert(1)', 'https://x.com.evil.co/a/status/123'];
  for (const u of bad) ok(S.parsePost(u) === null, `refused ${JSON.stringify(u)}`);
}

console.log('\n── a pending post is worth exactly nothing');
{
  const r = await S.submit(A, 'https://x.com/aaa/status/1000000000001');
  ok(r.ok && r.status === 'pending', 'submitted, and it is pending (no X credentials configured)');
  ok(r.points === 0, 'pending pays 0 points');
  ok(S.pointsOf(A) === 0, 'and the wallet scores 0 from it');
  ok(P.actionPoints(A).shares === 0, 'the points breakdown agrees');
}

console.log('\n── approval is what pays');
{
  const q = S.queue();
  ok(q.length === 1 && q[0].wallet === A, 'the post is in the review queue');
  S.decide(q[0].id, 'approved');
  ok(S.pointsOf(A) === S.POINTS_PER_POST, `approved pays ${S.POINTS_PER_POST}`);
  ok(P.actionPoints(A).shares === P.RATES.sharePost, 'and lands in the points breakdown');
  ok(P.pointsOf(A).total > 0, 'which reaches the wallet total');
}

console.log('\n── a rejection takes the points back, because nothing was ever credited');
{
  const id = db.prepare("SELECT id FROM share_posts WHERE wallet=?").get(A).id;
  S.decide(id, 'rejected', 'off topic');
  ok(S.pointsOf(A) === 0, 'rejected scores 0 again with nobody subtracting anything');
  S.decide(id, 'approved');
}

console.log('\n── ⛔ ONE POST, ONE CLAIM, HOWEVER IT IS SPELLED');
{
  const spellings = [
    'https://twitter.com/aaa/status/1000000000001',
    'https://x.com/aaa/status/1000000000001?s=46&t=xyz',
    'https://mobile.twitter.com/aaa/status/1000000000001/',
    'https://x.com/i/web/status/1000000000001',
    'https://x.com/SOMEONEELSE/status/1000000000001',
  ];
  let blocked = 0;
  for (const u of spellings) { const r = await S.submit(B, u); if (!r.ok) blocked++; }
  ok(blocked === spellings.length, `all ${spellings.length} re-spellings of a claimed post were refused`);
  ok(db.prepare('SELECT COUNT(*) n FROM share_posts').get().n === 1, 'and not one extra row was written');
  ok(S.pointsOf(B) === 0, 'the second wallet earned nothing from someone else\'s post');
}

console.log('\n── the daily ceiling counts pending submissions, or the queue is the farm');
{
  let accepted = 0;
  for (let i = 0; i < 6; i++) { const r = await S.submit(B, `https://x.com/bbb/status/200000000000${i}`); if (r.ok) accepted++; }
  ok(accepted === 3, `${accepted} of 6 accepted against a cap of 3`);
  const mine = S.forWallet(B);
  ok(mine.every((x) => x.status === 'pending'), 'all of them pending, so still worth nothing');
  ok(S.pointsOf(B) === 0, 'B has 0 points while the queue is unworked');
}

console.log('\n── the queue is worked from the front');
{
  const q = S.queue();
  ok(q.length === 3, '3 waiting');
  ok(q[0].ts <= q[q.length - 1].ts, 'oldest first');
}

console.log('\n── stats say which mode we are in, because the two behave differently');
{
  const st = S.stats();
  ok(st.autoVerify === false, 'autoVerify false without X_BEARER');
  ok(st.pointsPerPost === S.POINTS_PER_POST && st.dailyCap === 3, 'rate and cap reported');
  ok(st.approved === 1 && st.pending === 3, 'counts match the table');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
