// Does text fit inside its own box on a phone?
//
// Elio's instruction was "make sure text fits in box always", after screenshotting two different
// failures on the same day. Both came from the same root cause — a rule that removes an element's
// MIN-CONTENT FLOOR — and both are invisible on a desktop, which is why they shipped.
//
//  1. THE STAT CELLS COLLAPSED TO ONE CHARACTER WIDE. `overflow-wrap:anywhere` was applied to .k,
//     .v and .l to stop long mint addresses overflowing. But that property makes min-content width
//     exactly one character, so `min-width:auto` stops being a floor and any flex or grid parent
//     may squeeze the cell to nothing. The King strip — five columns and 88px of gaps inside a
//     301px row — rendered "Holder rewards" as an 11x198 tower reading HOL/DER/REW/ARD/S, and
//     "$3,324" one digit per line. Julz screenshotted the whole board like that.
//
//  2. THE PAIR TABS OVERFLOWED THEIR OWN PILLS. `flex:1 1 0` gave six tabs an equal share, which
//     hands "ALTS" 48px when it needs 37 and "Advanced" 48px when it needs 63. The highlight sat
//     narrower than the word inside it. The type was already clamped to 10.9px, so shrinking
//     further was not available — the earlier fix had been tuned for five tabs and a sixth was
//     added later.
//
// The invariant worth asserting is the same in both cases: ANYWHERE-BREAKING BELONGS ONLY ON
// STRINGS THAT GENUINELY CANNOT BREAK AT A SPACE, and anything else must keep a content-sized floor.
//
//   node tools/mobile_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const css = fs.readFileSync('public/styles.css', 'utf8');
// Comments FIRST. A selector grab that keeps them reads the prose as code — and the comment above
// this very rule names `.k, .v and .l` while explaining why they were removed, so the test
// confidently failed on its own documentation.
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

// Every selector list that turns on anywhere-breaking.
const breakers = [...code.matchAll(/([^{}]+)\{[^{}]*overflow-wrap:\s*anywhere[^{}]*\}/g)]
  .map((m) => m[1].trim().split(/[{}]|\n\s*\n/).pop().trim());

console.log('\n── anywhere-breaking is confined to strings that cannot break at a space');
{
  ok(breakers.length > 0, `found ${breakers.length} rule(s) that set overflow-wrap:anywhere`);
  // .k/.v/.l are short stat labels and figures. Listing them here is what cost them their floor.
  for (const cls of ['.k', '.v', '.l']) {
    const guilty = breakers.filter((sel) => sel.split(',').some((s) => s.trim() === cls || s.trim().endsWith(' ' + cls)));
    ok(guilty.length === 0, `${cls} never gets overflow-wrap:anywhere${guilty.length ? ' — SET BY: ' + guilty.join(' | ') : ''}`);
  }
  // A blanket descendant selector sweeps the stat cells back in through the side door.
  const blanket = breakers.filter((sel) => /\*\s*$/.test(sel.trim()) || /\s\*(,|$)/.test(sel));
  ok(blanket.length === 0, `no blanket "* " selector turns it on${blanket.length ? ' — FOUND: ' + blanket.join(' | ') : ''}`);
  // It still has to be ON where it is actually needed, or addresses overflow again.
  ok(breakers.some((s) => /\.mono|\.ca\b/.test(s)), 'it IS still applied to .mono / .ca, where unbreakable strings live');
}

