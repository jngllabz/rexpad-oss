// ⛔ SHARE & EARN — "THAT'S OUR MOAT. EVERY HOLDER BECOMES DISTRIBUTOR." (Elio, twice)
//
// It had never worked on the venue every real coin trades on. Three separate layers, each one
// enough on its own to make the feature inert:
//
//   1. THE CHOICE WAS DROPPED AT LAUNCH. The form collects Off/25/50/75/100%; the old paper-curve
//      path stored it; saveDbcLaunch did not even take it as an argument, and the client never
//      sent it. So every live coin read back ref_share_bps = 0 and its share panel told the
//      launcher "this coin has no creator cut, so there is nothing to pay a sharer out of yet" —
//      minutes after they had picked 25%. That is the screenshot Elio sent.
//   2. NOTHING RECORDED THE VOLUME. creditReferral was called only from the paper curve's buy().
//      A sharer's link worked, the buyer arrived, and no row anywhere said they had brought them.
//   3. THE CONTROL HID ITSELF. It gated on `creatorBps`, which only the paper curve sets, so on
//      the live venue a launcher with a 1% creator cut was told to "set a creator cut above first".
//
//   node tools/share_earn_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-se-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'se.sqlite';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const addr = () => Keypair.generate().publicKey.toBase58();

const { db } = await import('../lib/db.mjs');
const IX = await import('../lib/indexer.mjs');
const E = await import('../lib/engine.mjs');

console.log('── 1. the choice survives the launch');
{
  const mint = addr();
  IX.saveDbcLaunch({ mint, pool: addr(), config: addr(), creator: addr(), name: 'Share', symbol: 'SHR',
    quoteMint: addr(), refShareBps: 2500 });
  const row = db.prepare('SELECT ref_share_bps FROM tokens WHERE mint=?').get(mint);
  ok(row.ref_share_bps === 2500, `a 25% choice is stored as 2500 (${row.ref_share_bps})`);

  IX.saveDbcLaunch({ mint, pool: addr(), config: addr(), creator: addr(), name: 'Share', symbol: 'SHR',
    quoteMint: addr(), refShareBps: 7500 });
  ok(db.prepare('SELECT ref_share_bps FROM tokens WHERE mint=?').get(mint).ref_share_bps === 7500,
    'and a re-confirm updates it rather than being ignored');

  const m2 = addr();
  IX.saveDbcLaunch({ mint: m2, pool: addr(), config: addr(), creator: addr(), name: 'X', symbol: 'XX', quoteMint: addr(), refShareBps: 99_999 });
  ok(db.prepare('SELECT ref_share_bps FROM tokens WHERE mint=?').get(m2).ref_share_bps === 10_000,
    '⛔ and a caller cannot give away more than the whole cut');
  const m3 = addr();
  IX.saveDbcLaunch({ mint: m3, pool: addr(), config: addr(), creator: addr(), name: 'Y', symbol: 'YY', quoteMint: addr() });
  ok(db.prepare('SELECT ref_share_bps FROM tokens WHERE mint=?').get(m3).ref_share_bps === 0,
    'a launch that did not ask for it gets zero, not a default');
}

console.log('\n── 2. ⛔ THE CREATOR\'S CUT IS A DIFFERENT NUMBER ON EACH VENUE');
{
  ok(E.creatorCutBps({ venue: 'rexpad', creator_bps: 50 }) === 50, 'paper curve: creator_bps is already bps of a trade');
  ok(E.creatorCutBps({ venue: 'dbc', pool_fee_bps: 200, creator_share_pct: 50 }) === 100,
    'Meteora: 2% pool fee, half to the creator = 100 bps of a trade');
  ok(E.creatorCutBps({ venue: 'launchlab', pool_fee_bps: 200, creator_share_pct: 50 }) === 100, 'LaunchLab the same');
  ok(E.creatorCutBps({ venue: 'dbc', creator_bps: 50 }) === 0,
    '⛔ and creator_bps is IGNORED on Meteora — it is 0 on every one of those rows, which reported "sharers split 0%"');
  ok(E.creatorCutBps(null) === 0 && E.creatorCutBps({}) === 0, 'a missing row is zero, not a crash');
}

