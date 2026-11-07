// Recipes — when this, then that.
//
// Fco, 4 Oct: "This would be a cool feature also recipes." A launcher wires a trigger to conditions
// and actions, and their fees do exactly that, checked on a schedule. Programs are the presets;
// recipes are the building blocks underneath them.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT A RECIPE CANNOT DO, which matters far more than what it can.
//
// A recipe is written by a launcher — a stranger — and then runs unattended against real money
// every minute. So the action set is deliberately small and every action is bounded:
//
//   · A recipe only ever moves the launcher's OWN buckets. It cannot touch REX Chain's cut, and
//     there is no action that can: `REX_LOCKED` is enforced in `apply()`, not merely by omission
//     from the action list, so adding an action later cannot accidentally open it. Fco's
//     "as long they make us fees and burn always" is a property of the code, not of the defaults.
//   · No action names a destination. Every recipient comes from the launch's stored config, so a
//     recipe can change proportions and timing and nothing else.
//   · Every weight is clamped to the launcher's configured ceilings and renormalised, exactly as
//     the AI allocator is. A recipe is simply a deterministic author of the same bounded proposal.
//   · Triggers read numbers. No trigger reads a token's name, description or any other text a
//     stranger controls, so there is nothing to inject into.
//
// The worst a hostile or nonsensical recipe can do is choose a legal split, at a legal moment,
// between buckets its author already opened. That is the whole safety argument.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import { db } from './db.mjs';
import { log, warn } from './config.mjs';
import { enforce } from './ai_alloc.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS recipes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT, name TEXT, spec TEXT,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER, last_fired_at INTEGER, fire_count INTEGER DEFAULT 0
)`);
db.exec('CREATE INDEX IF NOT EXISTS recipes_mint ON recipes(mint, enabled)');
db.exec(`CREATE TABLE IF NOT EXISTS recipe_fires(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER, mint TEXT, ts INTEGER,
  trigger TEXT, applied TEXT, snapshot TEXT
)`);

/** ⛔ REX Chain's own cut. No recipe, program or model can move this. Enforced in apply(). */
export const REX_LOCKED = true;

/**
 * The triggers. Each is a pure predicate over a numeric snapshot — no text, no side effects.
 *
 * `key` is what a recipe stores. `test` decides. Adding one here is the only way to add one at all.
 */
export const TRIGGERS = {
  price_up:        { label: 'Price rises',        unit: '%',   test: (s, v) => s.priceChange1h >= v },
  price_down:      { label: 'Price falls',        unit: '%',   test: (s, v) => s.priceChange1h <= -Math.abs(v) },
  price_up_24h:    { label: 'Price rises (24h)',  unit: '%',   test: (s, v) => s.priceChange24h >= v },
  price_down_24h:  { label: 'Price falls (24h)',  unit: '%',   test: (s, v) => s.priceChange24h <= -Math.abs(v) },
  mcap_above:      { label: 'Market cap above',   unit: '$',   test: (s, v) => s.marketCapUsd >= v },
  mcap_below:      { label: 'Market cap below',   unit: '$',   test: (s, v) => s.marketCapUsd > 0 && s.marketCapUsd <= v },
  volume_above:    { label: '24h volume above',   unit: '$',   test: (s, v) => s.volume24hUsd >= v },
  volume_below:    { label: '24h volume below',   unit: '$',   test: (s, v) => s.volume24hUsd <= v },
  fees_above:      { label: 'Unclaimed fees above', unit: '$', test: (s, v) => s.unclaimedFeeUsd >= v },
  holders_above:   { label: 'Holders above',      unit: '',    test: (s, v) => s.holders >= v },
  holders_below:   { label: 'Holders below',      unit: '',    test: (s, v) => s.holders <= v },
  liquidity_below: { label: 'Liquidity below',    unit: '$',   test: (s, v) => s.liquidityUsd > 0 && s.liquidityUsd <= v },
  hours_since:     { label: 'Hours since launch', unit: 'h',   test: (s, v) => s.hoursSinceLaunch >= v },
};

/**
 * The actions. Every one is a WEIGHTING, never a transfer.
 *
 * An action says "send this hour's fees mostly to burn"; it never says "send 5 SOL to this address".
 * That distinction is why a recipe cannot steal: the only thing it authors is a split, and the split
 * is then clamped to the launcher's caps and paid to the launch's own configured recipients.
 */
export const ACTIONS = {
  burn:        { label: 'Burn it',            weights: { burn: 1, buyback: 1 } },
  pay_holders: { label: 'Pay holders',        weights: { holder: 1 } },
  buy_back:    { label: 'Buy back and hold',  weights: { buyback: 1 } },
  to_vault:    { label: 'Add to the vault',   weights: { vault: 1 } },
  balanced:    { label: 'Split evenly',       weights: { holder: 1, burn: 1, vault: 1, buyback: 1 } },
  hold_fees:   { label: 'Save the fees',      weights: {} },   // accumulate: nothing is paid out
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Validate a recipe before it is ever stored.
 *
 * Returns `{ ok, recipe, error }` and never throws. Everything unrecognised is REJECTED rather than
 * coerced — this is the boundary where a stranger's JSON becomes something that runs unattended
 * against money, and silently "fixing" a malformed rule is how you end up running a rule nobody
 * wrote.
 */
export function validate(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, error: 'a recipe must be an object' };
  const name = String(spec.name || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 48);
  if (name.length < 2) return { ok: false, error: 'give the recipe a name' };

  const when = spec.when || {};
  if (!TRIGGERS[when.trigger]) return { ok: false, error: `unknown trigger "${String(when.trigger).slice(0, 24)}"` };
  const value = num(when.value);

  const then = Array.isArray(spec.then) ? spec.then : [spec.then];
  const actions = then.filter(Boolean).map((a) => String(a?.action ?? a)).filter((a) => ACTIONS[a]);
  if (!actions.length) return { ok: false, error: 'a recipe needs at least one action we recognise' };
  if (actions.length > 4) return { ok: false, error: 'at most four actions' };

  // Conditions are ANDed with the trigger. Each is itself a trigger test, which keeps the surface
  // to one validated vocabulary rather than two.
  const ifs = (Array.isArray(spec.if) ? spec.if : []).slice(0, 3)
    .filter((c) => TRIGGERS[c?.trigger])
    .map((c) => ({ trigger: c.trigger, value: num(c.value) }));

  // A recipe that can fire every minute forever is a recipe that spends its fees on signatures.
  const cooldownMins = Math.max(5, Math.min(10_080, Math.round(num(spec.cooldownMins) || 60)));

  return { ok: true, recipe: { name, when: { trigger: when.trigger, value }, if: ifs, then: actions, cooldownMins } };
}

/** Does this recipe's trigger and every condition hold right now? */
export function matches(recipe, snap) {
  const t = TRIGGERS[recipe.when.trigger];
  if (!t || !t.test(snap, recipe.when.value)) return false;
  return recipe.if.every((c) => TRIGGERS[c.trigger]?.test(snap, c.value));
}

/**
 * Turn a matched recipe into a bounded split.
 *
 * ⛔ REX Chain's share is re-imposed AFTER the recipe's weights, not merged with them. A recipe
 * cannot reduce it, cannot name it, and cannot reach it by summing to something clever — which is
 * what makes "they make us fees and burn always" a property of the code rather than of the defaults
 * somebody might change later.
 */
export function apply(recipe, caps) {
  const merged = {};
  for (const a of recipe.then) {
    for (const [k, w] of Object.entries(ACTIONS[a]?.weights || {})) merged[k] = (merged[k] || 0) + w;
  }
  // 'hold_fees' alone produces no weights: nothing is paid out this round and the fees accumulate.
  if (!Object.keys(merged).length) return { bps: Object.fromEntries(Object.keys(caps).map((k) => [k, 0])), accumulate: true };

  // The launcher's buckets only. REX's is removed before the recipe's weights are applied, then
  // restored at its configured share, so no recipe arithmetic can touch it.
  const launcherCaps = { ...caps };
  const rexCap = launcherCaps.rex ?? 0;
  delete launcherCaps.rex;

  const split = enforce(merged, launcherCaps);
  const rexBps = Math.round((rexCap / (Object.values(caps).reduce((a, b) => a + b, 0) || 1)) * 10_000);
  const room = Math.max(0, 10_000 - rexBps);

  const bps = { rex: rexBps };
  let used = 0;
  const keys = Object.keys(launcherCaps);
  for (const k of keys) { bps[k] = Math.floor((split.bps[k] || 0) * room / 10_000); used += bps[k]; }
  // Rounding slack goes to the largest launcher bucket — never to REX, which would quietly inflate
  // our own cut on every run.
  const slack = room - used;
  if (slack !== 0 && keys.length) {
    const biggest = keys.reduce((a, b) => (bps[b] > bps[a] ? b : a), keys[0]);
    bps[biggest] += slack;
  }
  return { bps, accumulate: false };
}

// ---------------------------------------------------------------- storage
export function save(mint, spec) {
  const v = validate(spec);
  if (!v.ok) return v;
  const n = db.prepare('SELECT COUNT(*) n FROM recipes WHERE mint=?').get(mint)?.n || 0;
  if (n >= 10) return { ok: false, error: 'at most ten recipes per launch' };
  const r = db.prepare('INSERT INTO recipes(mint,name,spec,enabled,created_at) VALUES(?,?,?,1,?)')
    .run(mint, v.recipe.name, JSON.stringify(v.recipe), Date.now());
  return { ok: true, id: r.lastInsertRowid, recipe: v.recipe };
}

// ORDER BY created_at, id — not created_at alone. Two recipes saved in the same millisecond tie on
// the timestamp, and a tie makes which one wins non-deterministic. Since `evaluate` deliberately
// fires only the FIRST match, a non-deterministic order means the same launch with the same market
// can split its fees two different ways on two different runs.
export const list = (mint) => db.prepare('SELECT * FROM recipes WHERE mint=? ORDER BY created_at, id').all(mint)
  .map((r) => ({ id: r.id, name: r.name, enabled: !!r.enabled, firedCount: r.fire_count,
    lastFiredAt: r.last_fired_at, ...JSON.parse(r.spec) }));

export const setEnabled = (id, mint, on) =>
  db.prepare('UPDATE recipes SET enabled=? WHERE id=? AND mint=?').run(on ? 1 : 0, id, mint).changes > 0;
export const remove = (id, mint) => db.prepare('DELETE FROM recipes WHERE id=? AND mint=?').run(id, mint).changes > 0;

/**
 * Evaluate every enabled recipe for one launch and return the first that fires.
 *
 * FIRST, not all. Two recipes that both match would otherwise each author a full split of the same
 * money, and the second would silently overwrite the first. Order is creation order, so the
 * launcher's own list is the priority, which is the one ordering they can see and reason about.
 */
export function evaluate(mint, snap, caps, now = Date.now()) {
  for (const r of list(mint)) {
    if (!r.enabled) continue;
    if (r.lastFiredAt && now - r.lastFiredAt < r.cooldownMins * 60_000) continue;
    if (!matches(r, snap)) continue;
    const result = apply(r, caps);
    db.prepare('UPDATE recipes SET last_fired_at=?, fire_count=fire_count+1 WHERE id=?').run(now, r.id);
    db.prepare('INSERT INTO recipe_fires(recipe_id,mint,ts,trigger,applied,snapshot) VALUES(?,?,?,?,?,?)')
      .run(r.id, mint, now, `${r.when.trigger} ${r.when.value}`, JSON.stringify(result.bps), JSON.stringify(snap));
    log('🧪 recipe', r.name, 'fired on', mint.slice(0, 6),
      Object.entries(result.bps).map(([k, v]) => `${k}:${(v / 100).toFixed(1)}%`).join(' '));
    return { recipe: r, ...result };
  }
  return null;
}

/** Everything a recipe has ever done, published so holders can check it. */
export const fires = (mint, limit = 50) =>
  db.prepare('SELECT * FROM recipe_fires WHERE mint=? ORDER BY ts DESC LIMIT ?').all(mint, limit)
    .map((f) => ({ at: f.ts, trigger: f.trigger, split: JSON.parse(f.applied || '{}'), snapshot: JSON.parse(f.snapshot || '{}') }));

/** The vocabulary, for the builder UI. One source of truth for what can be wired to what. */
export const vocabulary = () => ({
  triggers: Object.entries(TRIGGERS).map(([k, v]) => ({ key: k, label: v.label, unit: v.unit })),
  actions: Object.entries(ACTIONS).map(([k, v]) => ({ key: k, label: v.label })),
  limits: { maxRecipes: 10, maxActions: 4, maxConditions: 3, minCooldownMins: 5 },
  note: 'A recipe chooses proportions and timing. It cannot name a wallet, open a bucket you left '
      + 'closed, or change REX Chain\'s share.',
});
