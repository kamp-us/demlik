import { describe, expect, it } from "vitest";
import { memoryArtifactStore, runStage } from "../src/lowering/artifact.js";
import {
  LOWERING_RULES,
  type LoweredBranch,
  loweringInput,
  lowerStage,
} from "../src/lowering/lower.js";
import {
  atomsOf,
  graphOf,
  known,
  lineOf,
  lower,
  shape,
  withoutSpans,
} from "./lowering-lower-fixture.js";

// Every source below is synthetic, written for these tests.

describe("stage 2: lowering", () => {
  const file = "src/billing/seats.ts";
  const source = [
    "export function canAddSeat(account, count) {",
    "  if (!account) throw new Error('no account');",
    "  if (account.seats + count > account.limit) {",
    "    notify(account.owner);",
    "    return false;",
    "  }",
    "  return true;",
    "}",
  ].join("\n");

  it("writes one fact per branch, each with a span, spanned atoms and a closed outcome", async () => {
    const run = await runStage(
      memoryArtifactStore<LoweredBranch>(),
      lowerStage,
      loweringInput({ file, source, functions: graphOf(file, source) }),
    );
    expect(run._tag).toBe("computed");
    const facts = run.artifact.facts;
    expect(facts.map((f) => f.id)).toEqual([
      `${file}:canAddSeat@0`,
      `${file}:canAddSeat@1`,
      `${file}:canAddSeat@2`,
      `${file}:canAddSeat@3`,
    ]);
    expect(facts.map((f) => shape(known(f)))).toEqual([
      { path: ["¬(v0)"], outcome: 'throw new Error("no account")' },
      {
        path: ["v0", "v0.seats + v1 > v0.limit"],
        outcome: "call notify(v0.owner)",
      },
      { path: ["v0", "v0.seats + v1 > v0.limit"], outcome: "return false" },
      { path: ["v0", "¬(v0.seats + v1 > v0.limit)"], outcome: "return true" },
    ]);
    expect(facts.map((f) => f.span)).toEqual([
      { file, startLine: 2, endLine: 2 },
      { file, startLine: 4, endLine: 4 },
      { file, startLine: 5, endLine: 5 },
      { file, startLine: 7, endLine: 7 },
    ]);
    const [first, second] = [known(facts[0]), known(facts[1])];
    expect(first.path[0]?.span).toEqual({ file, startLine: 2, endLine: 2 });
    expect(second.path[1]?.span).toEqual({ file, startLine: 3, endLine: 3 });
    expect(facts.map((f) => known(f).outcome.kind)).toEqual([
      "throw",
      "call",
      "return",
      "return",
    ]);
  });

  it("writes no branch for a call reached under an empty path condition", async () => {
    const plain = [
      "export function sync(store) {",
      "  store.flush();",
      "  return store.size;",
      "}",
    ].join("\n");
    const facts = await lower("src/sync.ts", plain);
    expect(facts.map((f) => shape(known(f)))).toEqual([
      { path: [], outcome: "return v0.size" },
    ]);
  });

  it("lowers only the functions the graph names in this file", async () => {
    const facts = await lower(file, source, {
      functions: [
        ...graphOf(file, source),
        {
          id: "src/other.ts:x",
          file: "src/other.ts",
          startLine: 1,
          endLine: 8,
          edges: null,
        },
      ],
    });
    expect(new Set(facts.map((f) => known(f).function))).toEqual(
      new Set([`${file}:canAddSeat`]),
    );
  });
});

