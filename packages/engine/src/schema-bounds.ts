/**
 * Largest number of items any array in external input may hold when a schema
 * validates it. Zod validates every element, so an unbounded array lets a
 * large input exhaust memory (GHSA-mrhx-c7xc-m3w5); every array schema states
 * a bound, and this is the default for lists that have no tighter limit.
 */
export const MAX_ARRAY_ITEMS = 100_000;

/** Largest number of dependencies a plan step may name. */
export const MAX_STEP_DEPENDENCIES = 100;
