/**
 * Small deterministic PRNG utility used by the core simulation.
 * The arena model and AI decisions must use this generator instead of Math.random
 * so the same seed always produces the same gameplay sequence.
 */
export interface DeterministicRng {
  nextFloat: () => number;
  nextInt: (maxExclusive: number) => number;
}

export function createDeterministicRng(seed: number): DeterministicRng {
  let state = seed >>> 0;

  const nextFloat = (): number => {
    // Mulberry32 variant.
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    nextFloat,
    nextInt: (maxExclusive: number) => {
      if (maxExclusive <= 0) return 0;
      return Math.floor(nextFloat() * maxExclusive);
    },
  };
}

