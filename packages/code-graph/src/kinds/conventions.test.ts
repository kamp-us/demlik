import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveNodeKindRules, withEntryPresets } from "../config.js";
import { assembleGraphWithEdges } from "../extract/assemble.js";
import { loadEdgeProject } from "../extract/project.js";
import { type Graph, ThresholdsSchema } from "../schema.js";
import { compileConventions, matchingConventions } from "./conventions.js";
import { globToRegExp } from "./glob.js";
import { type NodeKindRules, NodeKindRulesSchema } from "./rules.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "..", "..", "test", "entry-conventions");

function analyze(fixture: string, rules: Partial<NodeKindRules> = {}): Graph {
  const root = path.join(FIXTURES, fixture);
  const loaded = loadEdgeProject(root, "package", root);
  return assembleGraphWithEdges(
    loaded,
    ThresholdsSchema.parse({}),
    "package",
    loaded.tsConfigPath,
    {
      crossRuntime: true,
      kinds: true,
      reach: true,
      clusters: false,
      interfaceWidth: false,
      kindRules: NodeKindRulesSchema.parse(rules),
      repoRoot: root,
    },
  );
}

const entryEvidence = (graph: Graph): Record<string, string[]> =>
  Object.fromEntries(
    graph.functions.flatMap((fn) =>
      fn.nodeKind?.kind === "entry" ? [[fn.id, fn.nodeKind.evidence]] : [],
    ),
  );

const kindOf = (graph: Graph, id: string): string | undefined =>
  graph.functions.find((fn) => fn.id === id)?.nodeKind?.kind;

const unreachable = (graph: Graph): string[] =>
  (graph.reachability?.unreachable ?? []).map((u) => `${u.category} ${u.id}`);

describe("globToRegExp", () => {
  it.each([
    ["{,src/}app/**/page.tsx", "app/page.tsx", true],
    ["{,src/}app/**/page.tsx", "src/app/(marketing)/about/page.tsx", true],
    ["{,src/}app/**/page.tsx", "app/@modal/(.)photo/[id]/page.tsx", true],
    ["{,src/}app/**/page.tsx", "lib/app/page.tsx", false],
    ["{,src/}app/**/page.tsx", "app/page.tsx.bak", false],
    ["pages/**/*.{ts,tsx}", "pages/api/users/[id].ts", true],
    ["pages/**/*.{ts,tsx}", "pages/_app.tsx", true],
    ["jobs/*.ts", "jobs/nested/run.ts", false],
    ["jobs/?.ts", "jobs/a.ts", true],
    ["docs/**", "docs/a/b.ts", true],
  ])("%s against %s is %s", (glob, file, expected) => {
    expect(globToRegExp(glob).test(file)).toBe(expected);
  });

  it.each(["app/{page", "app/page}", "a,b"])("refuses the unbalanced glob %s", (glob) => {
    expect(() => globToRegExp(glob)).toThrow(/glob/);
  });
});

describe("matchingConventions", () => {
  const conventions = compileConventions({
    "route-default": { files: "routes/*.ts", exports: ["default"] },
    "route-loader": { files: "routes/*.ts", exports: ["loader"] },
  });

  it("names every convention whose glob and export list both match", () => {
    expect(matchingConventions(conventions, "routes/a.ts", ["default", "loader"])).toEqual([
      "route-default",
      "route-loader",
    ]);
  });

  it("names none for an export the conventions do not list, or a file they do not match", () => {
    expect(matchingConventions(conventions, "routes/a.ts", ["helper"])).toEqual([]);
    expect(matchingConventions(conventions, "lib/a.ts", ["default"])).toEqual([]);
  });
});

