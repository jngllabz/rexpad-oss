// What the launch form PROMISES about the opening, versus what the venue actually does.
//
// ⛔ THE BUG THIS EXISTS FOR. The form rendered a "Fair Open window" control unconditionally —
// defaulted to "60s · recommended" and labelled "sealed, one clearing price — nobody fills block
// zero". On the live Meteora venue none of that happens: launchOnMeteora never sends fairOpenSecs,
// the DBC build route does not accept it, and every dbc token on chain has fairOpenSecs=0. So the
// product told every launcher their opening was sealed and then opened a plain bonding curve that
// bots index at block zero.
//
// Julz launched, trusted it, went to buy his own coin and found bots had already bought. He was not
// careless — he was told the opening was protected, so he left the one control that would actually
// have protected it (the opening buy, which executes INSIDE the pool-creation transaction) empty.
//
// A promise the venue cannot keep is worse than no promise: it talks people out of the protection
// that does exist.
//
//   node tools/launch_open_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const pages = fs.readFileSync('public/pages.js', 'utf8');
const server = fs.readFileSync('server.mjs', 'utf8');
const met = fs.readFileSync('lib/meteora.mjs', 'utf8');

console.log('\n── the Fair Open promise is only made where a Fair Open actually runs');
{
  // Every rendering of the sealed-opening claim must sit behind a non-dbc branch.
  const claim = "nobody fills block zero";
  const idx = pages.indexOf(claim);
  ok(idx > 0, 'the sealed-opening copy still exists for the venue that has one');
  // Walk back to the nearest venue test; it must be the ternary that excludes dbc.
  const before = pages.slice(Math.max(0, idx - 1400), idx);
  ok(/S\.venue === 'dbc' \?/.test(before),
    'and it renders only on the NON-dbc arm of a venue branch');
  // The dbc arm must offer the opening buy instead.
  ok(/Your opening buy/.test(pages), 'the dbc arm offers an opening buy instead');
  ok(/rides inside the pool-creation transaction/.test(pages),
    'described by what actually protects it — being inside the pool-creation transaction');
}

console.log('\n── that description is true of the code that builds the launch');
{
  // The claim is only honest if the dev buy really is in the same transaction as pool creation.
  ok(/createConfigAndPoolWithFirstBuy/.test(met),
    'meteora.mjs builds pool + first buy as ONE instruction set (createConfigAndPoolWithFirstBuy)');
  // ⛔ ASSERT THE BRANCH, NOT A WINDOW OF CHARACTERS. This used to look for `devBuy > 0n` within the
  // 400 characters before the call, which is a proxy for "inside the if" and breaks the moment the
  // branch grows — adding the transfer-hook variant pushed the condition out of range while the
  // property it stands for was still perfectly true. Read the block instead: every
  // createConfigAndPoolWithFirstBuy* call must sit inside `if (devBuy > 0n)`, and none may sit in
  // the else, which is the thing that would actually be wrong.
  const open = met.indexOf('if (devBuy > 0n) {');
  ok(open > 0, 'the opening-buy branch exists');
  const elseAt = met.indexOf('} else {', open);
  const branch = met.slice(open, elseAt > 0 ? elseAt : open + 2000);
  const after = met.slice(elseAt > 0 ? elseAt : met.length, elseAt > 0 ? elseAt + 1200 : met.length);
  const inBranch = (branch.match(/createConfigAndPoolWithFirstBuy/g) || []).length;
  ok(inBranch > 0, `the first-buy builder is called inside that branch (${inBranch} call site(s))`);
  ok(!/createConfigAndPoolWithFirstBuy/.test(after),
    'and never on the arm that launches without an opening buy');
  // And the venue genuinely has no Fair Open to send.
  ok(!/fairOpenSecs/.test(pages.slice(pages.indexOf('async function launchOnMeteora'), pages.indexOf('async function launchOnChain'))),
    'launchOnMeteora sends no fairOpenSecs — there is none to send');
}