console.log('\n── 3. a buy on the live venue credits the sharer who brought it');
{
  const mint = addr(), buyer = addr(), sharer = addr();
  db.prepare(`INSERT INTO tokens(mint,name,symbol,creator,quote,status,venue,created_at,ref_share_bps,pool_fee_bps,creator_share_pct)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(mint, 'T', 'T', addr(), 'SOL', 'live', 'dbc', Date.now(), 2500, 200, 50);
  db.prepare('INSERT INTO referrals(mint,referee,referrer,vested,volume) VALUES(?,?,?,1,0)').run(mint, buyer, sharer);
  ok(typeof E.creditReferral === 'function', '⛔ creditReferral is EXPORTED — the DBC indexer could not reach it before');
  E.creditReferral(mint, buyer, 5);
  E.creditReferral(mint, buyer, 3);
  const row = db.prepare('SELECT referrer, volume FROM ref_credit WHERE mint=?').get(mint);
  ok(row?.referrer === sharer && row.volume === 8, `the volume they brought accumulates (${row?.volume})`);

  // ⛔ Someone nobody referred must not create a phantom credit.
  E.creditReferral(mint, addr(), 100);
  ok(db.prepare('SELECT COUNT(*) n FROM ref_credit WHERE mint=?').get(mint).n === 1, 'and an unreferred buyer credits nobody');
  E.creditReferral(mint, buyer, 0);
  ok(db.prepare('SELECT volume FROM ref_credit WHERE mint=?').get(mint).volume === 8, 'a zero-size buy changes nothing');
}

console.log('\n── 4. the indexer that records live trades actually calls it');
{
  const src = fs.readFileSync(new URL('../lib/dbcindex.mjs', import.meta.url), 'utf8');
  ok(/ENG\.creditReferral\(t\.mint, tr\.wallet, tr\.quote\)/.test(src), 'the DBC tape credits the referrer');
  ok(/tr\.side === 'buy'/.test(src), '⛔ on BUYS only — a sell is not volume somebody brought');
  ok(/catch \(e\) \{ warn\('dbc referral'/.test(src), '⛔ and attribution failing never breaks the trade tape');
}

console.log('\n── 5. the client sends the choice, and the control stops hiding itself');
{
  // ⛔ GREP THE MARKUP, NOT THE COMMENTS. The last assertion in this block used to search the whole
  // FILE for the sentence about the payout being manual — and when that sentence was deleted from
  // the form it kept passing, satisfied by a comment that quoted it while explaining why it had
  // gone. A test a comment can satisfy is a test of nothing, so the source is stripped first. This
  // is the ninth assertion in this repo found checking a location instead of a fact.
  //
  // ⛔ LINE AND HTML COMMENTS ONLY — NEVER /* */ BY REGEX. This stripper did take block comments,
  // and `accept="image/*"` in the image field opened one: everything from there to the next */ was
  // deleted, taking the front-screen markup with it, and two assertions failed over code that was
  // perfectly correct. Matching JS comments needs a JS parser, not a regex; the notes this has to
  // see past are all // lines anyway.
  const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
  const pg = strip(fs.readFileSync(new URL('../public/pages.js', import.meta.url), 'utf8'));
  ok(/refShareBps: f\.refShareBps,/.test(pg), 'the confirm call carries refShareBps');
  ok(/const creatorCutBps = \(\) =>/.test(pg), 'the form works out the creator cut per venue');
  // ⛔ WHICH FUNCTION THE GATE CALLS, not the exact characters of one template. The old form of
  // this pinned `${creatorCutBps() === 0` literally, so lifting the control into a function that
  // both screens call broke the test while the gate it guards was untouched.
  ok(/creatorCutBps\(\) === 0/.test(pg), '⛔ and gates on THAT, not on the paper curve\'s field');
  ok(!/\$\{f\.creatorBps === 0/.test(pg), 'the old gate is gone');
  ok(!/Paying them is not automatic yet/.test(pg),
    '⛔ the "payout is still manual" line is GONE from the form — sharers are paid inside the creator\'s own claim (lib/sharers.mjs), and the form went on calling it manual long after that shipped');
  ok(/inside your own claim transaction/.test(pg),
    'and the form now says where they are actually paid from — atomically, with the creator\'s own claim');
}

console.log('\n── 5b. on by default, and on the front screen, not three taps deep');
{
  const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
  const pg = strip(fs.readFileSync(new URL('../public/pages.js', import.meta.url), 'utf8'));
  // Elio, 8 Nov: "that's our mode … make the default launch that, and instead of just hiding it on
  // advanced put it on the front." Both halves are pinned, because either one alone is the feature
  // still being invisible: a default nobody sees, or a control nobody has turned on.
  ok(/refShareBps: 5000,/.test(pg), 'a launch starts with half the creator cut shared, not 0');
  ok(/id="frontShare"/.test(pg), '⛔ and the control has a mount point on the FRONT screen');
  ok(/id="advShare"/.test(pg), 'as well as on Advanced');
  // ⛔ ONE DEFINITION, TWO MOUNT POINTS. Both screens quote the launcher a percentage of their own
  // money; a second copy of the markup is a second set of numbers waiting to disagree.
  ok((pg.match(/const shareField =/g) || []).length === 1, 'there is exactly one definition of it');
  ok((pg.match(/shareField\(/g) || []).length >= 4, '⛔ and both screens render from that one');
  ok(/frontRefShare/.test(pg) && /advRefShare/.test(pg),
    'the two rows carry different ids — an id may not repeat, and `pick` re-queries by it');
  ok(/RefShare\$\/\.test\(id\)/.test(pg),
    '⛔ the step label matches the ROW, not the Advanced copy by name — the front copy would otherwise round to a half point');
}

console.log('\n── 6. a creator can state the choice their launch lost');
{
  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const i = srv.indexOf("sub === 'creator/share'");
  const route = srv.slice(i, i + 1200);
  ok(i > 0, 'the route exists');
  ok(/t\.creator !== w\) return json\(res, 403/.test(route), '⛔ only the launcher — not any caller with a mint address');
  ok(/Math\.max\(0, Math\.min\(10_000/.test(route), 'and the value is clamped to the whole cut');
  ok(/E\.creatorCutBps\(t\)/.test(route), 'it checks there IS a creator cut to share from, per venue');
  ok(/cut <= 0/.test(route), '⛔ and refuses to promise a share of nothing');
  const pg = fs.readFileSync(new URL('../public/pages.js', import.meta.url), 'utf8');
  ok(/t\.creator === S\.me\?\.wallet \? `<div class="setshare"/.test(pg), 'the control is shown to the launcher only');
  ok(/api\('\/api\/chain\/creator\/share'/.test(pg), 'and it calls the route');
  ok(!/no creator cut, so there is nothing to pay a sharer out of yet/.test(pg),
    '⛔ the old message is gone — it blamed a missing creator cut for what was a dropped setting');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
