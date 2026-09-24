import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleGraphWithEdges } from "../extract/assemble.js";
import { loadEdgeProject } from "../extract/project.js";
import { evaluateScopeRatchet, recordScopeCeilings, scopesUnder } from "../ratchet/scope-count.js";
import type { CallSite, FunctionNode } from "../schema.js";
import { ThresholdsSchema } from "../schema.js";
import { isCandidateFunction } from "./candidates.js";
import { findPartialTwins } from "./partial.js";
import { CollapseSettingsSchema } from "./settings.js";

const SETTINGS = CollapseSettingsSchema.parse({});

function call(calleeId: string, line: number, ...constArgs: string[]): CallSite {
  return { calleeId, line, constArgs, declaration: null };
}

function fn(id: string, calls: CallSite[]): FunctionNode {
  return {
    id,
    name: id,
    kind: "function",
    file: "f.ts",
    startLine: 1,
    endLine: 40,
    loc: 40,
    commentLines: 0,
    nestingDepth: 1,
    complexity: 4,
    isExported: true,
    isTest: false,
    edges: { calls, calledBy: [], callChainDepth: 0 },
    nodeKind: null,
    smells: [],
  };
}

const PROLOGUE = (): CallSite[] => [
  call("a.ts:noteAttempt", 10),
  call("a.ts:decide", 11, "MAX_ATTEMPTS"),
  call("external:log", 12),
];

describe("findPartialTwins", () => {
  it("reports a shared decision block whose next call differs in each function", () => {
    const twins = findPartialTwins(
      [
        fn("a.ts:giveUp", [...PROLOGUE(), call("a.ts:finalizeFailed", 13)]),
        fn("a.ts:salvage", [...PROLOGUE(), call("a.ts:degradeToPartial", 13)]),
      ],
      SETTINGS,
    );

    expect(twins).toHaveLength(1);
    expect(twins[0]?.sharedBlock).toEqual(["a.ts:noteAttempt", "a.ts:decide", "external:log"]);
    expect(twins[0]?.sharedConstants).toEqual(["MAX_ATTEMPTS"]);
    expect(twins[0]?.aDiverges).toBe("a.ts:finalizeFailed");
    expect(twins[0]?.bDiverges).toBe("a.ts:degradeToPartial");
  });

  it("finds the block mid-function, not only at the opening (#5279's actual shape)", () => {
    const twins = findPartialTwins(
      [
        fn("a.ts:short", [...PROLOGUE(), call("a.ts:finalizeFailed", 13)]),
        fn("a.ts:long", [
          call("a.ts:isRepeatTimeout", 1),
          call("a.ts:readDiagnostic", 2),
          call("a.ts:capture", 3),
          ...PROLOGUE(),
          call("a.ts:degradeToPartial", 13),
        ]),
      ],
      SETTINGS,
    );

    expect(twins).toHaveLength(1);
    expect(twins[0]?.sharedBlock).toHaveLength(3);
  });

  it("stays silent on a shared block of generic helpers carrying no named constant", () => {
    const generic = (): CallSite[] => [
      call("external:map", 10),
      call("external:filter", 11),
      call("external:join", 12),
    ];
    expect(
      findPartialTwins(
        [
          fn("a.ts:one", [...generic(), call("a.ts:renderTable", 13)]),
          fn("a.ts:two", [...generic(), call("a.ts:renderList", 13)]),
        ],
        SETTINGS,
      ),
    ).toEqual([]);
  });

  it("stays silent when the constants at the shared call sites are not the same one", () => {
    expect(
      findPartialTwins(
        [
          fn("a.ts:one", [
            call("a.ts:noteAttempt", 10),
            call("a.ts:decide", 11, "MAX_ATTEMPTS"),
            call("external:log", 12),
            call("a.ts:finalizeFailed", 13),
          ]),
          fn("a.ts:two", [
            call("a.ts:noteAttempt", 10),
            call("a.ts:decide", 11, "MAX_TIMEOUTS"),
            call("external:log", 12),
            call("a.ts:degradeToPartial", 13),
          ]),
        ],
        SETTINGS,
      ),
    ).toEqual([]);
  });

  it("stays silent when one block runs out — containment is not divergence", () => {
    expect(
      findPartialTwins(
        [
          fn("a.ts:one", PROLOGUE()),
          fn("a.ts:two", [...PROLOGUE(), call("a.ts:degradeToPartial", 13)]),
        ],
        SETTINGS,
      ),
    ).toEqual([]);
  });

  it("stays silent on a shared block shorter than partialMinPrefix", () => {
    expect(
      findPartialTwins(
        [
          fn("a.ts:one", [
            call("a.ts:decide", 11, "MAX_ATTEMPTS"),
            call("a.ts:finalizeFailed", 12),
          ]),
          fn("a.ts:two", [
            call("a.ts:decide", 11, "MAX_ATTEMPTS"),
            call("a.ts:degradeToPartial", 12),
          ]),
        ],
        SETTINGS,
      ),
    ).toEqual([]);
  });
});

