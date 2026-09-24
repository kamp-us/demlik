import * as fc from "fast-check";

/**
 * Determinism for the property-based suite.
 *
 * Every test file here uses `fast-check`. Without a pinned seed, fast-check
 * draws a fresh random seed per run, so a property with a latent counterexample
 * fails only on the unlucky runs — the suite reds intermittently in CI and the
 * failure is not reproducible (the exact symptom behind #84 / #87 / #104).
 *
 * The fix is NOT to mask: it is to make the run REPRODUCIBLE and DEEPER, so any
 * real counterexample surfaces every time (to be fixed, like #88 / #89) instead
 * of randomly (to flake):
 *
 *   - `seed` is FIXED and arbitrary (42 — not cherry-picked to dodge a known
 *     failure). A real counterexample reachable at this seed fails the suite
 *     deterministically; that is the signal to fix the verb or the property.
 *   - `numRuns` is raised 10x (100 → 1000): each property explores an order of
 *     magnitude more cases per run, deterministically, flushing latent
 *     counterexamples that the default 100 would only hit by chance.
 *
 * Both are overridable by env, for two jobs CI's fixed slice can't do:
 *   - `FC_SEED=<n>`     — reproduce a specific failure, or sweep seeds to prove
 *     the fixed seed isn't masking a counterexample other seeds reach.
 *   - `FC_NUMRUNS=<n>`  — an out-of-band exhaustive sweep (e.g. 50000) to flush
 *     latent counterexamples beyond the CI slice; not run in CI.
 */
const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : 42;
const numRuns = process.env.FC_NUMRUNS ? Number(process.env.FC_NUMRUNS) : 1000;

fc.configureGlobal({ seed, numRuns });
