import { describe, expect, it } from "vitest";
import { Cmd, defineMachine, run } from "../index";
import { diff, goldenReplay, normalizeForParity, recordRun } from "./index";

// ---------------------------------------------------------------------------
// An audit-shaped machine: an effect (outside TEA) mints each finding's id +
// timestamp at RECORD time and dispatches a `found` Msg carrying it. The
// reducer just appends — so the non-determinism (ids/timestamps) is frozen
// into the recording and `replay` reproduces it byte-identically. This is the
// canonical old-vs-new parity target.
// ---------------------------------------------------------------------------
type Severity = "error" | "warning" | "info";
type Finding = {
  id: string;
  runId: string;
  ruleId: string;
  selector: string;
  severity: Severity;
  timestamp: number;
};
type State = { type: "audit"; findings: readonly Finding[] };
type Msg = { type: "found"; finding: Finding };
type Ctx = Record<string, never>;

type FindingSpec = { ruleId: string; selector: string; severity: Severity };

// The GOLDEN engine — appends every finding.
function auditMachine() {
  return defineMachine<State, Msg, Cmd<never>, never, Ctx>({
    init: (loaded) => [loaded ?? { type: "audit", findings: [] }, Cmd.none],
    update: {
      found: (s, m) => [
        { ...s, findings: [...s.findings, m.finding] },
        Cmd.none,
      ],
    },
  });
}

// The DIVERGENT engine — the seeded one-finding drift: it DROPS `info`
// findings. Replaying a golden trace against it must be CAUGHT by the gate.
function auditMachineDropsInfo() {
  return defineMachine<State, Msg, Cmd<never>, never, Ctx>({
    init: (loaded) => [loaded ?? { type: "audit", findings: [] }, Cmd.none],
    update: {
      found: (s, m) =>
        m.finding.severity === "info"
          ? [s, Cmd.none]
          : [{ ...s, findings: [...s.findings, m.finding] }, Cmd.none],
    },
  });
}

// Mint a finding for `spec`, tagging the generated id/runId/timestamp with a
// `gen` marker so two recordings of the same specs carry DIFFERENT ids —
// exactly the record-time non-determinism `normalizeForParity` must erase.
function mint(spec: FindingSpec, index: number, gen: string): Finding {
  return {
    id: `finding-${gen}-${index}`,
    runId: `run-${gen}`,
    ruleId: spec.ruleId,
    selector: spec.selector,
    severity: spec.severity,
    timestamp: 1_000 + index * 7 + gen.length,
  };
}

async function recordAudit(
  machine: ReturnType<typeof auditMachine>,
  specs: readonly FindingSpec[],
  gen: string,
) {
  const runtime = run(machine, { ctx: {} });
  const rec = recordRun(runtime, { captureSteps: true });
  await runtime.ready;
  for (const [index, spec] of specs.entries()) {
    await runtime.dispatch({ type: "found", finding: mint(spec, index, gen) });
  }
  const trace = rec.trace();
  await runtime.stop();
  rec.stop();
  return trace;
}

const SPECS: readonly FindingSpec[] = [
  { ruleId: "img-alt", selector: "#hero", severity: "error" },
  { ruleId: "label", selector: "#email", severity: "warning" },
  { ruleId: "contrast", selector: "#footer", severity: "info" },
];

describe("recordRun / goldenReplay", () => {
  it("captures loaded at boot + the ordered non-null msgs (sufficient to replay)", async () => {
    const trace = await recordAudit(auditMachine(), SPECS, "g0");

    expect(trace.loaded).toEqual({ type: "audit", findings: [] });
    expect(trace.msgs.map((m) => m.type)).toEqual(["found", "found", "found"]);
    expect(trace.msgs.map((m) => m.finding.ruleId)).toEqual([
      "img-alt",
      "label",
      "contrast",
    ]);
  });

  it("goldenReplay reproduces the recorded final state via the pure fold", async () => {
    const trace = await recordAudit(auditMachine(), SPECS, "g0");

    const state = goldenReplay(auditMachine(), trace, {});

    expect(state).toEqual(trace.finalState);
  });

  it("goldenReplay accepts a live Recording handle", async () => {
    const runtime = run(auditMachine(), { ctx: {} });
    const rec = recordRun(runtime);
    await runtime.ready;
    await runtime.dispatch({
      type: "found",
      finding: mint(SPECS[0] as FindingSpec, 0, "live"),
    });

    const state = goldenReplay(auditMachine(), rec, {});

    expect(state).toEqual(rec.trace().finalState);
    rec.stop();
    await runtime.stop();
  });
});

