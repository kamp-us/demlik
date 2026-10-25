import { runGraphMutations } from "./graph-mutations-run.mjs";

runGraphMutations(
  "scoped_reads_driver",
  "scoped-read-mutations.mjs",
  "scoped-read-mutations.json",
);
