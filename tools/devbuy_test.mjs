// Can a launcher be asked to sign a dev buy they cannot pay for?
//
// ⛔ THE BUG THIS EXISTS FOR. The launch form's "Dev buy" box is denominated in the PAIR asset, not
// in SOL, and nothing checked the launcher held any of it. While the SIM faucet was wrongly credited
// on mainnet this was invisible — every wallet "had" 5,000,000 REX. The moment the faucet was
// correctly disabled, a dev buy against a REX pair built a transaction, asked for a signature, and
// died in simulation with:
//
//     Program TokenzQd… invoke [2]
//     Instruction: TransferChecked
//     Error: insufficient funds        (custom program error: 0x1)
//
// That program-log dump was the entire explanation offered for "you own none of the token you chose
// to pay with". Three things have to hold so it cannot recur:
//
//   1. the SERVER refuses the build in words, because the client's copy is only a courtesy;
//   2. a failed balance READ is treated as unknown, never as zero — refusing a real launch because
//      an RPC blinked would be its own bug, and telling someone they hold nothing when the read
//      failed sends them off to buy a token they already own;
//   3. the FORM says which asset the box is in, so "0.5" against a REX pair is not read as SOL.
//
//   node tools/devbuy_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const srv = fs.readFileSync('server.mjs', 'utf8');
const chain = fs.readFileSync('lib/chain.mjs', 'utf8');
const pages = fs.readFileSync('public/pages.js', 'utf8');

console.log('\n── the server refuses an unaffordable dev buy before anyone signs');
{
  const route = /if \(sub === 'dbc\/build'\) \{([\s\S]*?)\n      \}\n/.exec(srv)?.[1] || '';
  ok(route.length > 0, 'the dbc/build route is found');
  ok(/devBuy > 0n/.test(route), 'a non-zero dev buy triggers a balance check');
  ok(/CH\.heldOf\(w, quoteMint\)/.test(route), 'it reads the launcher\'s real balance of the QUOTE mint');
  // The guard is worthless after the build: by then the wallet prompt is the next thing to happen.
  const guardAt = route.indexOf('heldOf'), buildAt = route.indexOf('MET.buildLaunch');
  ok(guardAt > -1 && buildAt > -1 && guardAt < buildAt, 'the check runs BEFORE buildLaunch, not after');
  ok(/not SOL/.test(route), 'the refusal says the dev buy is not paid in SOL — the unit was the trap');
  ok(/held && held\.spendable < devBuy/.test(route),
    'an UNKNOWN balance (null) does not block the launch — only a known shortfall does');
  // Holding the token in a non-ATA account fails identically but has a different remedy, and
  // "you hold 0" would be a flat lie to someone looking at a wallet that shows a balance.
  ok(/held\.total > held\.spendable/.test(route), 'tokens held in a second account get their own message');
}

console.log('\n── the balance read distinguishes "none" from "could not tell"');
{
  ok(/export async function heldOf/.test(chain), 'heldOf is exported');
  const fn = /export async function heldOf[\s\S]*?\n\}/.exec(chain)?.[0] || '';
  ok(/return null;/.test(fn), 'a thrown RPC error returns null (unknown), not a zero balance');
  ok(/spendable/.test(fn) && /total/.test(fn), 'it reports the spendable ATA and the wallet total separately');
  ok(/tokenProgramOf\(mint\)/.test(fn),
    'it resolves the token program first — REX is Token-2022, and an ATA derived under the wrong program is a different address');
}

console.log('\n── the form states the unit and the balance');
{
  ok(/in \$\{sym\}/.test(pages), 'the field label names the pair asset once an amount is typed');
  // ⛔ The "not SOL" clause exists because a launcher typed 0.5 meaning SOL against a REX pair and
  // bought a fiftieth of a cent. It must still be there — but conditionally, because on a SOL pair
  // it rendered "Paid in SOL, not SOL", which reads as a glitch and undermines the warning itself.
  ok(/Paid in \$\{sym\}\$\{sym === 'SOL' \? '' : ', not SOL'\}/.test(pages),
    'the hint says the buy is not in SOL — except when the pair IS SOL');
  ok(/you hold \$\{fmtNum\(heldQuote\.spendable\)\}/.test(pages), 'the hint shows the real balance');
  ok(/refreshHeld\(\);?\s*\}\);/.test(pages) || /refreshHeld\(\)/.test(pages.split("pick('#quotes'")[1] || ''),
    'changing the pair re-reads the balance behind the hint');
  const hint = /function devHintText[\s\S]*?\n  \}/.exec(pages)?.[0] || '';
  ok(/heldQuote &&/.test(hint), 'the warning only fires when the balance is actually KNOWN');
}

