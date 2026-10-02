import { afterEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import { reportOf, sorted } from "../../test-helpers/library-report.js";
import { SHOP_TSCONFIG } from "../../test-helpers/shop-workspace.js";
import { ledgerTargetOf } from "../ledger.js";
import { workspaceAt } from "./workspaces.js";

describe("workspaceAt", () => {
  const roots = new Set([".", "packages/util", "services/api", "services/api/packages/inner"]);

  it("is the nearest root at or above the path, the path itself included", () => {
    expect(workspaceAt(roots, "packages/util")).toBe("packages/util");
    expect(workspaceAt(roots, "packages/util/src/x")).toBe("packages/util");
    expect(workspaceAt(roots, "services/api/packages/inner/src")).toBe(
      "services/api/packages/inner",
    );
    expect(workspaceAt(roots, "services/api/src/x")).toBe("services/api");
    expect(workspaceAt(roots, "tools/x")).toBe(".");
    expect(workspaceAt(roots, ".")).toBe(".");
  });

  it("is none where no root is above the path, or the path leaves the repo", () => {
    const noRoot = new Set(["packages/util"]);
    expect(workspaceAt(noRoot, "tools/x")).toBeNull();
    expect(workspaceAt(noRoot, ".")).toBeNull();
    expect(workspaceAt(roots, "../elsewhere/x")).toBeNull();
    expect(workspaceAt(roots, "..")).toBeNull();
  });
});

const OTHER = "packages/other-package";
const RULES = {
  features: { "services/api": ["orders"] },
  acrossDeployables: ["relative-import-crosses-workspace"],
};

const BASE: Record<string, string> = {
  "tsconfig.json": SHOP_TSCONFIG,
  "services/api/package.json": JSON.stringify({ name: "@shop/api" }),
  [`${OTHER}/package.json`]: JSON.stringify({ name: "@shop/other-package" }),
  [`${OTHER}/src/x.ts`]: "export const x = 1;\n",
  [`${OTHER}/src/y.ts`]: "export const y = 1;\n",
  "services/api/src/shared/format.ts": "export const format = 1;\n",
};

let repo: BoundaryRepo | null = null;
const open = (files: Record<string, string>, rules: unknown = RULES): BoundaryRepo => {
  repo = boundaryRepo(".", { ...BASE, ...files }, rules);
  return repo;
};
afterEach(() => repo?.dispose());

type Crossing = { scope: string; from: string; to: string; specifier: string; typeOnly: boolean };

function crossingsOf(run: ReturnType<BoundaryRepo["run"]>): Crossing[] {
  return reportOf(run).scopes.flatMap((s) =>
    s.violations
      .filter((v) => v.kind === "relative-import-crosses-workspace")
      .map((v) => ({
        scope: s.scope,
        from: v.from,
        to: ledgerTargetOf(v),
        specifier: v.specifier,
        typeOnly: v.typeOnly,
      })),
  );
}

const reach = (files: Record<string, string>, rules?: unknown): Crossing[] =>
  crossingsOf(open(files, rules).run({ json: true }));
const API = "services/api";
const up = (n: number): string => "../".repeat(n);

describe("B19 relative-import-crosses-workspace", () => {
  it("is one entry each for a path into another package from a test, from source and from a fixture", () => {
    const body = (n: number) =>
      `import { x } from "${up(n)}${OTHER}/src/x";\nexport const v = x;\n`;
    const files = {
      [`${API}/src/orders/a.ts`]: body(4),
      [`${API}/src/orders/a.test.ts`]: body(4),
      [`${API}/test/fixtures/f.ts`]: body(4),
    };
    expect(reach(files).map((c) => [c.scope, c.from, c.to])).toEqual(
      sorted(Object.keys(files).map((file) => [API, file, OTHER])),
    );
  });

  it("judges a static import, export from, a dynamic import and a type-only import", () => {
    const path = `${up(4)}${OTHER}/src/x`;
    const files = {
      [`${API}/src/orders/static.ts`]: `import { x } from "${path}";\nexport const v = x;\n`,
      [`${API}/src/orders/export.ts`]: `export { x } from "${path}";\n`,
      [`${API}/src/orders/dynamic.ts`]: `export const load = () => import("${path}");\n`,
      [`${API}/src/orders/types.ts`]: `import type { x } from "${path}";\nexport type T = typeof x;\n`,
    };
    const found = reach(files);
    expect(found.map((c) => c.from).sort()).toEqual(Object.keys(files).sort());
    expect(found.filter((c) => c.typeOnly).map((c) => c.from)).toEqual([
      `${API}/src/orders/types.ts`,
    ]);
  });

  it("is one entry for two imports into one other workspace: the first specifier, type-only only if all are", () => {
    const files = {
      [`${API}/src/orders/mixed.ts`]: [
        `import type { x } from "${up(4)}${OTHER}/src/x";`,
        `import { y } from "${up(4)}${OTHER}/src/y";`,
        "export const v = [y];",
        "",
      ].join("\n"),
      [`${API}/src/orders/types.ts`]: [
        `import type { x } from "${up(4)}${OTHER}/src/x";`,
        `import type { y } from "${up(4)}${OTHER}/src/y";`,
        "export type T = [typeof x, typeof y];",
        "",
      ].join("\n"),
    };
    const byFrom = new Map(reach(files).map((c) => [c.from, c]));
    expect(byFrom.size).toBe(2);
    expect(byFrom.get(`${API}/src/orders/mixed.ts`)).toMatchObject({
      specifier: `${up(4)}${OTHER}/src/x`,
      typeOnly: false,
    });
    expect(byFrom.get(`${API}/src/orders/types.ts`)).toMatchObject({ typeOnly: true });
  });

  it("is one entry per other workspace, so two importers of one workspace are two and two workspaces one importer reaches are two", () => {
    const files = {
      "packages/third/package.json": JSON.stringify({ name: "@shop/third" }),
      [`${API}/src/orders/both.ts`]: [
        `import { x } from "${up(4)}${OTHER}/src/x";`,
        `import { t } from "${up(4)}packages/third/t";`,
        "export const v = [x, t];",
        "",
      ].join("\n"),
    };
    expect(reach(files).map((c) => c.to)).toEqual(["packages/other-package", "packages/third"]);
  });

  it("leaves an import inside one workspace through ../ clean, and a nested workspace's own siblings", () => {
    const files = {
      [`${API}/src/orders/a.ts`]:
        'import { format } from "../shared/format";\nexport const v = format;\n',
      [`${API}/packages/inner/package.json`]: JSON.stringify({ name: "@shop/inner" }),
      [`${API}/packages/inner/lib/b.ts`]: "export const b = 1;\n",
      [`${API}/packages/inner/src/a.ts`]: 'import { b } from "../lib/b";\nexport const v = b;\n',
    };
    expect(reach(files)).toEqual([]);
  });

  it("judges an import out of a workspace nested in the scope into the scope's own", () => {
    const files = {
      [`${API}/packages/inner/package.json`]: JSON.stringify({ name: "@shop/inner" }),
      [`${API}/packages/inner/src/a.ts`]:
        'import { format } from "../../../src/shared/format";\nexport const v = format;\n',
    };
    expect(reach(files).map((c) => [c.from, c.to])).toEqual([
      [`${API}/packages/inner/src/a.ts`, API],
    ]);
  });

  it("judges an import of a path that does not exist, because it reads the path and not the file", () => {
    const files = {
      [`${API}/src/orders/a.ts`]: `import { m } from "${up(4)}${OTHER}/src/missing";\nexport const v = m;\n`,
    };
    expect(reach(files).map((c) => c.to)).toEqual([OTHER]);
  });

  it("does not judge a path alias or a bare specifier", () => {
    const files = {
      [`${API}/src/orders/a.ts`]: [
        'import { x } from "@shop/other-package/src/x";',
        'import { a } from "#alias/a";',
        'import { z } from "zod";',
        "export const v = [x, a, z];",
        "",
      ].join("\n"),
    };
    expect(reach(files)).toEqual([]);
  });

  it("judges a file in no workspace by its scope root", () => {
    const rules = { features: { tools: ["x"] }, acrossDeployables: RULES.acrossDeployables };
    const files = {
      "tools/src/x/a.ts": `import { x } from "${up(3)}${OTHER}/src/x";\nexport const v = x;\n`,
      "tools/src/x/b.ts": 'import { c } from "./c";\nexport const v = c;\n',
      "tools/src/x/c.ts": "export const c = 1;\n",
    };
    expect(reach(files, rules).map((c) => [c.scope, c.from, c.to])).toEqual([
      ["tools", "tools/src/x/a.ts", OTHER],
    ]);
  });

  it("places a target in no workspace in the scope root, and takes the repo root as a workspace only when it holds a package.json", () => {
    const files = {
      [`${API}/src/orders/a.ts`]: `import { s } from "${up(4)}scripts/s";\nexport const v = s;\n`,
      "scripts/s.ts": "export const s = 1;\n",
    };
    expect(reach(files)).toEqual([]);
    repo?.dispose();
    const withRoot = { ...files, "package.json": JSON.stringify({ name: "root" }) };
    expect(reach(withRoot).map((c) => [c.from, c.to])).toEqual([[`${API}/src/orders/a.ts`, "."]]);
  });

  it("judges a file under a library nested in a feature scope in the library's own scope only", () => {
    const rules = {
      ...RULES,
      libraryTypes: { util: { imports: ["util"], pure: false } },
      libraries: { [`${API}/packages/inner`]: "util" },
    };
    const files = {
      [`${API}/packages/inner/package.json`]: JSON.stringify({ name: "@shop/inner" }),
      [`${API}/packages/inner/src/a.ts`]: `import { x } from "${up(5)}${OTHER}/src/x";\nexport const v = x;\n`,
    };
    expect(reach(files, rules).map((c) => [c.scope, c.from])).toEqual([
      [`${API}/packages/inner`, `${API}/packages/inner/src/a.ts`],
    ]);
  });
});
