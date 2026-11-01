import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../test-helpers/ratchet-repo.js";
import { UNREACHABLE_LEDGER_FILENAME } from "./ledger.js";

const OPTIONS =
  '"strict": true, "module": "ESNext", "moduleResolution": "Bundler", "target": "ES2022"';
const ROOT_TSCONFIG = `{ "compilerOptions": { ${OPTIONS} } }\n`;
const PACKAGE_TSCONFIG = `{ "compilerOptions": { ${OPTIONS}, "baseUrl": ".", "paths": { "@/*": ["./src/*"] } }, "include": ["src"] }\n`;

const USEDA = [
  "export function useda(): number {",
  "  return 1;",
  "}",
  "",
  "export function usedInFn(): number {",
  "  return 2;",
  "}",
  "",
].join("\n");

const MAINA = [
  'import { useda, usedInFn } from "@/useda";',
  "",
  "useda();",
  "",
  "function inner(): number {",
  "  return usedInFn();",
  "}",
  "",
  "inner();",
  "",
].join("\n");

const PACKAGES = ["a", "b", "c"];

function workspace(): Record<string, string> {
  const files: Record<string, string> = {
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "tsconfig.json": ROOT_TSCONFIG,
  };
  for (const name of PACKAGES) {
    files[`packages/${name}/package.json`] = JSON.stringify({ name: `@acme/${name}` });
    files[`packages/${name}/tsconfig.json`] = PACKAGE_TSCONFIG;
    files[`packages/${name}/src/useda.ts`] = USEDA;
    files[`packages/${name}/src/maina.ts`] = MAINA;
  }
  return files;
}

let top: string;