describe("determinism", () => {
  it("replays byte-identical across 25 runs — raw and normalized", async () => {
    const trace = await recordAudit(auditMachine(), SPECS, "g0");
    const normalize = normalizeForParity();

    const rawExpected = JSON.stringify(goldenReplay(auditMachine(), trace, {}));
    const normExpected = JSON.stringify(
      normalize(goldenReplay(auditMachine(), trace, {})),
    );

    for (let i = 0; i < 25; i++) {
      const state = goldenReplay(auditMachine(), trace, {});
      expect(JSON.stringify(state)).toBe(rawExpected);
      expect(JSON.stringify(normalize(state))).toBe(normExpected);
    }
  });
});

describe("the gate has teeth", () => {
  it("CATCHES a divergent engine that drops one finding, PASSES an equivalent re-id'd/reordered run", async () => {
    const normalize = normalizeForParity();

    const trace = await recordAudit(auditMachine(), SPECS, "g0");
    const golden = normalize(goldenReplay(auditMachine(), trace, {}));
    const divergent = normalize(
      goldenReplay(auditMachineDropsInfo(), trace, {}),
    );

    // The seeded drift is CAUGHT.
    expect(diff(golden, divergent)).toBe(false);

    // A behaviourally-equivalent run — same rule/selector/severity, but fresh
    // ids/timestamps and a SHUFFLED dispatch order — normalizes equal.
    const shuffled: FindingSpec[] = [
      SPECS[2] as FindingSpec,
      SPECS[0] as FindingSpec,
      SPECS[1] as FindingSpec,
    ];
    const trace2 = await recordAudit(auditMachine(), shuffled, "g1");
    const golden2 = normalize(goldenReplay(auditMachine(), trace2, {}));

    expect(diff(golden, golden2)).toBe(true);
  });
});

describe("normalizeForParity", () => {
  it("strips id/runId/timestamp and stable-key-sorts collections so ids/order don't matter", () => {
    const normalize = normalizeForParity();

    const a = {
      findings: [
        { id: "x1", runId: "r1", timestamp: 100, ruleId: "b", selector: "#2" },
        { id: "x2", runId: "r1", timestamp: 200, ruleId: "a", selector: "#1" },
      ],
    };
    const b = {
      findings: [
        { id: "y9", runId: "r2", timestamp: 999, ruleId: "a", selector: "#1" },
        { id: "y8", runId: "r2", timestamp: 888, ruleId: "b", selector: "#2" },
      ],
    };

    expect(normalize(a)).toEqual(normalize(b));

    const serialized = JSON.stringify(normalize(a));
    expect(serialized).not.toContain("timestamp");
    expect(serialized).not.toContain("runId");
    expect(serialized).not.toContain("x1");
  });

  it("sorts by selector, then url, when ruleId is absent", () => {
    const normalize = normalizeForParity();

    const bySelector = normalize([
      { selector: "#b", note: "second" },
      { selector: "#a", note: "first" },
    ]) as { selector: string }[];
    expect(bySelector.map((f) => f.selector)).toEqual(["#a", "#b"]);

    const byUrl = normalize([
      { url: "https://z.example", ok: true },
      { url: "https://a.example", ok: false },
    ]) as { url: string }[];
    expect(byUrl.map((f) => f.url)).toEqual([
      "https://a.example",
      "https://z.example",
    ]);
  });

  it("honours a custom schema (stripKeys / sortKeys)", () => {
    const normalize = normalizeForParity({
      stripKeys: ["etag"],
      sortKeys: ["name"],
    });

    const out = normalize([
      { name: "beta", etag: "W/1" },
      { name: "alpha", etag: "W/2" },
    ]) as { name: string; etag?: string }[];

    expect(out.map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(JSON.stringify(out)).not.toContain("etag");
  });
});

describe("resume-cache = golden (prefix equality)", () => {
  // The durable resume-cache prefix and the golden run are ONE artifact: the
  // cache after k msgs must equal `replay(recording[0..k])`. The audit domain's
  // durable cache lives outside this package, so here we assert the SUBSTRATE
  // property the cache rests on — replaying the first k recorded msgs
  // reproduces the golden run's state after msg k (captured in `steps`).
  it("golden state after k msgs equals a replay of the first k msgs", async () => {
    const trace = await recordAudit(auditMachine(), SPECS, "g0");
    const steps = trace.steps;
    expect(steps).toBeDefined();
    if (!steps) return;

    for (let k = 1; k <= trace.msgs.length; k++) {
      const step = steps[k - 1];
      expect(step).toBeDefined();
      if (!step) continue;

      const prefix = {
        loaded: trace.loaded,
        msgs: trace.msgs.slice(0, k),
        finalState: step.state,
      };
      expect(goldenReplay(auditMachine(), prefix, {})).toEqual(step.state);
    }
  });
});
