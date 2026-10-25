import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";

export const journalParity = (cargo, options) =>
  compiledTraceParity(cargo, "journal", options);

await compiledTraceMain(import.meta.url, "journal");
