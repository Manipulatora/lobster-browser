/** Deterministic PRNG utilities — same seed always yields the same fingerprint. */

/** FNV-1a hash of a string into a uint32, used to seed the PRNG. */
export function hashStringToUint32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — a tiny, fast, deterministic PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded random helper with deterministic picks — the basis of stable fingerprints. */
export class SeededRandom {
  private readonly next: () => number;

  constructor(seed: string) {
    this.next = mulberry32(hashStringToUint32(seed));
  }

  /** Float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Deterministically pick one element. Throws on empty input. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) {
      throw new Error('SeededRandom.pick: cannot pick from an empty array');
    }
    return arr[this.int(0, arr.length - 1)] as T;
  }
}