describe("the atom grammar", () => {
  const file = "src/access/grammar.ts";
  const source = [
    "export function route(req, user) {",
    "  if (req.internal && !isSuspended(user)) return 'fast';",
    "  if (user.tier === 'gold' || user.tier === 'platinum') throw new Upsell();",
    "  if (!('region' in req)) return 'default';",
    "  if (user !== null) return 'known';",
    "  return 'anonymous';",
    "}",
    "export function twoExits(a, b) {",
    "  if (a) return;",
    "  if (b) throw new Error('b');",
    "  return 1;",
    "}",
  ].join("\n");

  it("flattens &&, reads ! as polarity, keeps || as one any atom and carries an early exit's negation", async () => {
    const facts = await lower(file, source);
    const route = facts
      .filter((f) => known(f).function === `${file}:route`)
      .map((f) => shape(known(f)));
    const notFast = "(¬(v0.internal) ∨ isSuspended(v1))";
    const notUpsell = ['¬(v1.tier === "gold")', '¬(v1.tier === "platinum")'];
    expect(route).toEqual([
      { path: ["v0.internal", "¬(isSuspended(v1))"], outcome: 'return "fast"' },
      {
        path: [notFast, '(v1.tier === "gold" ∨ v1.tier === "platinum")'],
        outcome: "throw new Upsell()",
      },
      {
        path: [notFast, ...notUpsell, '¬("region" in v0)'],
        outcome: 'return "default"',
      },
      {
        path: [notFast, ...notUpsell, '"region" in v0', "¬(v1 === null)"],
        outcome: 'return "known"',
      },
      {
        path: [notFast, ...notUpsell, '"region" in v0', "v1 === null"],
        outcome: 'return "anonymous"',
      },
    ]);
  });

  it("types each atom: a predicate call, an in test, a comparison and a truthiness test", async () => {
    const facts = await lower(file, source);
    const kinds = known(facts[3]).path.map((atom) => atom.kind);
    expect(kinds).toEqual(["any", "compare", "compare", "in", "compare"]);
    const [first] = known(facts[0]).path;
    expect(first).toMatchObject({ kind: "truthy", polarity: true });
    const [, second] = known(facts[0]).path;
    expect(second).toMatchObject({ kind: "predicate", polarity: false });
    const notEqual = known(facts[3]).path[4];
    expect(notEqual).toMatchObject({
      kind: "compare",
      operator: "===",
      polarity: false,
    });
  });

  it("carries `if (a) return; if (b) throw` into the throw as ¬a ∧ b", async () => {
    const facts = await lower(file, source);
    const twoExits = facts
      .filter((f) => known(f).function === `${file}:twoExits`)
      .map((f) => shape(known(f)));
    expect(twoExits).toEqual([
      { path: ["v0"], outcome: "return" },
      { path: ["¬(v0)", "v1"], outcome: 'throw new Error("b")' },
      { path: ["¬(v0)", "¬(v1)"], outcome: "return 1" },
    ]);
  });

  it("gives every leaf of an any atom its own span", async () => {
    const facts = await lower(file, source);
    const spans = atomsOf(known(facts[1])).map((a) => a.span.startLine);
    expect(spans.every((line) => line === 2 || line === 3)).toBe(true);
  });
});

describe("neutral names", () => {
  const file = "src/limits.ts";
  const source = [
    "export function withinQuota(project, requested) {",
    "  const usage = meter.read(project.id);",
    "  if (usage === null) return false;",
    "  if (usage.used + requested > project.quota) throw new QuotaError(project.id);",
    "  return true;",
    "}",
    "export function underCap(p, n) {",
    "  const u = meter.read(p.id);",
    "  if (u === null) return false;",
    "  if (u.used + n > p.quota) throw new QuotaError(p.id);",
    "  return true;",
    "}",
  ].join("\n");

  it("lowers two functions that differ only in local and parameter names to the same facts", async () => {
    const facts = await lower(file, source);
    const of = (name: string) =>
      facts
        .filter((f) => known(f).function === `${file}:${name}`)
        .map((f) => withoutSpans(known(f)));
    expect(of("withinQuota")).toHaveLength(3);
    expect(of("withinQuota")).toEqual(of("underCap"));
  });

  it("keeps free identifiers, member paths and callee names", async () => {
    const facts = await lower(file, source);
    expect(shape(known(facts[1]))).toEqual({
      path: ["¬(v2 === null)", "v2.used + v1 > v0.quota"],
      outcome: "throw new QuotaError(v0.id)",
    });
    expect(known(facts[1]).bindings).toEqual([
      {
        local: "v2",
        init: {
          kind: "call",
          callee: { kind: "free", path: "meter.read" },
          args: [
            {
              kind: "member",
              object: { kind: "local", name: "v0" },
              property: "id",
            },
          ],
          calleeId: null,
        },
      },
    ]);
  });
});

describe("logging", () => {
  const file = "src/audit.ts";
  const source = [
    "export function revoke(grant) {",
    "  if (grant.expired) {",
    "    console.warn('expired', grant.id);",
    "    logger.info('revoking');",
    "    this.logger.debug('revoking');",
    "    auditTrail.record(grant.id);",
    "    grant.revoke();",
    "  }",
    "}",
  ].join("\n");

  const calls = async (loggingRoots?: readonly string[]) =>
    (
      await lower(
        file,
        source,
        loggingRoots === undefined ? {} : { loggingRoots },
      )
    ).map((f) => shape(known(f)).outcome);

  it("strips console calls by default and keeps every other call", async () => {
    expect(await calls()).toEqual([
      'call logger.info("revoking")',
      'call this.logger.debug("revoking")',
      "call auditTrail.record(v0.id)",
      "call v0.revoke()",
    ]);
  });

  it("strips an added logging root when configured", async () => {
    expect(await calls(["logger"])).toEqual([
      "call auditTrail.record(v0.id)",
      "call v0.revoke()",
    ]);
  });

  it("keys the logging roots into the stage input", () => {
    const base = { file, source, functions: graphOf(file, source) };
    expect(loweringInput(base).content).not.toBe(
      loweringInput({ ...base, loggingRoots: ["logger"] }).content,
    );
  });
});