function writeTree(files: Readonly<Record<string, string>>): void {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(top, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

beforeEach(() => {
  top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-per-package-alias-")));
  writeTree(workspace());
});

afterEach(() => {
  fs.rmSync(top, { recursive: true, force: true });
});

const run = (scope: string, ...flags: string[]) =>
  runCli([path.join(top, scope), "--unreachable", ...flags]);

type Report = {
  unreachable: { id: string; category: string }[];
  unusedExports: { id: string }[];
  withheld: { id: string; reason: string }[];
};

function report(scope: string, ...flags: string[]): Report {
  const result = run(scope, "--json", ...flags);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout);
}

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

function gate(scope: string) {
  const result = run(scope, "--ci", "--json");
  return { code: result.code, ...JSON.parse(result.stdout) };
}

describe("a root run over packages that each define their own alias", () => {
  it("reports no false finding and exits clean, on every round", () => {
    for (let round = 0; round < 2; round++) {
      for (const name of PACKAGES) {
        expect(run(`packages/${name}`, "--accept-dead", "--reason", "x").code).toBe(0);
      }
      for (const scope of ["packages/a", "packages/b", "packages/c", "."]) {
        expect(gate(scope).code).toBe(0);
      }
      const root = report(".");
      expect(root.unusedExports).toEqual([]);
      expect(root.unreachable).toEqual([]);
    }
    expect(fs.existsSync(path.join(top, UNREACHABLE_LEDGER_FILENAME))).toBe(false);
  });

  it("names the files whose uses it cannot read, on stderr", () => {
    // `runCli` keeps stderr only for a run that fails, so this run has a real finding to fail on.
    writeTree({ "packages/b/src/orphan.ts": "export const ORPHAN = 1;\n" });
    const { code, stderr } = run(".", "--ci");
    expect(code).toBe(1);
    expect(stderr).toContain("3 file(s) are reached by imports");
    expect(stderr).toContain("packages/b/src/useda.ts");
  });

  it("also clears a --deep package run, which reads the root tsconfig", () => {
    const deep = report("packages/a", "--deep");
    expect(deep.unusedExports).toEqual([]);
    expect(deep.unreachable).toEqual([]);
  });

  it("reads an alias a package inherits through extends", () => {
    writeTree({
      "tsconfig.base.json": `{ "compilerOptions": { ${OPTIONS}, "paths": { "@/*": ["./packages/a/src/*"] } } }\n`,
      "packages/a/tsconfig.json": '{ "extends": "../../tsconfig.base.json", "include": ["src"] }\n',
    });
    const root = report(".");
    expect(ids(root.unusedExports)).toEqual([]);
    expect(ids(root.unreachable)).toEqual([]);
  });

  it("reads an alias a package keeps in a referenced project, in the root and package runs", () => {
    writeTree({
      "packages/a/tsconfig.json":
        '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }\n',
      "packages/a/tsconfig.app.json": PACKAGE_TSCONFIG,
    });
    for (const scope of [".", "packages/a"]) {
      const clean = report(scope);
      expect(clean.unusedExports).toEqual([]);
      expect(clean.unreachable).toEqual([]);
    }
  });

  it("withholds a file the root's own paths send the same import somewhere else", () => {
    writeTree({
      "tsconfig.json": `{ "compilerOptions": { ${OPTIONS}, "paths": { "@/*": ["./src/*"] } } }\n`,
      "src/useda.ts": "export const rootOne = 1;\n",
    });
    const root = report(".");
    expect(ids(root.unusedExports).filter((id) => id.startsWith("packages/"))).toEqual([]);
    expect(ids(root.unreachable)).toEqual([]);
  });
});

describe("the limit: a really unused export in a file reached that way", () => {
  beforeEach(() => {
    fs.appendFileSync(
      path.join(top, "packages/b/src/useda.ts"),
      [
        "export function lonely(): number {",
        "  return 3;",
        "}",
        "",
        "export const LONELY_VALUE = 4;",
        "",
        "export interface LonelyShape {",
        "  n: number;",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("is reported by the package run and not by the root run", () => {
    const pkg = report("packages/b");
    expect(ids(pkg.unreachable)).toEqual(["src/useda.ts:lonely"]);
    expect(ids(pkg.unusedExports)).toEqual([
      "src/useda.ts:constant:LONELY_VALUE",
      "src/useda.ts:interface:LonelyShape",
    ]);

    const root = report(".");
    expect(root.unreachable).toEqual([]);
    expect(root.unusedExports).toEqual([]);
    expect(root.withheld).toContainEqual({
      id: "packages/b/src/useda.ts:lonely",
      reason: "uses-unknown",
    });
  });

  it("fails the package gate and leaves the root gate clean", () => {
    expect(gate("packages/b").code).toBe(1);
    expect(gate(".").code).toBe(0);
  });

  it("is reported by neither run when the package keeps its alias in a referenced project", () => {
    writeTree({
      "packages/b/tsconfig.json":
        '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }\n',
      "packages/b/tsconfig.app.json": PACKAGE_TSCONFIG,
    });
    for (const scope of [".", "packages/b"]) {
      const withheld = report(scope);
      expect(withheld.unreachable).toEqual([]);
      expect(withheld.unusedExports).toEqual([]);
      expect(gate(scope).code).toBe(0);
    }
  });

  it("is reported by neither run when a nested tsconfig holds its own alias to the file", () => {
    writeTree({
      "packages/b/e2e/tsconfig.json": `{ "compilerOptions": { ${OPTIONS}, "baseUrl": ".", "paths": { "@b/*": ["../src/*"] } } }\n`,
      "packages/b/e2e/smoke.ts": 'import { useda } from "@b/useda";\n\nuseda();\n',
    });
    for (const scope of [".", "packages/b"]) {
      const withheld = report(scope);
      expect(withheld.unreachable).toEqual([]);
      expect(withheld.unusedExports).toEqual([]);
      expect(ids(withheld.withheld).some((id) => id.endsWith("src/useda.ts:lonely"))).toBe(true);
      expect(gate(scope).code).toBe(0);
    }
  });
});

describe("what the withholding must not reach", () => {
  it("keeps reporting an export in a file no such import reaches", () => {
    writeTree({
      "packages/b/src/orphan.ts": "export function orphan(): number {\n  return 1;\n}\n",
      "packages/b/src/orphan-value.ts": "export const ORPHAN = 1;\n",
    });
    const root = report(".");
    expect(ids(root.unreachable)).toEqual(["packages/b/src/orphan.ts:orphan"]);
    expect(ids(root.unusedExports)).toEqual(["packages/b/src/orphan-value.ts:constant:ORPHAN"]);
  });

  it("counts a relative caller in another package as a use", () => {
    writeTree({
      "packages/c/src/shared.ts": "export const SHARED = 1;\nexport const UNSHARED = 2;\n",
      "packages/a/src/cross.ts": 'import { SHARED } from "../../c/src/shared.js";\n\nSHARED;\n',
    });
    expect(ids(report(".").unusedExports)).toEqual(["packages/c/src/shared.ts:constant:UNSHARED"]);
    expect(ids(report("packages/c").unusedExports)).toEqual([
      "src/shared.ts:constant:SHARED",
      "src/shared.ts:constant:UNSHARED",
    ]);
  });

  it("counts a workspace import from another package as a use", () => {
    writeTree({
      "packages/c/src/shared.ts": "export const SHARED = 1;\nexport const UNSHARED = 2;\n",
      "packages/a/src/cross.ts": 'import { SHARED } from "@acme/c/src/shared.js";\n\nSHARED;\n',
    });
    const link = path.join(top, "packages/a/node_modules/@acme/c");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(top, "packages/c"), link, "dir");
    expect(ids(report(".").unusedExports)).toEqual(["packages/c/src/shared.ts:constant:UNSHARED"]);
  });

  it("keeps resolving a file whose nearest tsconfig is the root's through the root's paths", () => {
    writeTree({
      "tsconfig.json": `{ "compilerOptions": { ${OPTIONS}, "paths": { "~/*": ["./src/*"] } } }\n`,
      "src/lib.ts": "export const ROOT_USED = 1;\nexport const ROOT_UNUSED = 2;\n",
      "src/app.ts": 'import { ROOT_USED } from "~/lib.js";\n\nROOT_USED;\n',
    });
    expect(ids(report(".").unusedExports)).toEqual(["src/lib.ts:constant:ROOT_UNUSED"]);
  });
});

describe("a false dead finding the identifier check cannot catch", () => {
  beforeEach(() => {
    writeTree({
      "packages/a/src/helper.ts": "export function helper(): number {\n  return 1;\n}\n",
      "packages/a/src/useda.ts": [
        'import { helper } from "./helper.js";',
        "",
        "export default function defaulted(): number {",
        "  return helper();",
        "}",
        "",
      ].join("\n"),
      "packages/a/src/maina.ts": 'import renamed from "@/useda";\n\nrenamed();\n',
    });
  });

  it("withholds a default export called under another name, and what it calls", () => {
    const root = report(".");
    expect(root.unreachable).toEqual([]);
    expect(root.withheld).toEqual(
      expect.arrayContaining([
        { id: "packages/a/src/helper.ts:helper", reason: "called-by-withheld" },
        { id: "packages/a/src/useda.ts:defaulted", reason: "uses-unknown" },
      ]),
    );
  });
});
