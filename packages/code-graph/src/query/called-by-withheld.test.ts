import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { assembleGraphWithEdges } from "../extract/assemble.js";
import { loadEdgeProject } from "../extract/project.js";
import { NodeKindRulesSchema } from "../kinds/rules.js";
import { type ReachabilityReport, ThresholdsSchema } from "../schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "..", "..", "test", "called-by-withheld");

function reachability(): ReachabilityReport {
  const loaded = loadEdgeProject(FIXTURE, "package", FIXTURE);
  const graph = assembleGraphWithEdges(
    loaded,
    ThresholdsSchema.parse({}),
    "package",
    loaded.tsConfigPath,
    {
      crossRuntime: false,
      kinds: true,
      reach: true,
      clusters: false,
      interfaceWidth: false,
      kindRules: NodeKindRulesSchema.parse({}),
      repoRoot: FIXTURE,
    },
  );
  if (graph.reachability === null || graph.reachability === undefined) {
    throw new Error("the reachability pass did not run");
  }
  return graph.reachability;
}

describe("a callee is never reported as more dead than its withheld caller", () => {
  let report: ReachabilityReport;
  beforeAll(() => {
    report = reachability();
  });

  const reasonOf = (id: string) => report.withheld.find((w) => w.id === id)?.reason;
  const categoryOf = (id: string) => report.unreachable.find((u) => u.id === id)?.category;

  it("withholds the whole chain a public-surface function calls, across files", () => {
    expect(reasonOf("src/index.ts:publicEntry")).toBe("public-entry-surface");
    for (const id of ["src/chain/one.ts:a", "src/chain/one.ts:b", "src/chain/two.ts:c"]) {
      expect(reasonOf(id)).toBe("called-by-withheld");
    }
  });

  it("withholds the only callee of a function referenced in a non-test file", () => {
    expect(reasonOf("src/lib.ts:named")).toBe("referenced-in-non-test-file");
    expect(reasonOf("src/lib.ts:d")).toBe("called-by-withheld");
  });

  it("does not walk from test support: its only callee stays only-called-from-tests", () => {
    expect(reasonOf("src/test-utils/support.ts:makeFixture")).toBe("test-support-surface");
    expect(categoryOf("src/e.ts:e")).toBe("only-called-from-tests");
  });

  it("still reports an export nothing calls as dead", () => {
    expect(categoryOf("src/lib.ts:f")).toBe("dead");
    expect(report.unreachable.map((u) => u.id)).toEqual(["src/lib.ts:f", "src/e.ts:e"]);
  });

  it("does not count withheld callees as reachable", () => {
    // 2 before this change too: only `boot` and `start` are reached from the module-scope call.
    expect(report.reachableCount).toBe(2);
  });

  it("gives the same report on a second run", () => {
    expect(reachability()).toEqual(report);
  });
});
