// The REX Chain icon set.
//
// Every emoji on the site is replaced from here. An emoji is not a design decision — it is a
// *request* to the operating system, and each one answers differently: 🦖 is a cartoon on Android,
// a different cartoon on Windows and a third on a Mac, none of them ours, none of them the right
// green, and all of them full-colour against a dark interface that is otherwise two greens and a
// grey. They also sit on their own baseline, so a chip reading "🦖 Pays 2%" is vertically wrong on
// at least one platform no matter what we do to it.
//
// These are drawn on one 24-grid with one stroke weight, they inherit `currentColor`, and they take
// the same optical size everywhere. That last part is what makes a set feel crafted rather than
// collected: an icon beside 13px text and the same icon in a 30px heading must read as the same
// weight, which is why the stroke is specified here and never overridden per use.
//
// Filled accents are deliberate and sparing — the gem's facets, the flame's core, the crown's
// points. Line icons everywhere plus a solid shape where the meaning lives is what separates a
// drawn set from a traced one.
//
// `currentColor` also means they ANIMATE: a flame in a burn toast can pulse by animating colour,
// and a gem on a payout can flash gold, with no second asset and no sprite sheet.

const P = {
  // Brand. A dinosaur head in profile — jaw, brow, eye, the one tooth that reads at 14px.
  // Rewards. Facets filled so it still reads as a gem when it is 12px tall.
  gem: '<path d="M7.2 4h9.6l3.4 5-8.2 10.6L3.8 9z"/><path d="m3.8 9h16.4M9.1 9 12 19.6 14.9 9M7.2 4 9.1 9M16.8 4 14.9 9" stroke-width="1.25"/><path d="M9.1 9h5.8L12 19.6z" fill="currentColor" fill-opacity=".18" stroke="none"/>',
  // Burn. Outer tongue plus a solid core, so a 12px flame is not a hollow outline.
  flame: '<path d="M12.6 2.3c2.5 3.3 1 5.1 2.7 7 1.4 1.5 3 3 3 5.7a6.3 6.3 0 0 1-12.6 0c0-2 .8-3.6 2-4.9.4 1 1.2 1.6 2 1.6 1.7 0 1.6-2 1-3.9-.6-2.1.5-4.2 1.9-5.5z"/><path d="M12 13.1c1.6 1.4 2.4 2.5 2.4 3.8a2.4 2.4 0 0 1-4.8 0c0-1.3.8-2.4 2.4-3.8z" fill="currentColor" stroke="none"/>',
  link: '<path d="M10.3 13.7a3.6 3.6 0 0 0 5.1 0l2.9-2.9a3.6 3.6 0 1 0-5.1-5.1l-1.4 1.4"/><path d="M13.7 10.3a3.6 3.6 0 0 0-5.1 0l-2.9 2.9a3.6 3.6 0 1 0 5.1 5.1l1.4-1.4"/>',
  // Graduated — a mortarboard, for a coin that has cleared the curve.
  cap: '<path d="M2.6 8.6 12 4.4l9.4 4.2L12 12.8z"/><path d="M6.4 10.5v4.9c0 1.9 2.5 3.4 5.6 3.4s5.6-1.5 5.6-3.4v-4.9M20.6 9v5.2" stroke-width="1.5"/>',
  crown: '<path d="M3.4 8.2 6.9 12l3.4-5.6a2 2 0 0 1 3.4 0L17.1 12l3.5-3.8 1 10a1.4 1.4 0 0 1-1.4 1.5H3.8a1.4 1.4 0 0 1-1.4-1.5z"/><path d="M3.1 16.6h17.8" stroke-width="1.3"/>',
  bolt: '<path d="M13.4 2.6 5.2 13.1a.6.6 0 0 0 .5 1h4.6l-.7 7.3 8.2-10.5a.6.6 0 0 0-.5-1h-4.6z" fill="currentColor" fill-opacity=".16"/>',
  trophy: '<path d="M8 4h8v5.4a4 4 0 0 1-8 0z"/><path d="M8 5.4H5.6a2.4 2.4 0 0 0 2.4 4M16 5.4h2.4a2.4 2.4 0 0 1-2.4 4" stroke-width="1.4"/><path d="M12 13.4v3.4M8.6 20.4h6.8l-.7-3.6H9.3z"/>',
  bot: '<rect x="3.6" y="7.8" width="16.8" height="12.2" rx="3.2"/><path d="M12 7.8V4.4M12 3a1.4 1.4 0 1 1 0 .01" stroke-width="1.4"/><circle cx="8.6" cy="13.4" r="1.25" fill="currentColor" stroke="none"/><circle cx="15.4" cy="13.4" r="1.25" fill="currentColor" stroke="none"/><path d="M9.4 16.8h5.2" stroke-width="1.4"/>',
  flask: '<path d="M9.4 3.2h5.2M10.4 3.2v6L5.1 18a2.6 2.6 0 0 0 2.2 3.9h9.4a2.6 2.6 0 0 0 2.2-3.9l-5.3-8.8v-6"/><path d="M7.6 14.6h8.8" stroke-width="1.3"/>',
  sparkle: '<path d="M12 3.2 13.7 9l5.8 1.7-5.8 1.7-1.7 5.8-1.7-5.8L4.5 10.7 10.3 9z" fill="currentColor" fill-opacity=".16"/><path d="M18.8 16.4l.7 2.2 2.2.7-2.2.7-.7 2.2-.7-2.2-2.2-.7 2.2-.7z" stroke-width="1.2"/>',
  chart: '<path d="M3.6 20.4h16.8" stroke-width="1.5"/><rect x="5" y="12.4" width="3.4" height="6" rx="1"/><rect x="10.3" y="7.6" width="3.4" height="10.8" rx="1"/><rect x="15.6" y="10" width="3.4" height="8.4" rx="1"/>',
  vault: '<rect x="3.2" y="4.4" width="17.6" height="15.2" rx="2.6"/><circle cx="12" cy="12" r="4.1"/><path d="M12 7.9v1.4M12 14.7v1.4M7.9 12h1.4M14.7 12h1.4" stroke-width="1.3"/>',
  megaphone: '<path d="M4 10.2v3.6a1.8 1.8 0 0 0 1.8 1.8h2L15 20V4L7.8 8.4h-2A1.8 1.8 0 0 0 4 10.2z"/><path d="M18.2 9.1a4 4 0 0 1 0 5.8M20.4 6.6a7.4 7.4 0 0 1 0 10.8" stroke-width="1.4"/>',
  globe: '<circle cx="12" cy="12" r="8.6"/><path d="M3.6 12h16.8" stroke-width="1.3"/><path d="M12 3.4c2.2 2.3 3.4 5.3 3.4 8.6s-1.2 6.3-3.4 8.6c-2.2-2.3-3.4-5.3-3.4-8.6S9.8 5.7 12 3.4z" stroke-width="1.3"/>',
  send: '<path d="M21 3.4 2.9 11.2l6.9 2.3 2.3 6.9z"/><path d="m9.8 13.5 4.6-4.6" stroke-width="1.3"/>',
  image: '<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.6"/><circle cx="8.8" cy="10" r="1.6"/><path d="m3.6 16.6 4.6-4a2 2 0 0 1 2.6 0l4 3.6M14.4 14.2l1.8-1.6a2 2 0 0 1 2.6 0l1.6 1.4" stroke-width="1.4"/>',
  user: '<circle cx="12" cy="8.2" r="3.8"/><path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0"/>',
  puzzle: '<path d="M14.3 4.4h5.3v5.3h-1.4a1.9 1.9 0 1 0 0 3.8h1.4v5.3h-5.3v-1.4a1.9 1.9 0 1 0-3.8 0v1.4H4.4V14h1.4a1.9 1.9 0 1 0 0-3.8H4.4V4.4h6.1v1.4a1.9 1.9 0 1 0 3.8 0z"/>',
  flag: '<path d="M5.4 21V3.6"/><path d="M5.4 4.6h11.9l-1.7 3.9 1.7 3.9H5.4z" fill="currentColor" fill-opacity=".14"/>',
  medal: '<circle cx="12" cy="15.2" r="5.4"/><path d="M12 12.6l1 2 2.2.3-1.6 1.6.4 2.2-2-1-2 1 .4-2.2-1.6-1.6 2.2-.3z" fill="currentColor" stroke="none"/><path d="M8.2 10.1 5.8 3.4h4.3L12 7.2M15.8 10.1l2.4-6.7h-4.3" stroke-width="1.4"/>',
  gift: '<rect x="3.4" y="9.4" width="17.2" height="4.2" rx="1.2"/><path d="M4.8 13.6v5.6a1.6 1.6 0 0 0 1.6 1.6h11.2a1.6 1.6 0 0 0 1.6-1.6v-5.6M12 9.4v11.4" stroke-width="1.4"/><path d="M12 9.4S10.8 3.6 8.2 3.6a2.6 2.6 0 0 0 0 5.8zM12 9.4s1.2-5.8 3.8-5.8a2.6 2.6 0 0 1 0 5.8z"/>',
  // Fair Open. Scales — equal arms, because that is the whole claim.
  scales: '<path d="M12 4v16M7.6 20.4h8.8M4.2 8.2h15.6M12 4a1.1 1.1 0 1 1 0 .01" stroke-width="1.5"/><path d="M4.2 8.2 1.8 14a2.9 2.9 0 0 0 4.8 0zM19.8 8.2 17.4 14a2.9 2.9 0 0 0 4.8 0z"/>',
  warn: '<path d="M10.6 3.9 2.3 18.2a1.6 1.6 0 0 0 1.4 2.4h16.6a1.6 1.6 0 0 0 1.4-2.4L13.4 3.9a1.6 1.6 0 0 0-2.8 0z"/><path d="M12 9.4v4.6" stroke-width="1.6"/><circle cx="12" cy="17.2" r="1.05" fill="currentColor" stroke="none"/>',
  block: '<circle cx="12" cy="12" r="8.6"/><path d="m6 6 12 12" stroke-width="1.6"/>',
  // Chrome.
  out: '<path d="M8.4 15.6 15.6 8.4M9.6 8.4h6v6" stroke-width="1.7"/>',
  sort: '<path d="M8.4 9.6 12 6l3.6 3.6M8.4 14.4 12 18l3.6-3.6" stroke-width="1.6"/>',
  check: '<path d="m4.8 12.6 4.8 4.8L19.2 7.2" stroke-width="2"/>',
  fire: null, // alias filled below
};
P.fire = P.flame;