const RESUME_FIXTURE = `import { MAX_RESUME_ATTEMPTS, RESUME_BACKOFF_MAX_S } from "./limits.js";

type Decision = { kind: "give_up"; reason: string } | { kind: "retry"; backoffS: number };

export function decideResume(input: {
  attemptsAfter: number;
  maxAttempts: number;
  maxS: number;
  terminalReason: string;
}): Decision {
  if (input.attemptsAfter >= input.maxAttempts) {
    return { kind: "give_up", reason: input.terminalReason };
  }
  return { kind: "retry", backoffS: Math.min(input.maxS, 2 ** input.attemptsAfter) };
}

export function noteResumeAttemptCount(state: { attempts: number }): number {
  state.attempts += 1;
  return state.attempts;
}

export function finalizeFailed(reason: string): string {
  return \`failed: \${reason}\`;
}

export function salvageCheckpoint(reason: string): string {
  return \`partial: \${reason}\`;
}

export function armGiveUpTimer(seconds: number): number {
  return seconds;
}

export function reDispatchOrGiveUp(state: { attempts: number }, terminalReason: string): string {
  const attemptsAfter = noteResumeAttemptCount(state);
  const decision = decideResume({
    attemptsAfter,
    maxAttempts: MAX_RESUME_ATTEMPTS,
    maxS: RESUME_BACKOFF_MAX_S,
    terminalReason,
  });
  console.log(\`resume \${attemptsAfter}\`);
  if (decision.kind === "give_up") {
    return finalizeFailed(decision.reason);
  }
  return String(armGiveUpTimer(decision.backoffS));
}

export function recoverTransientGraphStep(state: { attempts: number }, err: unknown): string {
  if (err instanceof RangeError) {
    return salvageCheckpoint("repeat timeout");
  }
  const attemptsAfter = noteResumeAttemptCount(state);
  const decision = decideResume({
    attemptsAfter,
    maxAttempts: MAX_RESUME_ATTEMPTS,
    maxS: RESUME_BACKOFF_MAX_S,
    terminalReason: "graph_error",
  });
  console.log(\`recover \${attemptsAfter}\`);
  if (decision.kind === "give_up") {
    return salvageCheckpoint(decision.reason);
  }
  return String(armGiveUpTimer(decision.backoffS));
}
`;

const LIMITS_FIXTURE = `export const MAX_RESUME_ATTEMPTS = 3;
export const RESUME_BACKOFF_MAX_S = 900;
`;

describe("partial twins over a real edge pass (#5279's pair)", () => {
  let root: string;
  let twins: ReturnType<typeof findPartialTwins>;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-partial-")));
    fs.writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n');
    fs.writeFileSync(path.join(root, "limits.ts"), LIMITS_FIXTURE);
    fs.writeFileSync(path.join(root, "resume.ts"), RESUME_FIXTURE);

    const loaded = loadEdgeProject(root, "package", root);
    const graph = assembleGraphWithEdges(
      loaded,
      ThresholdsSchema.parse({}),
      "package",
      loaded.tsConfigPath,
    );
    twins = findPartialTwins(
      graph.functions.filter((f) => isCandidateFunction(f, SETTINGS)),
      SETTINGS,
    );
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports the pair that shares the resume decision and disagrees on the outcome", () => {
    expect(twins).toHaveLength(1);
    const twin = twins[0];
    expect([twin?.aId, twin?.bId].sort()).toEqual([
      "resume.ts:reDispatchOrGiveUp",
      "resume.ts:recoverTransientGraphStep",
    ]);
  });

  it("names the constants both call sites pass and the calls they diverge into", () => {
    expect(twins[0]?.sharedConstants).toEqual(["MAX_RESUME_ATTEMPTS", "RESUME_BACKOFF_MAX_S"]);
    expect([twins[0]?.aDiverges, twins[0]?.bDiverges].sort()).toEqual([
      "resume.ts:finalizeFailed",
      "resume.ts:salvageCheckpoint",
    ]);
  });

  it("carries the shared decision call in the block it reports", () => {
    expect(twins[0]?.sharedBlock).toContain("resume.ts:decideResume");
  });
});

describe("partial-twin ratchet", () => {
  const ceilings = { default: 0, scopes: { "services/auditer": 1, "services/kontrol": 1 } };

  it("passes when every governed scope sits exactly on its ceiling", () => {
    const verdict = evaluateScopeRatchet(
      [
        { scope: "services/auditer", count: 1 },
        { scope: "services/kontrol", count: 1 },
      ],
      ceilings,
    );
    expect(verdict.passed).toBe(true);
  });

  it("fails both ways — a new twin EXCEEDS, a fixed one leaves SLACK", () => {
    const verdict = evaluateScopeRatchet(
      [
        { scope: "services/auditer", count: 3 },
        { scope: "services/kontrol", count: 0 },
      ],
      ceilings,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.map((v) => v.direction)).toEqual(["EXCEEDED", "SLACK"]);
  });

  it("governs only the scopes at or under the analyzed root", () => {
    expect(scopesUnder(Object.keys(ceilings.scopes), ".")).toEqual([
      "services/auditer",
      "services/kontrol",
    ]);
    expect(scopesUnder(Object.keys(ceilings.scopes), "services/auditer")).toEqual([
      "services/auditer",
    ]);
    expect(scopesUnder(Object.keys(ceilings.scopes), "packages")).toEqual([]);
  });

  it("records a measurement without dropping the scopes it did not measure", () => {
    expect(recordScopeCeilings([{ scope: "services/auditer", count: 4 }], ceilings).scopes).toEqual(
      { "services/auditer": 4, "services/kontrol": 1 },
    );
  });
});