describe("the Next.js preset, at the package root (next in dependencies)", () => {
  let graph: Graph;
  beforeAll(() => {
    graph = analyze("nextjs");
  });

  it("classifies every framework-called export as an entry naming its convention", () => {
    expect(entryEvidence(graph)).toEqual({
      "app/(marketing)/about/layout.tsx:AboutLayout": ["nextjs/app-file"],
      "app/(marketing)/about/layout.tsx:generateMetadata": ["nextjs/app-metadata"],
      "app/@modal/(.)photo/[id]/page.tsx:PhotoModal": ["nextjs/app-file"],
      "app/@modal/default.tsx:ModalDefault": ["nextjs/app-file"],
      "app/api/users/route.ts:GET": ["nextjs/app-route-handler"],
      "app/api/users/route.ts:HEAD": ["nextjs/app-route-handler"],
      "app/api/users/route.ts:OPTIONS": ["nextjs/app-route-handler"],
      "app/api/users/route.ts:POST": ["nextjs/app-route-handler"],
      "app/api/users/route.ts:write": ["nextjs/app-route-handler"],
      "app/blog/[slug]/page.tsx:BlogPost": ["nextjs/app-file"],
      "app/blog/[slug]/page.tsx:generateStaticParams": ["nextjs/app-static-params"],
      "app/error.tsx:ErrorBoundary": ["nextjs/app-file"],
      "app/layout.tsx:RootLayout": ["nextjs/app-file"],
      "app/loading.tsx:Loading": ["nextjs/app-file"],
      "app/not-found.tsx:NotFound": ["nextjs/app-file"],
      "app/page.tsx:HomePage": ["nextjs/app-file"],
      "app/template.tsx:Template": ["nextjs/app-file"],
      "instrumentation.ts:register": ["nextjs/instrumentation"],
      "middleware.ts:middleware": ["nextjs/middleware"],
      "pages/_app.tsx:App": ["nextjs/pages"],
      "pages/_document.tsx:Document": ["nextjs/pages"],
      "pages/api/hello.ts:handler": ["nextjs/pages"],
      "pages/dashboard.tsx:Dashboard": ["nextjs/pages"],
      "pages/dashboard.tsx:getServerSideProps": ["nextjs/pages"],
      "pages/index.tsx:Index": ["nextjs/pages"],
      "pages/index.tsx:getStaticProps": ["nextjs/pages"],
      "pages/posts/[id].tsx:Post": ["nextjs/pages"],
      "pages/posts/[id].tsx:getStaticPaths": ["nextjs/pages"],
      "pages/posts/[id].tsx:getStaticProps": ["nextjs/pages"],
    });
  });

  it("roots reachability at those entries, leaving only unlisted helpers and true orphans", () => {
    expect(unreachable(graph)).toEqual([
      "dead app/api/users/route.ts:unlistedRouteHelper",
      "dead app/page.tsx:unlistedPageHelper",
      "dead components/page.tsx:NotARoute",
      "dead lib/orphan.ts:orphanUtility",
      "dead pages/dashboard.tsx:unlistedPagesHelper",
    ]);
    expect(kindOf(graph, "app/page.tsx:unlistedPageHelper")).toBe("plain");
  });

  it("reaches what an entry calls", () => {
    expect(unreachable(graph)).not.toContain("dead lib/format.ts:formatHeadline");
    expect(graph.reachability?.reachableCount).toBeGreaterThan(29);
  });

  it("models no non-function export, so segment config and metadata objects never surface", () => {
    const names = new Set(graph.functions.map((fn) => fn.name));
    for (const name of ["metadata", "dynamic", "dynamicParams", "revalidate", "config"]) {
      expect(names.has(name)).toBe(false);
    }
  });
});

describe("the Next.js preset, under src/ (next in devDependencies)", () => {
  it("classifies src/app, src/pages and the src/ root files as entries", () => {
    const graph = analyze("nextjs-src");
    expect(entryEvidence(graph)).toEqual({
      "src/app/dashboard/route.ts:GET": ["nextjs/app-route-handler"],
      "src/app/page.tsx:HomePage": ["nextjs/app-file"],
      "src/instrumentation.ts:register": ["nextjs/instrumentation"],
      "src/middleware.ts:middleware": ["nextjs/middleware"],
      "src/pages/api/ping.ts:ping": ["nextjs/pages"],
    });
    expect(unreachable(graph)).toEqual([
      "dead lib/orphan.ts:orphanUtility",
      "dead src/app/page.tsx:unlistedPageHelper",
    ]);
  });
});

