import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCommentCensus } from "../comments/census.js";
import { assembleGraphWithEdges } from "../extract/assemble.js";
import { isTestFile } from "../extract/functions.js";
import { loadEdgeProject } from "../extract/project.js";
import { NodeKindRulesSchema } from "../kinds/rules.js";
import { stableStringify } from "../render/json.js";
import { type Graph, ThresholdsSchema } from "../schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "..", "..", "test", "type-tests");
const TYPE_TEST = "src/x.test-d.ts";
const NAMED_TYPE_TESTS = ["src/y.type-test.ts", "src/z.dotted.type-test.ts"];

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

describe("isTestFile", () => {
  it.each([
    "a/b.test-d.ts",
    "a/b.spec-d.ts",
    "a/b.test-d.tsx",
    "a/b.spec-d.tsx",
    "a/b.test.ts",
    "a/b.spec.tsx",
    "a/b.type-test.ts",
    "a/b.c.type-test.ts",
    "a/b.type-test.tsx",
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
    "a/load-test.ts",
    "a/contract-spec.ts",
    "a/type-test.ts",
    "a/b.type-test-data.ts",
  ])("reads %s as production code", (file) => {
    expect(isTestFile(file)).toBe(false);
  });
});

describe("a vitest type-test file (*.test-d.ts) is a test", () => {
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
    expect(clusters?.excludedTestFileCount).toBe(1 + NAMED_TYPE_TESTS.length);
    // The fixture's two call triangles split `src/`, so its isolated files are listed.
    const src = clusters?.splitDirectories.find((d) => d.dir === "src");
    expect(src?.isolatedFiles).toEqual(["src/shape.ts"]);
    expect(stableStringify(clusters, false)).not.toContain(TYPE_TEST);
  });
});

describe("a named type-test file (*.type-test.ts) is a test", () => {
  it.each(NAMED_TYPE_TESTS)("marks %s as a test module", (file) => {
    expect(graph.modules.find((m) => m.file === file)?.isTest).toBe(true);
  });

  it("marks its functions as tests", () => {
    expect(
      graph.functions.find((fn) => fn.id === `${NAMED_TYPE_TESTS[0]}:assertPinned`)?.isTest,
    ).toBe(true);
  });

  it("lists nothing inside it under unusedExports, unreachable or withheld", () => {
    const ids = [
      ...(graph.reachability?.unusedExports ?? []).map((u) => u.id),
      ...(graph.reachability?.unreachable ?? []).map((u) => u.id),
      ...(graph.reachability?.withheld ?? []).map((w) => w.id),
    ];
    expect(ids.filter((id) => NAMED_TYPE_TESTS.some((file) => id.startsWith(`${file}:`)))).toEqual(
      [],
    );
  });

  it("reports an export used only from it the same as one used only from a *.test-d.ts file", () => {
    const finding = graph.reachability?.unreachable.find(
      (u) => u.id === "src/shape.ts:onlyTypeTestFileTested",
    );
    const vitestFinding = graph.reachability?.unreachable.find(
      (u) => u.id === "src/shape.ts:onlyTypeTested",
    );
    expect(finding?.category).toBe(vitestFinding?.category);
    expect(finding?.category).toBe("only-called-from-tests");
    expect(finding?.testReferences).toContain(NAMED_TYPE_TESTS[0]);
  });

  it.each(NAMED_TYPE_TESTS)("the comment census marks %s as a test", (file) => {
    const row = loadCommentCensus(FIXTURE).files.find((f) => f.file === file);
    expect(row?.isTest).toBe(true);
  });
});