describe("a function that does not parse", () => {
  it("lowers to one fact whose value is unknown with reason undetermined", async () => {
    const file = "src/broken.ts";
    const source = [
      "export function fine(a) {",
      "  if (a) return 1;",
      "  return 2;",
      "}",
      "export function broken(a) {",
      "  if (a) return (1;",
      "  return 2;",
      "}",
    ].join("\n");
    const facts = await lower(file, source);
    const broken = facts.filter((f) => f.id === `${file}:broken`);
    expect(broken).toEqual([
      {
        id: `${file}:broken`,
        span: { file, startLine: 5, endLine: 8 },
        value: { _tag: "unknown", reason: "undetermined" },
      },
    ]);
  });

  it("lowers a graph function the parser cannot find to undetermined, never to a partial list", async () => {
    const file = "src/moved.ts";
    const source = "export function here(a) {\n  return a;\n}";
    const facts = await lower(file, source, {
      functions: [
        { id: `${file}:gone`, file, startLine: 9, endLine: 12, edges: null },
      ],
    });
    expect(facts.map((f) => f.value)).toEqual([
      { _tag: "unknown", reason: "undetermined" },
    ]);
  });
});

describe("the ported rule: parameter-defaults-ignored", () => {
  // Held-out cases written for this rule, not derived from any stage-6 acceptance pair.
  const file = "src/rules/defaults.ts";
  const source = [
    "export function pageWith(query, size = pickDefaultSize(query)) {",
    "  if (size > 100) throw new RangeError('size');",
    "  return fetchPage(query, size);",
    "}",
    "export function pageWithout(query, size) {",
    "  if (size > 100) throw new RangeError('size');",
    "  return fetchPage(query, size);",
    "}",
    "export function sliceWith({ from = 0, to = Infinity } = {}) {",
    "  if (from > to) return [];",
    "  return range(from, to);",
    "}",
    "export function sliceWithout({ from, to }) {",
    "  if (from > to) return [];",
    "  return range(from, to);",
    "}",
  ].join("\n");

  it("is named among the lowering rules", () => {
    expect(LOWERING_RULES).toContain("parameter-defaults-ignored");
  });

  it("lowers a parameter with a default exactly as one without", async () => {
    const facts = await lower(file, source);
    const of = (name: string) =>
      facts
        .filter((f) => known(f).function === `${file}:${name}`)
        .map((f) => withoutSpans(known(f)));
    expect(of("pageWith")).toEqual(of("pageWithout"));
    expect(of("sliceWith")).toEqual(of("sliceWithout"));
  });

  it("writes no call branch and no binding for a default's expression", async () => {
    const facts = await lower(file, source);
    const pageWith = facts.filter(
      (f) => known(f).function === `${file}:pageWith`,
    );
    expect(pageWith.map((f) => shape(known(f)).outcome)).toEqual([
      'throw new RangeError("size")',
      "return fetchPage(v0, v1)",
    ]);
    expect(pageWith.flatMap((f) => known(f).bindings)).toEqual([]);
  });
});

describe("callee ids", () => {
  it("binds a call to the one call edge on its line whose name ends the callee path", async () => {
    const file = "src/gates/export.ts";
    const source = [
      "export function canExport(user) {",
      "  const limits = loadLimits(user.org);",
      "  if (limits === null) return true;",
      "  return limits.exports > 0;",
      "}",
    ].join("\n");
    const line = lineOf(source, "loadLimits(");
    const facts = await lower(file, source, {
      functions: graphOf(file, source, {
        canExport: [
          { calleeId: "src/gates/limits.ts:loadLimits", line },
          { calleeId: "external:other", line: 99 },
        ],
      }),
    });
    const [binding] = known(facts[0]).bindings;
    expect(binding?.init).toMatchObject({
      kind: "call",
      calleeId: "src/gates/limits.ts:loadLimits",
    });
  });
});