console.log('\n── the stat cells keep a floor and the row wraps rather than crushing');
{
  ok(/\.k,\.v,\.l\{min-width:0\}/.test(css), '.k/.v/.l are explicitly allowed to shrink to their content, no further');
  ok(/\.king \.kp\{flex-wrap:wrap/.test(css), 'the King stat row wraps on a phone instead of staying one line');
  ok(/\.king \.kp>\*\{min-width:8\dpx/.test(css), 'and each stat has a minimum width flex cannot shave past');
}

console.log('\n── every CSS variable that is used is actually defined');
{
  // ⛔ THE BUG: `var(--fg)` appeared in 13 declarations and was NEVER defined anywhere.
  // An undefined custom property makes the declaration invalid at computed-value time, which for an
  // INHERITED property means `inherit`. In HTML that hides the fault — `color` inherits something
  // sensible from an ancestor — so twelve of those sites merely looked right by accident. In SVG it
  // is fatal: `fill` inherits from the <svg>, whose initial value is BLACK, so the wordmark in the
  // middle of the flywheel rendered black on a black wheel. Nothing warns; it just is not there.
  const defined = new Set([...code.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...code.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((v) => !defined.has(v));
  ok(defined.size > 10, `the stylesheet defines ${defined.size} custom properties`);
  ok(missing.length === 0, `every var() refers to one that exists${missing.length ? ' — UNDEFINED: ' + missing.join(', ') : ''}`);
  // The two SVG sites specifically, because they are the ones that fail silently and invisibly.
  ok(/\.fw-mid\{fill:var\(--text\)/.test(code), 'the flywheel wordmark uses a defined colour');
  ok(/\.fw-v\{fill:var\(--text\)/.test(code), 'and so do the flywheel figures');
}

console.log('\n── a grid track cannot be blown out by one wide child');
{
  // ⛔ `1fr` MEANS `minmax(auto, 1fr)`, and `auto` floors at MIN-CONTENT — so one wide child makes
  // the whole track wider than its container. `.hero` is `overflow:hidden`, so the h1 rendered 484px
  // inside a 343px section and "Trade." was simply cut off the right edge on every phone. The rest
  // of this stylesheet already uses minmax(0,1fr) for exactly this reason.
  const mobile = /@media \(max-width:1100px\)\{([\s\S]*?)\n\}/.exec(code)?.[1] || '';
  ok(mobile.length > 0, 'the narrow-viewport block is found');
  const bad = [...mobile.matchAll(/([.#][\w-]+)\{[^}]*grid-template-columns:\s*1fr[;}]/g)].map((m) => m[1]);
  ok(bad.length === 0, `no narrow-viewport grid collapses to a bare 1fr${bad.length ? ' — FOUND: ' + bad.join(', ') : ''}`);
  ok(/\.hero\{grid-template-columns:minmax\(0,1fr\)\}/.test(code), 'the hero track can shrink below its content');
}

console.log('\n── the pair tabs are sized by their labels');
{
  const rule = /#ctabs button\{([^}]*)\}/.exec(css)?.[1] || '';
  ok(rule.length > 0, '#ctabs button rule is found');
  ok(/min-width:max-content/.test(rule), 'each tab is at least as wide as its own label');
  ok(!/flex:1 1 0\b/.test(rule), 'tabs no longer take an equal share regardless of label length');
  ok(/#ctabs\{[^}]*flex-wrap:wrap/.test(css), 'and the row wraps to a second line rather than spilling');
  // 10px type was the floor the old approach had already hit; the fix must not reintroduce it.
  const fs2 = /font-size:(\d+(?:\.\d+)?)px/.exec(rule);
  ok(fs2 && Number(fs2[1]) >= 11.5, `label type is legible (${fs2 ? fs2[1] : '?'}px, was clamped down to 10.9px)`);
}

// ⛔ THE SQUEEZED CARD JULZ KEPT REPORTING, and why it never reproduced on desktop: the rule lives
// inside a max-width media query. A coin card IS an <a href="/t/...">, and the Discover grid is a
// div directly following a .sec heading, so `.sec+div a[href^="/t/"]` — written to give small,
// NESTED $TICKER and wallet links a finger-sized tap target — matched every card on the front page
// and set it to display:inline-flex. .top, .meta and .kpi then laid out side by side instead of
// stacked, squeezing the name column to ~42px and setting the creator line one character per line.
console.log('\n── the mobile tap-target rule cannot swallow a whole card');
{
  const rule = /a\.w,[^{]*\{[^}]*inline-flex[^}]*\}/.exec(css);
  ok(!!rule, 'the nested-link tap-target rule is still there');
  const sel = rule ? rule[0].slice(0, rule[0].indexOf('{')) : '';
  for (const part of sel.split(',').map((x) => x.trim()).filter((x) => /a\[href/.test(x))) {
    ok(/:not\(\.card\)/.test(part), `"${part}" excludes .card`);
  }
}

// ⛔ The second, independent cause. `.spark` is absolute, so `.card.has-spark .top` reserves 80px of
// padding-right. That is a FIXED cost against a shrinking card: the text column is
// card − 28 − 80 − 56 − 12, which reaches ~42px near a 220px card — a phone in split screen. The
// sparkline is dropped below that width so the row comes back.
console.log('\n── a very narrow card keeps its text instead of its sparkline');
{
  const m = /@media\s*\(max-width:\s*380px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  ok(!!m, 'there is a narrow-width block for the card');
  const body = m ? m[1] : '';
  ok(/\.card .spark\s*\{[^}]*display:\s*none/.test(body), 'the sparkline is hidden there');
  ok(/\.card\.has-spark .top\s*\{[^}]*padding-right:\s*0/.test(body), 'and its 80px reservation is released');
}

// The buyback-and-burn panel (Elio, 5 Oct: "bigger and more easy to read and big flames").
console.log('\n── the burn panel: the bar exists and every ember has a lane');
{
  const pages = fs.readFileSync('public/pages.js', 'utf8');
  // ⛔ .prog sets a height but never a display. On /rewards it happens to be a <div>; in this panel
  // it is a <span> inside an <a>, so it was INLINE — height and the fill's width had nothing to
  // apply to and the bar rendered as nothing at all. Both labels still appeared, which made it read
  // as a spacing problem rather than a missing element.
  ok(/\.prog\.burnbar\.big\{[^}]*display:\s*block/.test(css),
    'the pot bar is display:block, so a <span> still draws it');
  ok(!/\.prog\{[^}]*display:/.test(css), 'base .prog still sets no display (that is why the above is needed)');

  // ⛔ `left` has no default, so an ember without its own rule inherits auto and rises from the same
  // point as every other one — a single thick column of particles rather than a fire. The count in
  // pages.js and the number of lanes in the CSS have to move together.
  const rep = /'<b><\/b>'\.repeat\((\d+)\)/.exec(pages);
  ok(!!rep, 'the panel renders a known number of embers');
  const n = rep ? Number(rep[1]) : 0;
  const lanes = new Set([...css.matchAll(/\.bs-fire b:nth-child\((\d+)\)\{[^}]*left:/g)].map((m) => Number(m[1])));
  const missing = [];
  for (let i = 1; i <= n; i++) if (!lanes.has(i)) missing.push(i);
  ok(missing.length === 0, `all ${n} embers have their own lane${missing.length ? ' — missing ' + missing.join(',') : ''}`);

  // Text that sits ON the flames has to survive them — turning the fire up once made the ledger
  // link unreadable, trading away the "easier to read" half of the same request.
  ok(/\.bh-go\{[^}]*color:\s*#fff/.test(css) && /\.bh-go\{[^}]*text-shadow/.test(css),
    'the ledger link is white with a shadow, not dim orange on bright orange');
  ok(/\.bh-pot \.prog-l\{[^}]*color:\s*#fff/.test(css), 'and so are the pot labels');
}

console.log('\n── no horizontal strip may push the page sideways');
{
  // ⛔ MEASURED ON A PHONE, NOT GUESSED: six tabs on a coin page come to 485px inside a 257px panel.
  // With `nowrap` and the default `overflow-x: visible` that is not a strip that is too small — it
  // is a document 553px wide in a 375px viewport, with Payouts and Info hanging in open space
  // outside the panel. Julz circled exactly those two and wrote "screen moves and look these words
  // are out there"; Elio sent the same screenshot again the next morning.
  //
  // The rule for any single-line strip of controls: it SCROLLS. Not visible (the page moves) and
  // not hidden (the last tabs become unreachable, which is worse than ugly).
  const rule = (sel) => {
    const m = code.match(new RegExp('(^|[,}])\\s*' + sel.replace(/[.#]/g, '\\$&') + '\\s*\\{([^{}]*)\\}'));
    return m ? m[2] : '';
  };
  const strip = rule('.side-tabs');
  ok(/display:\s*flex/.test(strip), '.side-tabs is still the flex strip this is about');
  ok(/overflow-x:\s*auto/.test(strip), '.side-tabs scrolls horizontally rather than overflowing the panel');
  ok(!/overflow-x:\s*(visible|hidden)/.test(strip), '.side-tabs is neither visible (page moves) nor hidden (tabs unreachable)');
  // `overflow-x:auto` makes the Y axis a scroll box too, which clips the active tab's underline
  // where it sits on the strip's own border unless something gives it the pixel back.
  ok(/padding-bottom:\s*1px/.test(strip), 'and it keeps a pixel of padding so the active underline is not clipped');
  const btn = rule('.side-tabs button');
  ok(/flex:\s*none/.test(btn), 'each tab keeps its natural width instead of six labels sharing 257px');
  ok(/white-space:\s*nowrap/.test(btn), 'and a tab label never wraps to two lines');

  // The trades table under those tabs was NOT at fault and must stay the way it is.
  ok(/main table\{[^}]*overflow-x:auto/.test(css), 'a wide table still scrolls inside itself, not on the page');
}

console.log('\n── a box that holds wrapping text may not have a fixed height');
{
  // ⛔ `.opts button{height:40px}` IS A CEILING PRETENDING TO BE A SIZE. The chip grid was built for
  // "Off" and "0.5%", and anything that wraps to a second line spills over the chip below instead of
  // making the row taller. MiKOL screenshotted the rule picker on a phone with "Rising max per
  // wallet" written straight through "Blocklist" — and it was never only that picker: three of the
  // coin chips on /liquidity and several on Advanced were overflowing silently too.
  //
  // A grid row stretches every cell to the tallest in it, so `min-height` gives the same tidy row
  // when everything is short and a taller row when something is not. There is no case where the
  // fixed height was buying anything the minimum does not.
  const rule = (sel) => {
    const m = code.match(new RegExp('(^|[,}])\\s*' + sel.replace(/[.#]/g, '\\$&') + '\\s*\\{([^{}]*)\\}'));
    return m ? m[2] : '';
  };
  for (const sel of ['.opts button', '.opts.tight button']) {
    const r = rule(sel);
    ok(r.length > 0, `${sel} is still the rule this is about`);
    const pinned = /(^|[^-])height:\s*\d+px/.exec(r);
    ok(!pinned, `${sel} does not pin a fixed height${pinned ? ' — FOUND: ' + pinned[0].trim() : ''}`);
    ok(/min-height:\s*\d+px/.test(r), `${sel} keeps a MINIMUM height, so short chips still line up`);
  }
  // And the rules themselves got their own component, because a sentence per option is not a chip.
  ok(/\.rulepick\{/.test(css), 'the transfer rules have a layout built for explanatory text');
  ok(!/class="opts" id="hookPick"/.test(fs.readFileSync('public/pages.js', 'utf8')),
    'and no longer borrow the chip grid');
}

console.log('\n── a coin card is never turned into an inline-flex row, whatever tag it is');
{
  // ⛔ THE SAME BUG, TWICE, FROM OPPOSITE DIRECTIONS. `.sec+div a[href^="/t/"]` below 1100px makes
  // a coin link an inline-flex ROW — which is right for the small $TICKER links nested inside
  // leaderboard rows and catastrophic for the card itself: .top, .meta and .kpi become flex items
  // side by side, the name column collapses to ~42px, and the creator line sets one character per
  // line. Julz reported that card repeatedly and it never reproduced on a desktop.
  //
  // It was fixed with :not(.card) while the card WAS the <a>. The card is now a div with its own
  // stretched <a class="cardlink"> inside — so the href rule reaches the link instead, and the
  // exclusion has to name it. Assert the rule, not the markup: whichever element carries the href,
  // it must be excluded here.
  const sels = [...code.matchAll(/([^{}]*a\[href\^="\/t\/"\][^{}]*)\{([^{}]*)\}/g)];
  ok(sels.length > 0, `found ${sels.length} rule(s) that style coin links by href`);
  for (const [, sel, body] of sels) {
    if (!/inline-flex|display:\s*flex/.test(body)) continue;      // only the ones that re-lay-out
    for (const part of sel.split(',').map((x) => x.trim()).filter((x) => /a\[href\^="\/t\/"\]/.test(x))) {
      ok(/:not\(\.card\)/.test(part), `${part} excludes the card itself`);
      ok(/:not\(\.cardlink\)/.test(part), `${part} excludes the card's own stretched link`);
    }
  }
  // And the socials ON that card ARE standalone targets, unlike the badges beside them.
  const soc = code.match(/@media[^{]*max-width:\s*1100px[^{]*\{[^{}]*\.soc\{([^{}]*)\}/);
  ok(!!soc, 'the card socials get a phone-sized tap target');
  ok(soc && /width:\s*3[0-9]px/.test(soc[1]), `and it is at least 30px (${soc ? soc[1].trim() : 'missing'})`);
  // The badges rely on inheriting it; a div card has to say so where an <a> did not.
  ok(/\.card\{[^{}]*cursor:pointer/.test(code), 'the card still reports itself as clickable, now that it is a div');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
