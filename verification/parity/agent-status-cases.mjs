import { createAgent } from "../../packages/tea/src/agent/index.ts";

const copy = (v) => JSON.parse(JSON.stringify(v));
export function statusCases() {
  const agent = createAgent({
      stages: [{ name: "collect" }],
      model: async () => {
        throw Error("pure fixture");
      },
      schemas: { collect: { parse: (v) => v } },
      turnOf: () => "collect",
      toolOf: (c) => ({ type: "tool", call: c }),
    }),
    base = copy(agent.init()),
    out = [];
  const call = { callId: "a", name: "read", args: { "\ud800": "retained" } },
    queued = { callId: "b", name: "read", args: { queued: true } };
  const state = (phase = "running") => ({
    ...copy(base),
    failure: null,
    run: {
      ...copy(base.run),
      phase,
      ...(phase === "idle" ? {} : { runId: "r" }),
      ...(phase === "failed"
        ? { failure: { reason: "deadline", at: 13 } }
        : {}),
      ...(phase === "cancelled" ? { at: 14 } : {}),
    },
  });
  const add = (id, s, options = {}, qualification) =>
    out.push({
      id: `agent-status.${id}`,
      input: { state: s, ...options },
      ...(qualification ? { qualification } : {}),
    });
  for (const phase of [
    "idle",
    "running",
    "stale",
    "done",
    "failed",
    "cancelled",
  ])
    for (const annotation of ["absent", "undefined", "null", "object"]) {
      const s = state(phase),
        undef = [];
      if (annotation === "absent" || annotation === "undefined")
        delete s.failure;
      else
        s.failure =
          annotation === "null" ? null : { reason: "turn_limit", at: 12 };
      if (annotation === "undefined") undef.push("failure");
      add(`precedence-${phase}-${annotation}`, s, { undefined: undef });
    }
  const turn = {
      content: "retained\udfff",
      toolCalls: [],
      provider: { "\ud800": "original" },
    },
    usage = { inputTokens: 9, outputTokens: 2, cachedInputTokens: 1 };
  for (const output of ["absent", "undefined", "null", "object"])
    for (const cost of ["absent", "undefined", "null", "object"]) {
      const s = state("done"),
        undef = [];
      if (output === "absent" || output === "undefined") delete s.output;
      else s.output = output === "null" ? null : turn;
      if (output === "undefined") undef.push("output");
      if (cost === "absent" || cost === "undefined") delete s.usage;
      else s.usage = cost === "null" ? null : usage;
      if (cost === "undefined") undef.push("usage");
      s.conversation = {
        turns: [],
        toolRecords: [],
        turnCount: 0,
        awaiting: { kind: "llm" },
        contextTokens: null,
        usage: { inputTokens: 99, outputTokens: 99 },
      };
      add(`done-${output}-${cost}`, s, { undefined: undef });
    }
  for (const phase of ["running", "stale"])
    for (const awaiting of ["none", "llm", "tools", "compacting"]) {
      const s = state(phase);
      s.tools.running = [call];
      s.tools.pending = [queued];
      s.conversation =
        awaiting === "none"
          ? null
          : {
              turns: [],
              toolRecords: [],
              turnCount: 0,
              awaiting: {
                kind: awaiting,
                ...(awaiting === "tools" ? { batchTurn: 0 } : {}),
                ...(awaiting === "compacting" ? { folding: 2 } : {}),
              },
              contextTokens: null,
            };
      add(`live-${phase}-${awaiting}`, s);
    }
  const empty = state();
  empty.tools.pending = [queued];
  empty.conversation = {
    turns: [],
    toolRecords: [],
    turnCount: 0,
    awaiting: { kind: "tools", batchTurn: 0 },
    contextTokens: null,
  };
  add("suspended-empty-running", empty);
  for (const marker of [
    "null",
    "nan",
    "infinity",
    "negativeInfinity",
    "negativeZero",
    "fraction",
  ])
    for (const cold of [false, true]) {
      const s = state("cancelled");
      s.run.at = marker === "fraction" ? 17.25 : null;
      add(`cancel-${marker}-${cold ? "cold" : "pure"}`, s, {
        ...(marker === "null" || marker === "fraction" ? {} : { at: marker }),
        cold,
      });
    }
  for (const channel of ["agent", "run-deadline", "run-stage"]) {
    const s = state(channel === "agent" ? "cancelled" : "failed");
    if (channel === "agent")
      s.failure = {
        reason: "llm",
        error: {
          key: "collect",
          purpose: "collect",
          reason: "opaque",
          error: { original: "cause\ud800" },
        },
        at: 2,
      };
    else if (channel === "run-stage")
      s.run.failure = {
        reason: "stage",
        stage: { name: "collect" },
        error: { original: "cause\ud800" },
      };
    add(`original-${channel}-failure`, s);
  }
  for (const failure of [0, "raw\ud800"])
    add(
      `raw-annotation-${typeof failure}`,
      { ...state(), failure },
      {},
      "OPEN existing precise typed-state input profile: Source returns the primitive annotation; native state decoding refuses it before status. Excluded from strict/nativeEvidence.",
    );
  const extra = state("done");
  extra.output = turn;
  extra.usage = { ...usage, extra: { retained: true } };
  add(
    "raw-usage-extra",
    extra,
    {},
    "OPEN existing typed TurnUsage DTO-extra profile: Source retains unmodeled fields; native canonical DTO retains its typed Rc but has no extension bag. Excluded from strict/nativeEvidence.",
  );
  return out;
}
