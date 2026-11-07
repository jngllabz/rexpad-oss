// The Build surface promises specific endpoints and an embeddable card. This checks the promise
// against the running pad, so documentation cannot quietly drift away from what is served.
// Run against a SIM server:  node tools/build_surface_test.mjs http://127.0.0.1:8787
import fs from 'node:fs';
const B = process.argv[2] || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

// every endpoint the /build page advertises, exactly as it advertises it
const DOCS = ['/api/tokens?sort=trending&limit=20', '/api/fairopens', '/api/feed', '/api/milestones',
  '/api/ref/top', '/api/leaderboard', '/api/health'];
for (const ep of DOCS) {
  const r = await fetch(B + ep);
  const j = await r.json().catch(() => null);
  ok(r.ok && j && typeof j === 'object', `${ep} → ${r.status}, JSON`);
}
const mint = (await (await fetch(B + '/api/tokens?limit=1')).json()).tokens[0].mint;
{
  const r = await fetch(`${B}/api/tokens/${mint}`); const j = await r.json();
  ok(r.ok && j.token?.mint === mint, '/api/tokens/:mint → the launch in full');
  ok(j.token.fees && j.token.buckets && j.creatorHistory, '  with the fee split, buckets and the creator record the docs promise');
}
{
  const r = await fetch(B + '/api/quote', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mint, side: 'buy', amount: 1 }) });
  const j = await r.json();
  ok(r.ok && j.quote?.split, 'POST /api/quote → the fee split bucket by bucket, unauthenticated');
}
// the embed
{
  const r = await fetch(`${B}/embed/${mint}?theme=dark&r=ABC234`);
  const html = await r.text();
  ok(r.ok && /text\/html/.test(r.headers.get('content-type') || ''), `/embed/:mint → ${r.status} html`);
  ok(/frame-ancestors \*/.test(r.headers.get('content-security-policy') || ''), '  framable by design — it is meant for other people\'s pages');
  ok(html.includes(`/t/${mint}?r=ABC234`), '  and its Trade link carries the referral code it was built with');
  ok(!/<script src=/.test(html), '  it loads nothing from anywhere else');
  const light = await (await fetch(`${B}/embed/${mint}?theme=light`)).text();
  ok(light !== html && light.includes('data-theme="light"'), '  the light theme is a different document');
  const bad = await fetch(`${B}/embed/${mint}?r=../../etc/passwd`);
  ok((await bad.text()).includes(`/t/${mint}"`), '  a junk referral code is dropped, not reflected');
}
// the share card
{
  const r = await fetch(`${B}/og/${mint}.png`);
  ok(r.ok && (r.headers.get('content-type') || '').includes('image/png'), `/og/:mint.png → ${r.status} image/png`);
  const miss = await fetch(`${B}/og/${'1'.repeat(44)}.png`);
  ok(miss.status === 404, 'an unknown mint 404s rather than rendering a blank card');
}
// ⛔ /version.txt IS A DEPLOY SAFETY DEVICE, NOT A NICETY. The forward-only gate reads it to learn
// what sha is running and refuses to ship a tree that does not contain it. Before this route
// existed the path fell through to the SPA catch-all and returned index.html, so the gate's
// `sed 's/.*-//'` produced a chunk of HTML and `git merge-base --is-ancestor` failed open on a
// nonsense revision — the one check standing between a stale branch and silently reverting
// production was passing on garbage. If anything ever moves this below the static handler, the
// gate goes quiet again rather than loudly breaking, which is why this is asserted here.
console.log('\n── the deploy gate can read what is running');
{
  const r = await fetch(B + '/version.txt').catch(() => null);
  const body = r ? (await r.text()).trim() : '';
  ok(r && r.ok, `/version.txt answers (${r ? r.status : 'no response'})`);
  ok(/^text\/plain/.test(r?.headers.get('content-type') || ''), 'as text/plain, not the SPA shell');
  ok(!/doctype|<html/i.test(body), 'and it is not index.html');
  ok(/^rexpad-\S+$/.test(body), `shaped "rexpad-<sha>" so the gate's sed yields a bare sha — got "${body.slice(0, 40)}"`);
  const sha = body.split('-').pop();
  ok(sha && sha !== 'unknown', `the sha is baked in, not "unknown" (got "${sha}") — an endpoint that answers "unknown" gates nothing`);
}

// ⛔ A `const` USED BY A TEMPLATE THAT RUNS BEFORE THE `const` DOES. This shipped a BLANK /create to
// production: `devPresets` was declared below the `root.innerHTML = ` assignment that called it, and
// a const is in its temporal dead zone until its own line executes, so building the form threw
// "Cannot access 'devPresets' before initialization" and the page rendered nothing at all.
//
// Nothing caught it. Every suite here reads the source as text and the string was present; the file
// parsed; and it could not be reproduced locally either, because the call sat inside a
// `S.venue === 'dbc' ? … : …` arm that only evaluates on the production venue.
//
// A `root.innerHTML = ` at a page function's top level runs the moment that page is opened, so any
// const-arrow it calls must already be initialised. Function DECLARATIONS are hoisted and fine.
console.log('\n── no page template calls a const that is declared beneath it');
{
  const src = fs.readFileSync('public/pages.js', 'utf8');
  // Page functions are top-level declarations; a const is only a TDZ risk against a template in the
  // SAME function, since one declared in another function is a different binding entirely. (The
  // first draft of this check compared against the whole file and flagged four innocent matches.)
  const fnStarts = [...src.matchAll(/\n(?:export )?(?:async )?function\s+\w+/g)].map((m) => m.index);
  const scopeOf = (pos) => {
    const a = fnStarts.filter((i) => i < pos).pop() ?? 0;
    const b = fnStarts.find((i) => i > pos) ?? src.length;
    return [a, b];
  };
  const bad = [];
  for (const m of src.matchAll(/\n  root\.innerHTML = `/g)) {
    const start = m.index + 1;
    let depth = 0, end = src.indexOf('`', start) + 1;
    for (; end < src.length; end++) {
      const c = src[end];
      if (c === '\\') { end++; continue; }
      if (c === '$' && src[end + 1] === '{') { depth++; end++; continue; }
      if (c === '}' && depth > 0) { depth--; continue; }
      if (c === '`' && depth === 0) break;
    }
    const tpl = src.slice(start, end);
    const [fa, fb] = scopeOf(start);
    for (const call of new Set([...tpl.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)].map((x) => x[1]))) {
      // ⛔ EXACTLY TWO SPACES — the same nesting as the `  root.innerHTML` assignment, i.e. the top
      // level of the page function. A const declared deeper is in a nested scope and does not
      // shadow anything the template sees; comparing against those produced false positives on
      // `pct` (a local number inside another block, while the template calls the import) and on
      // `balTiles`. A guard that cries wolf is a guard that gets ignored, so it only judges the
      // one case it can judge correctly — which is the case that actually broke /create.
      const re = new RegExp(`\\n  (?:const|let) ${call} =`, 'g');
      const decls = [...src.slice(fa, fb).matchAll(re)].map((d) => fa + d.index);
      // Fine if any declaration of it in this function precedes the template.
      if (decls.length && !decls.some((d) => d < start)) {
        bad.push(`${call}() is called by a template at ${start} but only declared later, at ${decls[0]}`);
      }
    }
  }
  ok(bad.length === 0, `every const a top-level page template calls is declared above it${bad.length ? ' — ' + bad.join('; ') : ''}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
