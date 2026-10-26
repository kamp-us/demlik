import type { Script } from "./agent-state-reference.mts";
export function stateCases() {
  const rows: Array<{ id: string; script: Script }> = [];
  const base: Script = {
    operation: "usage",
    usage: "current",
    legacy: "absent",
    context: "null",
    failure: "null",
    phase: "running",
    conversation: true,
    awaiting: "llm",
    stages: "two",
    annotation: "none",
  };
  const add = (id: string, change: Partial<Script>) =>
    rows.push({ id: `agent-state.${id}`, script: { ...base, ...change } });
  for (const usage of [
    "absent",
    "undefined",
    "null",
    "current",
    "zero",
  ] as const)
    for (const context of [
      "none",
      "absent",
      "undefined",
      "null",
      "number",
    ] as const)
      for (const legacy of context === "none"
        ? (["absent"] as const)
        : (["absent", "undefined", "null", "value"] as const))
        add(`usage-${usage}-${context}-${legacy}`, {
          usage,
          context: context === "none" ? "null" : context,
          conversation: context !== "none",
          legacy,
        });
  for (const phase of [
    "idle",
    "running",
    "stale",
    "done",
    "failed",
    "cancelled",
  ] as const)
    for (const failure of ["null", "wire", "undefined", "absent"] as const)
      for (const awaiting of ["llm", "tools", "compacting"] as const)
        add(`inspect-${phase}-${failure}-${awaiting}`, {
          operation: "inspect",
          phase,
          failure,
          awaiting,
          annotation: failure === "wire" ? "llm" : "none",
        });
  for (const phase of [
    "idle",
    "running",
    "stale",
    "done",
    "failed",
    "cancelled",
  ] as const)
    for (const stages of ["two", "undefined-first", "empty"] as const)
      add(`stage-${phase}-${stages}`, { operation: "inspect", phase, stages });
  for (const annotation of ["turn_limit", "elapsed_limit", "llm"] as const)
    for (const phase of ["idle", "done", "running"] as const)
      add(`annotation-${annotation}-${phase}`, {
        operation: "inspect",
        annotation,
        phase,
        failure: "wire",
      });
  for (const usage of [
    "absent",
    "undefined",
    "null",
    "current",
    "zero",
    "wire",
  ] as const)
    for (const legacy of ["absent", "null", "value"] as const)
      add(`cold-${usage}-${legacy}`, {
        operation: "cold",
        usage,
        legacy,
        context: "undefined",
        failure: "undefined",
      });
  for (const awaiting of ["llm", "tools", "compacting"] as const)
    add(`inspect-no-conversation-${awaiting}`, {
      operation: "inspect",
      conversation: false,
      awaiting,
    });
  return rows;
}
