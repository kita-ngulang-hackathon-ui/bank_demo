/** Deterministic PRNG shared by the demo population and the simulation scripts.
 *
 * Same seed, same population and same history, which is what makes a re-run
 * idempotent at ADA's end: client_event_id is derived from these draws, not
 * from Math.random().
 */

/** mulberry32, seeded from an arbitrary string. */
export function makeRandom(seedText) {
  let h = 1779033703 ^ String(seedText).length;
  for (let i = 0; i < String(seedText).length; i += 1) {
    h = Math.imul(h ^ String(seedText).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience helpers over a random function, so callers do not re-derive them. */
export function helpers(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const between = (min, max) => Math.round(min + random() * (max - min));
  const roundTo = (value, step) => Math.round(value / step) * step;
  const chance = (p) => random() < p;
  return { random, pick, between, roundTo, chance };
}