console.log('\n── paper money cannot reach mainnet (the condition that hid all of this)');
{
  ok(/cfg\.sim \?/.test(srv), 'balances are gated on SIM');
  // The PAPER faucet (/api/faucet, engine balances) — not the devnet mint faucet under /api/chain,
  // which is a different thing gated on cfg.faucetMint.
  const paper = /if \(p === '\/api\/faucet'[\s\S]{0,200}/.exec(srv)?.[0] || '';
  ok(paper.length > 0, 'the paper faucet route is found');
  ok(/!cfg\.sim\) return json\(res, 403/.test(paper),
    'it answers 403 off-sim — a credited paper faucet is what made a 0 REX balance look like 5,000,000');
  const eng = fs.readFileSync('lib/engine.mjs', 'utf8');
  ok(/cfg\.sim && !w\.faucet/.test(eng),
    'and ensureWallet only credits the opening balance on SIM — the auto-credit was the actual leak');

  // ⛔ THE ROWS CREDITED BEFORE THE FAUCET WAS DISABLED ARE STILL IN THE MAINNET DATABASE — seven
  // wallets holding 5,000,000 paper REX each. Disabling the tap did not empty the bucket, and
  // `quoteBalance` was still pouring from it: a coin page advertised "Balance: 5.00M REX" and
  // offered 1M/5M quick-buys against money nobody had. Off SIM the only honest source is the chain.
  const bal = /async function quoteBalanceOf[\s\S]*?\n\}/.exec(srv)?.[0] || '';
  ok(bal.length > 0, 'quoteBalance has a single source-of-truth helper');
  ok(/if \(cfg\.sim\) return E\.balanceOf/.test(bal), 'paper money only on the demo market');
  ok(/CH\.heldOf\(wallet, t\.quote_mint\)/.test(bal), 'and the real on-chain balance everywhere else');
  ok(/: null;/.test(bal), 'an unreadable balance stays null — unknown, not a number to spend against');
  ok(!/quoteBalance: E\.balanceOf/.test(srv), 'nothing reads the paper ledger for the buy box any more');
  // meOn became async for this; an unawaited call would hand the client a Promise.
  const unawaited = [...srv.matchAll(/(?<!await )meOn\(wallet/g)].length;
  ok(unawaited === 1, `every meOn() call is awaited (${unawaited - 1} unawaited besides the definition)`);
}

// ⛔ "You hold no SOL, and the dev buy is paid in SOL — not SOL." That is what a SOL-quoted launch
// said, and Julz screenshotted it. The clause exists to stop someone typing a SOL figure against a
// TOKEN pair; when the pair IS SOL it contradicts itself and reads as a broken product.
console.log('\n── the refusal does not contradict itself on a SOL pair');
{
  const guard = srv.slice(srv.indexOf('You hold no ${sym}'));
  ok(/paid in \$\{sym\}\$\{sym === 'SOL' \? '' : ' — not SOL'\}/.test(guard),
    'the "not SOL" clause is dropped when the pair IS SOL');
  ok(!/paid in \$\{sym\} — not SOL/.test(srv), 'and the unconditional wording is gone');
}

// ⛔ THE AMOUNT IS DENOMINATED IN THE PAIR ASSET, so it is meaningless when the pair changes.
// 0.21 picked against SOL became "0.21 REX" — a fiftieth of a cent — and the launch was refused
// with "buy at least 0.21 REX first", which is the second thing Julz hit.
console.log('\n── changing the pair re-prices the opening buy');
{
  const pick = pages.slice(pages.indexOf("pick('#quotes'"), pages.indexOf("pick('#quotes'") + 1200);
  ok(/beforeUsd = \(Number\(f\.devBuy\) \|\| 0\) \* \(usdOf\(f\.quote\) \|\| 0\)/.test(pick),
    'the dollar value is taken BEFORE the pair changes');
  ok(/f\.devBuy = String\(Number\(\(beforeUsd \/ nowPrice\)/.test(pick),
    'and converted into the new pair, so what they meant survives');
  ok(/if \(beforeUsd > 0 && nowPrice > 0\)/.test(pick), 'with no price, it is left alone rather than zeroed');
}

// Elio, 5 Oct: "allow auto-buy inside the UI to whatever currency they need, all in 1-click".
console.log('\n── a launcher short of the pair asset can buy it in the launch flow');
{
  ok(/async function topUpOpeningBuy/.test(pages), 'there is a top-up path');
  const fn = pages.slice(pages.indexOf('async function topUpOpeningBuy'), pages.indexOf('async function refreshHeld'));
  ok(/short <= 1e-9\) return true/.test(fn), 'it does nothing when they already hold enough');
  ok(/sym === 'SOL'/.test(fn), 'and refuses sensibly on a SOL pair — there is nothing to swap into');
  // ⛔ Jupiter is exact-IN, so the shortfall cannot be bought precisely; landing under is worse than
  // useless because the launch then fails for the same reason twice.
  ok(/short \* 1\.04/.test(fn), 'it buys the shortfall with headroom, because the quote is exact-in');
  ok(/VersionedTransaction\.deserialize/.test(fn), 'it deserializes the VERSIONED transaction Jupiter returns');
  ok(/await refreshHeld\(\);\s*\n\s*if \(heldQuote && heldQuote\.spendable >= want\) return true;/.test(fn),
    'and re-reads the balance from chain rather than trusting the quote');
  // One click: the launch button runs it first.
  const btn = pages.slice(pages.indexOf("if (S.venue === 'dbc') {"), pages.indexOf("if (S.venue === 'dbc') {") + 900);
  ok(/await topUpOpeningBuy\(/.test(btn) && btn.indexOf('topUpOpeningBuy') < btn.indexOf('launchOnMeteora'),
    'the launch button tops up BEFORE launching, so it is one click');
  ok(/id="devTopUp"/.test(pages), 'and the shortfall hint offers the same thing as a button');
  // ⛔ The chips are priced in the pair asset too. After switching SOL -> REX they went on offering
  // 0.21 / 0.83 / 2.1 SOL beside a field that had correctly re-priced itself to 180,000 REX — two
  // numbers on screen disagreeing about the same choice.
  ok(/function paintDevq\(\)/.test(pages), 'the preset chips can be repainted');
  const pickq = pages.slice(pages.indexOf("pick('#quotes'"), pages.indexOf("pick('#quotes'") + 1200);
  ok(/paintDevq\(\)/.test(pickq), 'and are repainted when the pair changes');

}

// ⛔ THE BUG THAT TOLD JULZ HE HAD NO SOL WHILE HOLDING PLENTY, three times over.
//
// The quote mint for a SOL pair is So111…112 — WRAPPED SOL. heldOf read token accounts for it and
// found nothing, because wSOL exists only for the seconds inside a swap that wraps and unwraps it;
// nobody holds a standing wSOL account. So every SOL-quoted launcher read as holding zero, and the
// site asked them to "add 0.2100 more SOL to this wallet". Meteora wraps the native balance as part
// of the launch transaction, so native SOL is exactly what pays — and what has to be counted.
console.log('\n── native SOL is counted for a SOL-quoted launch');
{
  const h = chain.slice(chain.indexOf('export async function heldOf'), chain.indexOf('export async function heldOf') + 2200);
  ok(/mint\) === NATIVE_MINT\.toBase58\(\)/.test(h), 'heldOf special-cases the native mint');
  ok(/getBalance\(new PublicKey\(owner\)/.test(h), 'and reads the NATIVE balance, not a token account');
  ok(/res\.decimals = 9/.test(h), 'with 9 decimals, so a formatted amount is not off by 1000x');
  ok(/wrapped \+= BigInt/.test(h), 'any standing wSOL still counts — it is the same asset');
  ok(/warn\('heldOf native'[\s\S]{0,40}return null/.test(h),
    'and an unreadable balance returns null (UNKNOWN), never a zero somebody is refused against');
}

// ⛔ A SOL-quoted launch spends the rent AND the opening buy out of one balance. Checking the floor
// alone passes a wallet that then has nothing left to buy with, and the failure lands after the
// wallet prompt rather than before it.
console.log('\n── and the floor covers rent PLUS the opening buy on a SOL pair');
{
  const g = srv.slice(srv.indexOf('A SOL-QUOTED LAUNCH SPENDS THE RENT'), srv.indexOf("} catch (e) { warn('launch sol check'"));
  ok(/const needSol = LAUNCH_SOL_FLOOR \+ openingSol/.test(g), 'the requirement is floor + opening buy');
  ok(/So11111111111111111111111111111111111111112/.test(g), 'only when the pair IS SOL — a token pair is paid in that token');
  ok(/rent \+ \$\{openingSol\.toFixed\(4\)\} opening buy/.test(g), 'and the refusal breaks down which part is which');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
