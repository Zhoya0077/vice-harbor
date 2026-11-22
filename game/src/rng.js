// Seeded randomness. The simulation never calls Math.random: every layout, traffic choice and
// job is drawn from one mulberry32 stream, so ?seed=7 looks the same on every machine and every
// reload. (Audio noise is the one exception, and it never touches the picture.)

export function createRandom(seed) {
  let a = seed | 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random source with the helpers the generator code reads best with. */
export function createStreams(seed) {
  const random = createRandom(seed);
  return {
    random,
    range: (min, max) => min + random() * (max - min),
    int: (min, max) => Math.floor(min + random() * (max - min + 1)),
    chance: (p) => random() < p,
    pick: (list) => list[Math.floor(random() * list.length) % list.length],
    sign: () => (random() < 0.5 ? -1 : 1),
    shuffle(list) {
      for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const tmp = list[i];
        list[i] = list[j];
        list[j] = tmp;
      }
      return list;
    },
  };
}

/** A stable hash for window lights and other per-building detail (no state, no allocation). */
export function hash2(a, b, salt) {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x165667b1, 0xc2b2ae35) ^ (salt | 0);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