describe("activation", () => {
  it("leaves the preset off for a package that does not depend on next", () => {
    const graph = analyze("plain");
    expect(kindOf(graph, "app/page.tsx:HomePage")).toBe("plain");
    expect(unreachable(graph)).toContain("dead app/page.tsx:HomePage");
  });

  it("turns it on by opt-in where the package does not depend on next", () => {
    const graph = analyze("plain", { entryExportPresets: ["nextjs"] });
    expect(entryEvidence(graph)).toEqual({ "app/page.tsx:HomePage": ["nextjs/app-file"] });
    expect(unreachable(graph)).not.toContain("dead app/page.tsx:HomePage");
  });
});

describe("a user-supplied convention", () => {
  const jobs = { "job-runner": { files: "jobs/*.ts", exports: ["run"] } };

  it("works with no preset active, and still judges the file's unlisted exports", () => {
    const graph = analyze("plain", { entryExportConventions: jobs });
    expect(entryEvidence(graph)).toEqual({ "jobs/cleanup.ts:run": ["job-runner"] });
    expect(unreachable(graph)).toEqual([
      "dead app/page.tsx:HomePage",
      "dead jobs/cleanup.ts:unlistedJobHelper",
      "dead lib/format.ts:formatHeadline",
      "dead lib/orphan.ts:orphanUtility",
    ]);
  });

  it("adds to an active preset rather than replacing it", () => {
    const withPreset = entryEvidence(analyze("nextjs"));
    const graph = analyze("nextjs", {
      entryExportConventions: {
        "orphan-hook": { files: "lib/orphan.ts", exports: ["orphanUtility"] },
      },
    });
    expect(entryEvidence(graph)).toEqual({
      ...withPreset,
      "lib/orphan.ts:orphanUtility": ["orphan-hook"],
    });
  });
});

describe("--node-kinds and --entry-preset", () => {
  let tmpRoot: string;
  beforeAll(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-conventions-")));
  });
  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const resolve = (body: unknown): { rules: NodeKindRules | null; reported: string[] } => {
    const file = path.join(tmpRoot, `rules-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(body));
    const reported: string[] = [];
    return { rules: resolveNodeKindRules(file, (m) => reported.push(m)), reported };
  };

  it("reads conventions and presets from the rules file, keeping every other group", () => {
    const { rules, reported } = resolve({
      entryExportConventions: { "job-runner": { files: "jobs/*.ts", exports: ["run"] } },
      entryExportPresets: ["nextjs"],
    });
    expect(reported).toEqual([]);
    expect(rules?.entryExportPresets).toEqual(["nextjs"]);
    expect(rules?.entryExportConventions).toEqual({
      "job-runner": { files: "jobs/*.ts", exports: ["run"] },
    });
    expect(rules?.entryNames).toEqual(NodeKindRulesSchema.parse({}).entryNames);
  });

  it("refuses an unbalanced glob, an unknown preset and an empty export list", () => {
    expect(
      resolve({ entryExportConventions: { bad: { files: "jobs/{a", exports: ["run"] } } }).reported,
    ).toEqual(['invalid glob in entry-export convention "bad": unclosed "{" in glob "jobs/{a".']);
    expect(resolve({ entryExportPresets: ["remix"] }).rules).toBeNull();
    expect(
      resolve({ entryExportConventions: { empty: { files: "a.ts", exports: [] } } }).rules,
    ).toBeNull();
  });

  it("adds a command-line preset to the file's own and refuses an unknown one", () => {
    const reported: string[] = [];
    const base = NodeKindRulesSchema.parse({});
    expect(withEntryPresets(base, ["nextjs"], (m) => reported.push(m))?.entryExportPresets).toEqual(
      ["nextjs"],
    );
    expect(withEntryPresets(base, ["remix"], (m) => reported.push(m))).toBeNull();
    expect(reported).toEqual(['unknown --entry-preset "remix"; expected one of: nextjs.']);
  });
});
