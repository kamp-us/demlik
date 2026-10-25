import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";

export const intakeParity = (cargo, options) =>
  compiledTraceParity(cargo, "idempotent-intake", {
    ...options,
    format: "llm",
  });

await compiledTraceMain(import.meta.url, "idempotent-intake", {
  format: "llm",
});
