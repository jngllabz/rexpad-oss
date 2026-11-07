// Effects. Celebration, motion and the small visual payoffs.
//
// Every one of these fires on something that ACTUALLY HAPPENED — a payout that landed in your
// wallet, a coin that cleared the curve, a position that moved up a board. That is not a limitation
// on the fun, it is what makes the fun land: a celebration that fires on nothing teaches people to
// ignore celebrations, and then the real one does not register either. Scarcity is the whole
// mechanism. The burst you see maybe twice a day is the one you remember.
//
// Three rules the whole file obeys:
//
//   1. ONE CANVAS, REUSED, AND IT REMOVES ITSELF. Particles are drawn on a single pointer-events:none
//      canvas that is created on first use and torn down when the last particle dies. A celebration
//      that leaves a full-screen element behind is a celebration that breaks every click after it.
//   2. prefers-reduced-motion IS HONOURED, NOT NEGOTIATED. Motion sickness and vestibular disorders
//      are real, and the person who set that flag set it on purpose. They still get the event — the
//      toast, the number, the colour — they just do not get it thrown across the screen.
//   3. NOTHING BLOCKS. Every effect is fire-and-forget and swallows its own errors. A burst that
//      throws must not take down the payout handler it was decorating.

const REDUCED = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

let cv = null, ctx = null, parts = [], raf = 0;

function surface() {
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.className = 'fx-canvas';
  cv.width = innerWidth * devicePixelRatio;
  cv.height = innerHeight * devicePixelRatio;
  cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:95';
  document.body.appendChild(cv);
  ctx = cv.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);
  return cv;
}

function teardown() {
  cancelAnimationFrame(raf); raf = 0;
  cv?.remove(); cv = null; ctx = null; parts = [];
}

function tick() {
  if (!ctx) return;
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const g = 0.38;
  parts = parts.filter((p) => {
    p.vy += g; p.x += p.vx; p.y += p.vy; p.vx *= 0.995; p.life -= 1; p.rot += p.spin;
    if (p.life <= 0 || p.y > innerHeight + 40) return false;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 34));
    ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.fillStyle = p.c;
    // Mixed shapes read as confetti; one shape reads as a bug in a particle system.
    if (p.shape === 0) ctx.fillRect(-p.r, -p.r * 0.45, p.r * 2, p.r * 0.9);
    else if (p.shape === 1) { ctx.beginPath(); ctx.arc(0, 0, p.r * 0.75, 0, 7); ctx.fill(); }
    else { ctx.beginPath(); ctx.moveTo(0, -p.r); ctx.lineTo(p.r, 0); ctx.lineTo(0, p.r); ctx.lineTo(-p.r, 0); ctx.closePath(); ctx.fill(); }
    ctx.restore();
    return true;
  });
  if (!parts.length) return teardown();
  raf = requestAnimationFrame(tick);
}

const GREENS = ['#22c55e', '#3dffa0', '#9dff8f', '#ffc24d', '#e7f7ec'];

/**
 * A burst of particles from a point, or from an element's centre.
 *
 * Deliberately NOT full-screen confetti by default: a burst that comes out of the thing that
 * changed tells you WHERE to look, which a screen-wide shower does not.
 */
export function burst(target, { count = 26, spread = 3.4, power = 9, colors = GREENS } = {}) {
  try {
    if (REDUCED()) return;
    let x = innerWidth / 2, y = innerHeight / 3;
    if (target instanceof Element) {
      const r = target.getBoundingClientRect();
      if (!r.width && !r.height) return;
      x = r.left + r.width / 2; y = r.top + r.height / 2;
    } else if (target && typeof target === 'object') { x = target.x ?? x; y = target.y ?? y; }
    surface();
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * spread;
      const v = power * (0.45 + Math.random() * 0.8);
      parts.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        r: 2.4 + Math.random() * 3.4, c: colors[(Math.random() * colors.length) | 0],
        life: 42 + Math.random() * 34, rot: Math.random() * 6.3, spin: (Math.random() - 0.5) * 0.3,
        shape: (Math.random() * 3) | 0,
      });
    }
    if (!raf) raf = requestAnimationFrame(tick);
  } catch { /* an effect must never take down the thing it decorates */ }
}

/** The big one. Reserved for events that happen to YOU — a payout, a graduation you caused. */
export function celebrate(colors = GREENS) {
  try {
    if (REDUCED()) return;
    const n = 3;
    for (let i = 0; i < n; i++) {
      setTimeout(() => burst({ x: innerWidth * (0.2 + 0.3 * i), y: innerHeight * 0.62 },
        { count: 30, spread: 2.2, power: 15, colors }), i * 110);
    }
  } catch { /* ignore */ }
}

/**
 * Roll a number to a new value instead of snapping to it.
 *
 * The roll is what makes a figure feel live. It is capped at 900ms because past about a second the
 * eye stops reading it as "counting" and starts reading it as "slow", and a reader who is waiting
 * for a number to settle before they can act is a reader the animation is working against.
 */
export function countTo(el, to, { from = null, ms = 700, fmt = (n) => Math.round(n).toLocaleString() } = {}) {
  try {
    if (!el) return;
    // ?? and || cannot be mixed without parentheses — the parser rejects it outright.
    const read = Number(String(el.dataset.v ?? el.textContent).replace(/[^0-9.-]/g, ''));
    const start = from ?? (Number.isFinite(read) ? read : 0);
    el.dataset.v = String(to);
    if (REDUCED() || !Number.isFinite(start) || start === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now(); const dur = Math.min(900, ms);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      // easeOutCubic: fast enough to feel responsive, settles rather than stops dead.
      el.textContent = fmt(start + (to - start) * (1 - (1 - k) ** 3));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  } catch { if (el) el.textContent = String(to); }
}

/** A one-shot ring pulsing out of an element. Cheap, and it survives reduced-motion as a fade. */
export function pulse(el, cls = '') {
  try {
    if (!(el instanceof Element)) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const d = document.createElement('span');
    d.className = `fx-pulse ${cls}`;
    d.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px`;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 900);
  } catch { /* ignore */ }
}

/** Flash an element's background once — used when a row's underlying number changed. */
export function flash(el, cls = 'fx-flash') {
  try {
    if (!(el instanceof Element)) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 1600);
  } catch { /* ignore */ }
}

addEventListener('resize', () => { if (cv) { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; ctx.scale(devicePixelRatio, devicePixelRatio); } });
// A tab that is hidden should not be animating, and should not come back owing a second of frames.
document.addEventListener('visibilitychange', () => { if (document.hidden && parts.length) teardown(); });
