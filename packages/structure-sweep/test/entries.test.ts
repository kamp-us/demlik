import { describe, expect, it } from "vitest";
import { planScope } from "../src/move/cli.js";
import { entryFiles } from "../src/move/entries.js";
import type { VerdictRow } from "../src/move/manifest.js";
import { fixtureVocabulary, gitIn, repo } from "./helpers.js";

const confident = (path: string): VerdictRow => ({
  path,
  answers: {
    feature: { choice: "audit_runs", confidence: 0.95 },
    role: { choice: "api_surface" },
  },
});

const tsx = "export default function Page() {\n  return null;\n}\n";

function planAll(root: string, scope: string) {
  const tree = gitIn(root, "ls-files", "--", scope).split("\n").filter(Boolean);
  return planScope({
    root,
    scope,
    vocabulary: fixtureVocabulary(),
    features: ["audit_runs"],
    floor: 0.8,
    verdicts: tree.filter((p) => /\.tsx?$/.test(p)).map(confident),
  });
}

describe("entry files pinned by Next.js convention", () => {
  const NEXT_ENTRIES = [
    "apps/web/src/app/page.tsx",
    "apps/web/src/app/layout.tsx",
    "apps/web/src/app/loading.tsx",
    "apps/web/src/app/error.tsx",
    "apps/web/src/app/not-found.tsx",
    "apps/web/src/app/template.tsx",
    "apps/web/src/app/(dashboard)/runs/page.tsx",
    "apps/web/src/app/(dashboard)/runs/[id]/layout.tsx",
    "apps/web/src/app/(dashboard)/@modal/default.tsx",
    "apps/web/src/app/api/runs/route.ts",
    "apps/web/src/middleware.ts",
  ];
  const ORDINARY = [
    "apps/web/src/app/(dashboard)/runs/run-table.tsx",
    "apps/web/src/lib/format.ts",
  ];

  it("never moves a page, layout, route, loading, error, not-found, template, default or middleware file", () => {
    const root = repo({
      "apps/web/package.json": JSON.stringify({
        name: "web",
        dependencies: { next: "15.0.0" },
      }),
      "apps/web/tsconfig.json": JSON.stringify({
        compilerOptions: { jsx: "preserve" },
      }),
      ...Object.fromEntries(
        [...NEXT_ENTRIES, ...ORDINARY].map((p) => [p, tsx]),
      ),
      // An import between the two ordinary files, so the graph pulls them where Jev puts them.
      [ORDINARY[0] as string]: `import "../../../lib/format";\n${tsx}`,
    });
    const manifest = planAll(root, "apps/web");

    const moved = manifest.moves.map((m) => m.from);
    for (const entry of NEXT_ENTRIES) expect(moved).not.toContain(entry);
    expect(manifest.pinned.map((p) => p.path).sort()).toEqual(
      [...NEXT_ENTRIES].sort(),
    );
    expect(moved.sort()).toEqual([...ORDINARY].sort());
    expect(
      manifest.pinned.find((p) => p.path.endsWith("runs/page.tsx"))?.entry,
    ).toBe("Next.js src/app/ page");
  });

  it("reads an app/ directory at the project root too", () => {
    const root = repo({
      "apps/site/app/page.tsx": tsx,
      "apps/site/app/blog/[slug]/page.tsx": tsx,
      "apps/site/middleware.ts": "export function middleware() {}\n",
      "apps/site/app/blog/post-card.tsx": tsx,
    });
    const tree = gitIn(root, "ls-files").split("\n").filter(Boolean);
    expect([...entryFiles(root, "apps/site", tree).keys()].sort()).toEqual([
      "apps/site/app/blog/[slug]/page.tsx",
      "apps/site/app/page.tsx",
      "apps/site/middleware.ts",
    ]);
  });
});

describe("entry files mapped back from dist/ to src/", () => {
  it("pins src/index.ts for a package whose bin is ./dist/index.js", () => {
    const root = repo({
      "packages/cli/package.json": JSON.stringify({
        name: "cli",
        bin: { cli: "./dist/index.js" },
        main: "./dist/index.js",
      }),
      "packages/cli/tsconfig.json": JSON.stringify({ include: ["src"] }),
      "packages/cli/src/index.ts":
        'import { commands } from "./commands";\nexport const run = () => commands;\n',
      "packages/cli/src/commands.ts": "export const commands = [];\n",
    });
    const manifest = planAll(root, "packages/cli");
    expect(manifest.pinned).toContainEqual({
      path: "packages/cli/src/index.ts",
      entry: "package.json main (source of dist/index.js)",
    });
    expect(manifest.moves.map((m) => m.from)).toEqual([
      "packages/cli/src/commands.ts",
    ]);
  });

  it("follows tsup's entry map when the output name differs from the source path", () => {
    const root = repo({
      "packages/tool/package.json": JSON.stringify({
        bin: { tool: "./dist/cli.js" },
        exports: {
          "./project": {
            import: "./dist/project.js",
            types: "./dist/project.d.ts",
          },
        },
      }),
      "packages/tool/tsup.config.ts": `import { defineConfig } from "tsup";\nexport default defineConfig({ entry: { cli: "src/commands/main.ts", project: "src/extract/project.ts" }, format: ["esm"] });\n`,
      "packages/tool/src/commands/main.ts": "export {};\n",
      "packages/tool/src/extract/project.ts": "export {};\n",
    });
    const tree = gitIn(root, "ls-files").split("\n").filter(Boolean);
    const entries = entryFiles(root, "packages/tool", tree);
    expect(entries.get("packages/tool/src/commands/main.ts")).toBe(
      "package.json bin (source of dist/cli.js)",
    );
    expect(entries.has("packages/tool/src/extract/project.ts")).toBe(true);
  });

  it("follows tsconfig outDir back to rootDir", () => {
    const root = repo({
      "packages/lib/package.json": JSON.stringify({ main: "./build/index.js" }),
      "packages/lib/tsconfig.json": `{\n  // comments are allowed here\n  "compilerOptions": { "outDir": "build", "rootDir": "src" }\n}\n`,
      "packages/lib/src/index.ts": "export {};\n",
    });
    const tree = gitIn(root, "ls-files").split("\n").filter(Boolean);
    expect(
      entryFiles(root, "packages/lib", tree).get("packages/lib/src/index.ts"),
    ).toBe("package.json main (source of build/index.js)");
  });
});
