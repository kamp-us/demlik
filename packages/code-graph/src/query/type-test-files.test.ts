import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { assembleGraphWithEdges } from "../extract/assemble.js";
import { isTestFile } from "../extract/functions.js";
import { loadEdgeProject } from "../extract/project.js";
import { NodeKindRulesSchema } from "../kinds/rules.js";
import { stableStringify } from "../render/json.js";
import { type Graph, ThresholdsSchema } from "../schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "..", "..", "test", "type-tests");
const TYPE_TEST = "src/x.test-d.ts";

describe("isTestFile", () => {
  it.each([
    "a/b.test-d.ts",
    "a/b.spec-d.ts",
    "a/b.test-d.tsx",
    "a/b.spec-d.tsx",
    "a/b.test.ts",
    "a/b.spec.tsx",
  ])("reads %s as a test", (file) => {
    expect(isTestFile(file)).toBe(true);
  });

  it.each([
    "a/b.ts",
    "a/b.d.ts",
    "a/b-d.ts",
    "a/test-d.ts",
    "a/b.test-data.ts",
    "a/b.testd.ts",
  ])("reads %s as production code", (file) => {
    expect(isTestFile(file)).toBe(false);
  });
});

describe("a vitest type-test file (*.test-d.ts) is a test", () => {
  let graph: Graph;
  beforeAll(() => {
    const loaded = loadEdgeProject(FIXTURE, "package", FIXTURE);
    graph = assembleGraphWithEdges(
      loaded,
      ThresholdsSchema.parse({}),
      "package",
      loaded.tsConfigPath,
      {
        crossRuntime: true,
        kinds: true,
        reach: true,
        clusters: true,
        interfaceWidth: false,
        kindRules: NodeKindRulesSchema.parse({}),
        repoRoot: FIXTURE,
      },
    );
  });

  it("marks the type-test module and its functions as tests", () => {
    expect(graph.modules.find((m) => m.file === TYPE_TEST)?.isTest).toBe(true);
    expect(graph.functions.find((fn) => fn.id === `${TYPE_TEST}:typeTest`)?.isTest).toBe(true);
  });

  it("reports an export called only from the type test as only-called-from-tests", () => {
    const finding = graph.reachability?.unreachable.find(
      (u) => u.id === "src/shape.ts:onlyTypeTested",
    );
    expect(finding?.category).toBe("only-called-from-tests");
    expect(finding?.testReferences).toContain(TYPE_TEST);
    expect(graph.reachability?.withheld.some((w) => w.id === "src/shape.ts:onlyTypeTested")).toBe(
      false,
    );
  });

  it("lists nothing inside the type test as unreachable or withheld", () => {
    const ids = [
      ...(graph.reachability?.unreachable ?? []).map((u) => u.id),
      ...(graph.reachability?.withheld ?? []).map((w) => w.id),
    ];
    expect(ids.filter((id) => id.startsWith(`${TYPE_TEST}:`))).toEqual([]);
  });

  it("leaves the type test out of every cluster and out of the isolated files", () => {
    const clusters = graph.clusters;
    expect(clusters).not.toBeNull();
    expect(clusters?.excludedTestFileCount).toBe(1);
    // The fixture's two call triangles split `src/`, so its isolated files are listed.
    const src = clusters?.splitDirectories.find((d) => d.dir === "src");
    expect(src?.isolatedFiles).toEqual(["src/shape.ts"]);
    expect(stableStringify(clusters, false)).not.toContain(TYPE_TEST);
  });
});
