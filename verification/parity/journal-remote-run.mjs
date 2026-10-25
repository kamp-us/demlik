import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";

export const journalRemoteParity = (cargo, options) =>
  compiledTraceParity(cargo, "journal-remote", options);

await compiledTraceMain(import.meta.url, "journal-remote");
