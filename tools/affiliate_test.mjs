// The affiliate tree, the invite leaderboard and the feedback box (Elio, 5 Oct).
//
// ⛔ THE CYCLE GUARD IS THE REASON THIS FILE EXISTS. `attributeWallet` refuses a DIRECT swap — A
// brought B, so B may not bring A — but nothing stops A→B→C→A, which is three perfectly ordinary
// first-touch attributions made by three different people. Walking that downward without a seen-set
// never terminates, and it takes the whole server with it because the walk is synchronous. maxDepth
// alone does not save you: it bounds the work but still counts the same wallets at every level,
// which silently inflates everyone's tree.
//
//   node tools/affiliate_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-aff-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'a.sqlite';
const { db } = await import('../lib/db.mjs');
const E = await import('../lib/engine.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let _w = 0;
const W = () => { let w = ''; const k = ++_w;
  for (let i = 0; i < 44; i++) w += B58[(k * 13 + i * 7 + (k >> (i % 4))) % B58.length];
  E.ensureWallet(w); return w; };
const link = (child, parent) => db.prepare('UPDATE wallets SET referred_by=?, referred_at=? WHERE wallet=?')
  .run(parent, Date.now(), child);

const ROOT = W(), A = W(), B = W(), C = W(), D = W(), SOLO = W();
link(A, ROOT); link(B, ROOT);     // ROOT brought A and B
link(C, A); link(D, C);           // A brought C, C brought D

console.log('\n── the tree is who you brought, and who they brought');
{
  const t = E.affiliateTree(ROOT);
  ok(t.total === 4, `four wallets below ROOT (${t.total})`);
  ok(t.levels.length === 3, `three levels deep (${t.levels.length})`);
  ok(t.levels[0].count === 2, 'level 1 is the two it brought directly');
  ok(t.levels[1].members[0].wallet === C, 'level 2 is who THEY brought');
  ok(t.levels[2].members[0].wallet === D, 'and level 3 below that');
  ok(t.levels[1].members[0].parent === A, 'each member names who brought them');
}

console.log('\n── somebody who brought nobody has an empty tree, not an error');
{
  const t = E.affiliateTree(SOLO);
  ok(t.total === 0 && t.levels.length === 0, 'empty');
  ok(E.affiliateTree('not-a-wallet').total === 0, 'and a junk wallet is empty rather than a throw');
}

console.log('\n── ⛔ a cycle terminates');
{
  // A→B→C→A is three ordinary first-touch attributions; nothing in the product forbids it.
  const X = W(), Y = W(), Z = W();
  link(Y, X); link(Z, Y); link(X, Z);
  const t = E.affiliateTree(X, { maxDepth: 50 });
  ok(t.total === 2, `each wallet appears ONCE, not once per level (${t.total})`);
  const all = t.levels.flatMap((l) => l.members.map((m) => m.wallet));
  ok(new Set(all).size === all.length, 'no wallet is counted twice');
  ok(!all.includes(X), 'and the root never reappears inside its own tree');
}

console.log('\n── depth and size are both bounded');
{
  // A chain longer than the limit must stop at the limit, not walk the whole database.
  let prev = W(); const head = prev;
  for (let i = 0; i < 12; i++) { const n = W(); link(n, prev); prev = n; }
  const t = E.affiliateTree(head, { maxDepth: 3 });
  ok(t.levels.length === 3, `stops at maxDepth (${t.levels.length})`);
  const capped = E.affiliateTree(head, { maxDepth: 50, maxNodes: 5 });
  ok(capped.total <= 5 && capped.truncated, `and at maxNodes, saying so (${capped.total}, truncated=${capped.truncated})`);
}

console.log('\n── the invite leaderboard ranks by wallets brought');
{
  const top = E.topInviters(10);
  ok(top.length > 0, 'it returns somebody');
  ok(top[0].invited >= (top[1]?.invited ?? 0), 'ordered by invites, descending');
  const root = top.find((r) => r.wallet === ROOT);
  ok(root && root.invited === 2, `ROOT shows its two DIRECT invites, not its whole tree (${root?.invited})`);
}

console.log('\n── feedback: anonymous is allowed, rubbish is not');
{
  const r = E.addFeedback({ kind: 'rating', rating: 5, text: 'good' });
  ok(r.id > 0 && r.rating === 5, 'a rating is stored');
  // ⛔ Anonymous on purpose: whoever could not connect a wallet is exactly who needs to report it.
  const row = db.prepare('SELECT * FROM feedback WHERE id=?').get(r.id);
  ok(row.wallet === null, 'with no wallet attached when none was given');
  ok(row.status === 'new', 'and lands as new');

  ok(E.addFeedback({ kind: 'rating', rating: 9 }).rating === 5, 'a rating above 5 is clamped, not rejected');
  ok(E.addFeedback({ kind: 'rating', rating: 0.4 }).rating === 1, 'and below 1 is clamped up');
  let threw = false;
  try { E.addFeedback({ kind: 'rating' }); } catch { threw = true; }
  ok(threw, 'a rating with no stars is refused');
  threw = false;
  try { E.addFeedback({ kind: 'bug', text: '   ' }); } catch { threw = true; }
  ok(threw, 'and an empty bug report is refused');
  ok(E.addFeedback({ kind: 'nonsense', rating: 3 }).kind === 'rating', 'an unknown kind falls back to rating');
  const long = E.addFeedback({ kind: 'suggestion', text: 'x'.repeat(5000) });
  ok(db.prepare('SELECT LENGTH(text) n FROM feedback WHERE id=?').get(long.id).n === 2000, 'text is capped at 2000 characters');
}

console.log('\n── and the admin panel can move one through');
{
  const r = E.addFeedback({ kind: 'bug', text: 'the chart is blank' });
  const seen = E.setFeedbackStatus(r.id, 'seen', ROOT, 'looking at it');
  ok(seen.status === 'seen' && seen.note === 'looking at it' && seen.handled_by === ROOT, 'new -> seen, with a note and who did it');
  const done = E.setFeedbackStatus(r.id, 'done', ROOT);
  ok(done.status === 'done' && done.note === 'looking at it', 'seen -> done, and the note survives a status change with none given');
  let threw = false;
  try { E.setFeedbackStatus(r.id, 'deleted', ROOT); } catch { threw = true; }
  ok(threw, 'an unknown status is refused');
  const list = E.feedbackList({ status: 'new' });
  ok(list.rows.every((x) => x.status === 'new'), 'the list filters by status');
  ok(typeof list.avgRating === 'number' && list.ratings > 0, 'and reports the average rating');
}

console.log('\n── the admin surface is gated server-side, not by hiding a button');
{
  const server = fs.readFileSync('server.mjs', 'utf8');
  const gate = server.slice(server.indexOf('const adminOk = async ()'), server.indexOf("if (p === '/api/admin/king'"));
  ok(/CH\.protocolWallets\(\)/.test(gate), 'the gate is the wallets the CHAIN names');
  ok(/if \(!allowed\) \{ json\(res, 503/.test(gate), 'an unreadable config refuses rather than allowing everybody');
  for (const route of ['/api/admin/feedback']) {
    const at = server.indexOf(`p === '${route}'`);
    ok(server.slice(at, at + 200).includes('await adminOk()'), `${route} is behind it`);
  }
  ok((server.match(/await adminOk\(\)/g) || []).length >= 4, 'and every admin route uses the same one');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