/**
 * One icon, inline, sized to the text it sits beside.
 *
 * `em` sizing rather than pixels is the whole trick: an icon in a 13px chip and the same icon in a
 * 30px heading come out proportional without a single per-use override, which is what stops a set
 * drifting back into a pile of one-off sizes.
 */
export function icon(name, cls = '') {
  // ⛔ THE BRAND MARK IS NOT DRAWN HERE, AND THAT IS THE RIGHT ANSWER RATHER THAN A SHORTCUT.
  // Three hand-drawn dinosaur heads — two line, one filled — all read as "some animal" at 14px.
  // An outline spends its whole weight on the silhouette and has none left for the snout, the jaw
  // and the teeth, which are the only marks that say dinosaur; filled, the features close up. REX
  // already HAS a bespoke dinosaur, drawn properly, in public/brand — so the mark is that artwork,
  // not my approximation of it. It is the one icon that does not inherit currentColor, which is
  // correct for a logo and wrong for everything else in this file.
  if (name === 'rex') return `<img class="ic ic-brand ${cls}" src="/brand/rex-glyph.png?v=2" alt="" aria-hidden="true">`;
  const d = P[name];
  if (!d) return '';
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"`
    + ` fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

/** Every name, for anything that wants to enumerate them (the style page, tests). */
export const ICON_NAMES = ['rex', ...Object.keys(P).filter((k) => P[k] && k !== 'fire')];
export default icon;
