// A swap must not be offered to a wallet that cannot pay for it, and a failure must be readable.
//
// ⛔ WHAT HAPPENED. Elio, 24 Oct: 27,000 REX → SOL on the Swap page, and the card showed him
//
//     Simulation failed. Message: Transaction simulation failed
//     Logs: []. Catch the `SendTransactionError` and call `getLogs()` on it for full details.
//
// Two separate defects in four lines. The CAUSE: a Solana address holding zero lamports is not an
// account at all, so the fee payer was not there and preflight died before a single program ran —
// which is exactly why the logs came back empty. Reproduced from a fresh keypair against mainnet:
// `err: "AccountNotFound", logs: []`, byte for byte. And it is a loop with no exit, because the
// swap he was attempting is how he meant to GET the SOL that the fee is charged in. No wording at
// failure time helps; the page has to know before the button is armed.
//
// The MESSAGE: that text is a note to a developer. `niceErr` returns any non-TypeError message
// verbatim and the jup route relays `e.message` raw, so web3.js's own debugging advice was rendered
// to a user who cannot catch anything — and nobody ever DID call getLogs(), so the one detail the
// error points at was thrown away on every failure since the page shipped.
//
//   node tools/swap_gas_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

process.env.JUP_RPC = process.env.JUP_RPC || 'https://api.mainnet-beta.solana.com';
const JUP = await import('../lib/jupiter.mjs');

// ---------- the sentence a no-SOL wallet gets ----------
// ⛔ MATCHED ON THE STRUCTURED err, NOT ON THE PROSE. Elio's message reads "Transaction simulation
// failed" and then stops — no cause in it at all. The reason lives in the RPC's `err` field, which
// SendTransactionError does not carry, which is why `send` re-simulates to recover it. A test that
// only fed this a tidy message would pass while every real failure fell through to the generic.
{
  const bare = JUP.swapError({ message: 'Simulation failed. \nMessage: Transaction simulation failed \nLogs: []. Catch the `SendTransactionError` and call `getLogs()` on it for full details.', logs: [] });
  ok(!/SendTransactionError|getLogs|Simulation failed/.test(bare),
    '⛔ the developer note never reaches the user, even when the message carries no cause at all');
  ok(/nothing was charged/i.test(bare), 'and a refused swap always says nothing was charged');

  const gas = JUP.swapError({ message: 'Simulation failed. "AccountNotFound"', logs: [] });
  ok(/no SOL/i.test(gas) && /network fee/i.test(gas), 'AccountNotFound is explained as having no SOL for the fee');
  ok(/even when the swap is how you were going to get some/i.test(gas),
    '⛔ and it names the catch-22 explicitly — that is the whole reason the user is stuck');
  ok(!/AccountNotFound/.test(gas), 'without the raw error code');
}

// Each cause gets its own sentence. A single "it failed" for all of them is what this replaces.
{
  const cases = [
    ['BlockhashNotFound', /expired/i, 'an expired blockhash says the quote went stale'],
    ['block height exceeded', /expired/i, 'and so does an exceeded block height'],
    ['custom program error: 0x1771', /slippage/i, '0x1771 is named as slippage, not as a hex code'],
    ['insufficient funds', /not enough of that token/i, 'insufficient funds names the token, not the fee'],
  ];
  for (const [msg, re, label] of cases) {
    const s = JUP.swapError({ message: `Simulation failed. ${msg}`, logs: [] });
    ok(re.test(s), label);
    ok(!/0x|Error:|undefined|\[object/.test(s), `  · and "${msg}" leaks no code into it`);
  }
  const distinct = new Set(cases.map(([m]) => JUP.swapError({ message: m, logs: [] })));
  ok(distinct.size === 3, `the causes give distinct sentences, not one catch-all (${distinct.size} of 4 branches, two expiry forms share one)`);
}

// ---------- the floor is a real figure, and the page can ask for it ----------
{
  ok(Number.isInteger(JUP.FEE_FLOOR) && JUP.FEE_FLOOR > 0, `there is a stated floor (${JUP.FEE_FLOOR} lamports)`);
  ok(JUP.FEE_FLOOR >= 2_039_280,
    '⛔ and it covers the rent for a temporary wrapped-SOL account — a route to or from SOL opens one, and rent that comes back still has to be payable first');
  ok(JUP.FEE_FLOOR < 0.01 * 1e9, 'but it is not so high that an ordinarily funded wallet is turned away');
  ok(typeof JUP.readiness === 'function', 'and a wallet can be asked before anything is built');
  let threw = null;
  try { await JUP.readiness('not-a-wallet'); } catch (e) { threw = e.message; }
  ok(threw === 'bad wallet', 'readiness validates the address rather than asking the RPC about nonsense');
}

// ---------- send reads the logs the error is pointing at ----------
{
  const src = fs.readFileSync(new URL('../lib/jupiter.mjs', import.meta.url), 'utf8');
  const send = src.slice(src.indexOf('export async function send('));
  ok(/getLogs\(/.test(send), '⛔ send calls getLogs(), which is the entire reason the error asks to be caught');
  ok(/simulateTransaction\(/.test(send), 'and re-simulates to recover the structured err the message omits');
  ok(/warn\('jup send'/.test(send), 'and records both, so the next occurrence is diagnosable after the fact');
  ok(/throw new Error\(swapError\(/.test(send), 'and the user gets the translated sentence, not the raw one');
  ok(/skipPreflight: false/.test(send),
    '⛔ preflight stays ON — it is what turns a doomed send into a refusal that costs nothing');
}

// ---------- the client asks before it arms the button ----------
{
  const ui = fs.readFileSync(new URL('../public/pages.js', import.meta.url), 'utf8');
  const swap = ui.slice(ui.indexOf('export async function swap(root)'));
  ok(/\/api\/jup\/ready/.test(swap), 'the swap page asks whether the wallet can pay a fee');
  ok(/const noGas = /.test(swap) && /busy \|\| !q \|\| noGas \? 'disabled'/.test(swap),
    '⛔ and a wallet that cannot is not given an armed Swap button');
  ok(/No SOL for the network fee/.test(swap), 'the button itself says why it is disabled');
  ok(/bus\.on\('auth'/.test(swap), 'and it re-asks when a wallet connects, which is when most people arrive at the question');
  // ⛔ An unreachable RPC must not lock a funded wallet out of its own swap: unknown is not empty.
  ok(/catch \{ ready = null; \}/.test(swap),
    '⛔ a failed balance read leaves the answer unknown rather than assuming the wallet is empty');
  ok(/S\.me && ready && !ready\.enough/.test(swap), 'so the block needs a positive answer, not the absence of one');

  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  ok(/sub === 'ready'/.test(srv) && /JUP\.readiness/.test(srv), 'and the route behind it exists');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
