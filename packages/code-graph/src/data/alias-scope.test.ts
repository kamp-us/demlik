import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DataReport, DataReportSchema } from "../schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(here, "..", "..");
const FIXTURE = path.join(PACKAGE_DIR, "test", "data", "alias-scope");
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");
const FILE = "workers/app/src/handlers.ts";

let root = "";
let report: DataReport;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-alias-scope-")));
  fs.cpSync(FIXTURE, root, { recursive: true });
  const app = path.join(root, "workers", "app");
  fs.renameSync(path.join(app, "wrangler.fixture.jsonc"), path.join(app, "wrangler.jsonc"));
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const out = execFileSync(process.execPath, ["--import", "tsx", CLI, root, "--data", "--json"], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  report = DataReportSchema.parse(JSON.parse(out));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("--data: an alias is scoped to the function that declares it", () => {
  it("resolves each module-scope sibling handler's `db` to its own binding", () => {
    const rows = report.unattributed.map((s) => [s.file, s.line, s.binding, s.method]);
    expect(rows).toEqual([
      [FILE, 11, "DB", "prepare"],
      [FILE, 15, "OTHER", "prepare"],
    ]);
  });

  it("gives a named function one edge per handler, each to that handler's own binding", () => {
    const rows = report.edges
      .filter((e) => e.functionId === `${FILE}:mount`)
      .map((e) => [e.line, e.binding, e.method]);
    expect(rows).toEqual([
      [23, "DB", "prepare"],
      [27, "OTHER", "prepare"],
    ]);
  });

  it("lets a `db` parameter or a non-binding local shadow a sibling's alias", () => {
    const shadowed = new Set([17, 29, 32]);
    const sites = [...report.edges, ...report.unattributed].filter((s) => shadowed.has(s.line));
    expect(sites).toEqual([]);
  });

  it("still resolves an outer alias inside a callback that does not redeclare it", () => {
    const rows = report.edges
      .filter((e) => e.functionId === `${FILE}:nested`)
      .map((e) => [e.line, e.binding, e.method]);
    expect(rows).toEqual([[39, "DB", "prepare"]]);
  });
});

describe("--data: `let`/`const` aliases are block-scoped, `var` is function-scoped", () => {
  const edgesOf = (name: string) =>
    report.edges
      .filter((e) => e.functionId === `${FILE}:${name}`)
      .map((e) => [e.line, e.binding, e.method]);

  it("lets a nested block's `const db` shadow the outer alias only inside that block", () => {
    expect(edgesOf("blocks")).toEqual([
      [46, "DB", "prepare"],
      [51, "DB", "prepare"],
    ]);
  });

  it("records an edge only in the sibling block that aliases the binding", () => {
    expect(edgesOf("branches")).toEqual([[59, "DB", "prepare"]]);
  });

  it("keeps a block's `var` alias bound after the block closes", () => {
    expect(edgesOf("hoisted")).toEqual([[71, "DB", "prepare"]]);
  });
});