console.log('\n── the launcher is handed their coin, not left hunting for it');
{
  ok(/sessionStorage.setItem\('rexJustLaunched'/.test(pages), 'a launch marks itself before navigating');
  ok(/rexJustLaunched/.test(pages.slice(pages.indexOf("sessionStorage.getItem('rexJustLaunched'"))),
    'and the coin page reads that flag on arrival');
  ok(/sessionStorage.removeItem\('rexJustLaunched'\)/.test(pages),
    'the flag is cleared when read, so a refresh is an ordinary visit');
  const arrival = pages.slice(pages.indexOf("justLaunched === mint"), pages.indexOf("justLaunched === mint") + 900);
  ok(/scrollIntoView/.test(arrival), 'the trade panel is scrolled into view');
  ok(/focus\(/.test(arrival), 'the amount field is focused');
  // ⛔ THROUGH copyText, NOT THE RAW API. A bare writeText rejects whenever the document is not
  // focused and the old code still said "copied" — on the one screen where the string is a contract
  // address somebody is about to paste into a wallet.
  ok(/copyText\(mint\)/.test(arrival), 'and the contract address is put on the clipboard');
  ok(/ok \? 'ok' : 'err'/.test(arrival), 'with the toast reporting what actually happened');
}

console.log('\n── the opening-buy presets are priced in the pair, not in SOL');
{
  // ⛔ The first dev buy ever attempted asked for 0.5 REX — a fiftieth of a cent — because the
  // field is denominated in the PAIR asset and the launcher was thinking in SOL.
  ok(/const DEV_USD = \[0, 25, 100, 250\]/.test(pages), 'presets are defined in dollars');
  ok(/\(d \/ u\)\.toPrecision\(2\)/.test(pages), 'and divided by the pair price to reach pair units');
  ok(/usd: d/.test(pages), 'each preset carries the dollar figure it was built from, not one recomputed from the rounded amount');
  ok(/if \(!\(u > 0\)\) return \[\{ amt: 0, usd: 0 \}\]/.test(pages),
    'a pair with no price offers no ladder at all, rather than an invented one');
  ok(/Paid in \$\{sym\}\$\{sym === 'SOL' \? '' : ', not SOL'\}/.test(pages),
    "and the hint says which asset it is — without the \"not SOL\" clause when the pair IS SOL, which read as a glitch");
}

console.log('\n── the server still refuses an opening buy the wallet cannot pay');
{
  // The wording moved to "opening buy" and the "— not SOL" clause became conditional, because on a
  // SOL pair it read "paid in SOL — not SOL". What must not change is that the refusal names the
  // asset, before any signature.
  ok(/the opening buy is paid in \$\{sym\}/.test(server),
    'an unaffordable opening buy is refused in plain English before any signature');
  ok(/\$\{sym === 'SOL' \? '' : ' — not SOL'\}/.test(server),
    'and the "not SOL" clause only appears when the pair is not SOL');
}

// ⛔ A LAUNCHER WHO CANNOT AFFORD THE RENT MUST BE TOLD SO, IN WORDS. Short of it the transaction
// simulates and fails inside Metaplex, and what they see is a wall of program logs ending in
// "Transfer: insufficient lamports 10105006, need 13733800". MiKOL hit exactly that, could not tell
// it meant "add 0.004 SOL", and asked the team how much a launch costs.
console.log('\n── an unaffordable launch is refused in words, before the wallet prompt');
{
  ok(/const LAUNCH_SOL_FLOOR = 0\.0\d+;/.test(server), 'there is a measured SOL floor');
  const guard = server.slice(server.indexOf('REFUSE AN UNAFFORDABLE LAUNCH'), server.indexOf('const devBuy = BigInt'));
  ok(/getBalance/.test(guard), 'it reads the launcher\'s actual SOL balance');
  ok(/lamports < needSol \* 1e9/.test(guard), 'and compares it against the floor plus any opening buy');
  ok(/holds \$\{haveSol\.toFixed\(4\)\} SOL/.test(guard), 'the refusal says how much they have');
  ok(/not a REX Chain fee/.test(guard), 'and that rent is the network\'s charge, not ours');
  // ⛔ An RPC hiccup must not block a launch that would have worked.
  ok(/catch \(e\) \{ warn\('launch sol check'/.test(guard), 'an unreadable balance never blocks the launch');
  ok(/0\.035 SOL/.test(pages), 'and the form says the figure up front');
}

// ⛔ "YOUR WALLET HAS NO SOL" TO SOMEONE CERTAIN THEY HAVE SOL IS A DEAD END — and they are usually
// both right, because the wallet extension is on a DIFFERENT ACCOUNT from the one the site is
// signed in as. Edipo hit this on a WIF pair and the team spent the evening on it.
console.log('\n── the SOL refusal names the wallet it read');
{
  const guard = server.slice(server.indexOf('NAME THE WALLET'), server.indexOf('const devBuy = BigInt'));
  ok(/\$\{short\(w\)\} holds/.test(guard), 'it prints the address the balance came from');
  ok(/add \$\{\(needSol - haveSol\)\.toFixed\(3\)\} more/.test(guard),
    'and how much MORE is needed, rather than restating the floor');
  ok(/check your wallet is on that account/.test(guard),
    'and points at the usual cause: the extension being on another account');
}

// ⛔ A POT THAT IS NOT FILLING MUST NOT LOOK LIKE ONE THAT IS. `potAt` from the rewards feed is a
// CACHE timestamp — it advances every minute whether or not a lamport arrived. potRex sat at
// 9870.16521 and potSol at 0.0968669 for twelve days while only the USD figure drifted, and the
// strip went on saying "next burn fires at $100". Julz: "not updating". He was right.
console.log('\n── a stopped burn pot says so instead of implying progress');
{
  const rw = fs.readFileSync('lib/rewards.mjs', 'utf8');
  ok(/function potMovement/.test(rw), 'pot movement is tracked');
  ok(/prev\.rex !== rex \|\| prev\.sol !== sol/.test(rw),
    'by comparing the HOLDINGS, not the feed\'s cache timestamp');
  ok(/potStaleMs/.test(rw) && /potMovedAt/.test(rw), 'and reports both when it last moved and for how long it has not');
  ok(/potStaleMs\) > 24 \* 3600_000/.test(pages), 'the strip treats a day without movement as stopped');
  // ⛔ Movement tracking starts when we first look, so on a pot already frozen for twelve days the
  // first clause stays false for another twenty-four hours. A pot at a twentieth of its threshold
  // with nothing burned in a week is knowably not approaching one, from figures the feed gives us.
  ok(/sinceBurn > 7 \* 24 \* 3600_000 && target > 0 && pot < target \* 0\.25/.test(pages),
    'and a long-dead burn with a near-empty pot reads as stopped from day one');
  ok(/no fees have reached it in/.test(pages), 'and says so rather than naming a threshold it is not approaching');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
