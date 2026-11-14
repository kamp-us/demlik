import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PACKAGE_DIR } from "../../test-helpers/ratchet-repo.js";

// The committed doc-report fixture (test/api/docs): the package `@demo/docs` in `base/`, with 48
// published declarations over six source files, three subpaths, a namespace export and three
// exports the report leaves out; its API map; its shape file; and the report it prints.
export const DOCS_FIXTURE = path.join(PACKAGE_DIR, "test", "api", "docs");
export const DOCS_MAP = path.join(DOCS_FIXTURE, "api-map.json");
export const DOCS_SHAPE = path.join(DOCS_FIXTURE, "shape.json");
export const DOCS_REPORT = fs.readFileSync(
  path.join(DOCS_FIXTURE, "expected", "report.txt"),
  "utf8",
);
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");

export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

// The dependency `src/index.ts` re-exports a name from. It is written here because a committed
// `node_modules` folder is ignored.
const DEPENDENCY: Readonly<Record<string, string>> = {
  "node_modules/@demo/dep/package.json": '{ "name": "@demo/dep", "types": "index.d.ts" }\n',
  "node_modules/@demo/dep/index.d.ts": "export declare const depThing: number;\n",
};

// A throwaway copy of the fixture package, in a folder that is no git repository.
export function docsPackage(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-docs-")));
  fs.cpSync(path.join(DOCS_FIXTURE, "base"), root, { recursive: true });
  writeFiles(root, DEPENDENCY);
  return root;
}

export const removePackage = (root: string): void => {
  fs.rmSync(root, { recursive: true, force: true });
};

export type DocsRun = { readonly code: number; readonly stdout: string; readonly stderr: string };

// The CLI as a shell runs it, with stderr kept on a run that exits 0.
export function runDocsCli(args: readonly string[]): DocsRun {
  const run = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
  });
  return { code: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

// Every file under `root` with a hash of its bytes, to show a run wrote nothing.
export function snapshot(root: string): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else
        files[path.relative(root, file)] = createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex");
    }
  };
  walk(root);
  return files;
}
