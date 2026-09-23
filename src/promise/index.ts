/**
 * @packageDocumentation
 * @demlik/tea/promise — the Promise engine: `run` boots a machine and drives its
 * serial dispatch loop on Promises, and `driveToDone` runs one to its terminal
 * state.
 *
 * The machine you hand it is built from the neutral core at `@demlik/tea`, which
 * imports no engine. `src/entry-points.import-graph.test.ts` holds that line.
 */

export * from "./run";
