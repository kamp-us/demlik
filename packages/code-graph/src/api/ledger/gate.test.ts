import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliRun, runCli } from "../../test-helpers/ratchet-repo.js";
import { API_LEDGER_FILENAME } from "./names.js";

const TSCONFIG = `${JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    skipLibCheck: true,
    types: [],
  },
  include: ["src"],
})}\n`;

const MAP = {
  ".": { entry: "src/index.ts", tier: "stable" },
  "./battery": { entry: "src/battery/index.ts", tier: "battery" },
  "./labs": { entry: "src/labs/index.ts" },
};

// Eight names in each of three entries: a real package's shape, not the two names a mechanism test
// gets away with.
const namesIn = (prefix: string): string =>
  Array.from(
    { length: 8 },
    (_, i) => `export function ${prefix}${i}(value: number): number {\n  return value + ${i};\n}\n`,
  ).join("");

const ENTRIES: Readonly<Record<string, string>> = {
  "src/index.ts": namesIn("core"),
  "src/battery/index.ts": namesIn("battery"),
  "src/labs/index.ts": namesIn("labs"),
};

let top: string;
let scratch: string;
let mapFile: string;

// `root` holds a package with no `.changeset/` folder and no git history.
function writePackage(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{ "name": "@demo/ledger" }\n');
  fs.writeFileSync(path.join(root, "tsconfig.json"), TSCONFIG);
  for (const [relative, text] of Object.entries(ENTRIES)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

const append = (root: string, relative: string, text: string): void => {
  fs.appendFileSync(path.join(root, relative), text);
};

const check = (root: string, ...extra: string[]): CliRun =>
  runCli([root, "--api", mapFile, "--ci", ...extra]);
const accept = (root: string, reason: string, ...extra: string[]): CliRun =>
  runCli([root, "--api", mapFile, "--accept-api", "--reason", reason, ...extra]);

type Entry = { scope: string; subpath: string; name: string; reason: string };
const ledgerText = (root: string): string =>
  fs.readFileSync(path.join(root, API_LEDGER_FILENAME), "utf8");
const entries = (root: string): Entry[] => JSON.parse(ledgerText(root)).entries;
const NEW_NAME = "export function added(): number {\n  return 1;\n}\n";

beforeEach(() => {
  top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-api-ledger-")));
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-api-ledger-map-")));
  mapFile = path.join(scratch, "map.json");
  fs.writeFileSync(mapFile, JSON.stringify(MAP));
  writePackage(top);
});

afterEach(() => {
  fs.rmSync(top, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("the API ledger — a repo with no changesets and no git history gates a new public name", () => {
  it("accepts, passes, fails by subpath and name, accepts again, prunes, and settles", () => {
    expect(fs.existsSync(path.join(top, ".changeset"))).toBe(false);
    expect(fs.existsSync(path.join(top, ".git"))).toBe(false);

    const first = check(top);
    expect(first.code).toBe(1);
    expect(fs.existsSync(path.join(top, API_LEDGER_FILENAME))).toBe(false);

    expect(accept(top, "baseline").code).toBe(0);
    expect(entries(top)).toHaveLength(24);
    expect(entries(top)).toContainEqual({
      scope: ".",
      subpath: "./battery",
      name: "battery3",
      reason: "baseline",
    });
    const passed = check(top);
    expect(passed.code).toBe(0);
    expect(passed.stdout).toBe("api ledger: PASS — scope ., 24 recorded name(s), none new.\n");

    append(top, "src/battery/index.ts", NEW_NAME);
    append(top, "src/labs/index.ts", "export const FRESH = 1;\n");
    const failed = check(top);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe(
      [
        `API LEDGER FAILED — 2 name(s) in scope . not in ${API_LEDGER_FILENAME}:`,
        "  ./battery  added",
        "  ./labs  FRESH",
        'Stop publishing each name, or record it by name: --api <map> --accept-api --reason "<why>".',
        "",
      ].join("\n"),
    );
    expect(entries(top)).toHaveLength(24);

    expect(accept(top, "two new names").code).toBe(0);
    expect(entries(top)).toHaveLength(26);
    expect(check(top).code).toBe(0);

    fs.writeFileSync(
      path.join(top, "src/labs/index.ts"),
      `${namesIn("labs").replace(/export function labs7[^}]*}\n/, "")}export const FRESH = 1;\n`,
    );
    const pruned = check(top);
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toContain(
      `pruned 1 entry from ${API_LEDGER_FILENAME} — the name is gone:\n  ./labs  labs7\n`,
    );
    expect(entries(top).map(({ name }) => name)).not.toContain("labs7");

    const settled = ledgerText(top);
    const again = check(top);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe("api ledger: PASS — scope ., 25 recorded name(s), none new.\n");
    expect(ledgerText(top)).toBe(settled);
    expect(check(top)).toEqual(again);
    expect(ledgerText(top)).toBe(settled);
  });

  it("keeps a name a re-accept already holds with the reason it was first given", () => {
    accept(top, "baseline");
    append(top, "src/index.ts", NEW_NAME);
    accept(top, "later");
    const reasons = new Map(entries(top).map(({ name, reason }) => [name, reason]));
    expect(reasons.get("core0")).toBe("baseline");
    expect(reasons.get("added")).toBe("later");
  });

  it("does not fail on a signature change, nor touch the ledger", () => {
    accept(top, "baseline");
    const before = ledgerText(top);
    const file = path.join(top, "src/index.ts");
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace("core0(value: number): number", "core0(value: string, radix?: number): string")
        .replace("return value + 0;", "return value;"),
    );
    expect(check(top).code).toBe(0);
    expect(ledgerText(top)).toBe(before);
  });

  it("prunes a subpath's names when the map drops the subpath", () => {
    accept(top, "baseline");
    const { "./labs": _labs, ...withoutLabs } = MAP;
    fs.writeFileSync(mapFile, JSON.stringify(withoutLabs));
    const run = check(top, "--json");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).pruned).toHaveLength(8);
    expect(entries(top).map(({ subpath }) => subpath)).not.toContain("./labs");
  });

  it("runs no git command, in a folder that is not a git repo", () => {
    const shims = path.join(scratch, "bin");
    const called = path.join(scratch, "git-was-called");
    fs.mkdirSync(shims);
    fs.writeFileSync(path.join(shims, "git"), `#!/bin/sh\ntouch "${called}"\nexit 127\n`, {
      mode: 0o755,
    });
    const env = { PATH: `${shims}${path.delimiter}${process.env.PATH}` };
    const args = [top, "--api", mapFile];
    expect(runCli([...args, "--accept-api", "--reason", "baseline"], env).code).toBe(0);
    expect(runCli([...args, "--ci"], env).code).toBe(0);
    expect(fs.existsSync(called)).toBe(false);
  });

  it("prints the verdict as one object with --json, and writes it to --out", () => {
    accept(top, "baseline");
    append(top, "src/battery/index.ts", NEW_NAME);
    const file = path.join(top, "src/labs/index.ts");
    fs.writeFileSync(file, namesIn("labs").replace(/export function labs7[^}]*}\n/, ""));

    const json = check(top, "--json");
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      passed: false,
      scope: ".",
      unrecorded: [{ scope: ".", subpath: "./battery", name: "added" }],
      pruned: [{ scope: ".", subpath: "./labs", name: "labs7", reason: "baseline" }],
    });

    const out = path.join(scratch, "verdict.txt");
    const written = check(top, "--out", out);
    expect(written.code).toBe(1);
    expect(fs.readFileSync(out, "utf8")).toContain("./battery  added");
  });

  it("prints the accept's result as one object with --json", () => {
    const run = accept(top, "baseline", "--json");
    expect(run.code).toBe(0);
    const printed = JSON.parse(run.stdout);
    expect(printed).toMatchObject({ scope: ".", pruned: [], reason: "baseline" });
    expect(printed.accepted).toHaveLength(24);
  });

  it("touches only its own package's entries in a workspace", () => {
    const workspace = path.join(top, "repo");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const one = path.join(workspace, "packages", "one");
    const two = path.join(workspace, "packages", "two");
    writePackage(one);
    writePackage(two);

    accept(one, "first");
    accept(two, "second");
    expect(fs.existsSync(path.join(one, API_LEDGER_FILENAME))).toBe(false);
    expect(entries(workspace)).toHaveLength(48);

    fs.writeFileSync(path.join(two, "src/labs/index.ts"), "export const ONLY = 1;\n");
    expect(check(two).code).toBe(1);
    const scopes = entries(workspace).filter(({ name }) => name === "labs0");
    expect(scopes.map(({ scope }) => scope)).toEqual(["packages/one"]);
    expect(check(one).code).toBe(0);
  });
});

describe("the API ledger — refusals exit 2, print one line and write nothing", () => {
  it.each([
    ["--accept-api without --reason", ["--accept-api"]],
    ["--accept-api with a blank --reason", ["--accept-api", "--reason", "  "]],
    ["--accept-api with --ci", ["--accept-api", "--ci", "--reason", "baseline"]],
    ["--ci with --reason", ["--ci", "--reason", "baseline"]],
    ["--ci with a gate flag", ["--ci", "--unreachable"]],
    ["--accept-api with --api-base", ["--accept-api", "--reason", "baseline", "--api-base", "x"]],
    ["--ci with --api-base", ["--ci", "--api-base", "HEAD"]],
    ["--reason alone", ["--reason", "baseline"]],
  ])("%s", (_, flags) => {
    const run = runCli([top, "--api", mapFile, ...flags]);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(fs.existsSync(path.join(top, API_LEDGER_FILENAME))).toBe(false);
  });

  it("--accept-api without --api", () => {
    const run = runCli([top, "--accept-api", "--reason", "baseline"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--accept-api needs --api <map>");
    expect(fs.existsSync(path.join(top, API_LEDGER_FILENAME))).toBe(false);
  });

  it.each([
    ["unreadable JSON", "{ not json"],
    ["a schema-invalid entry", '{ "entries": [{ "scope": ".", "subpath": "." }] }\n'],
    [
      "a blank reason",
      '{ "entries": [{ "scope": ".", "subpath": ".", "name": "core0", "reason": " " }] }\n',
    ],
    [
      "a duplicate",
      `{ "entries": [${Array(2)
        .fill('{ "scope": ".", "subpath": ".", "name": "core0", "reason": "kept" }')
        .join(", ")}] }\n`,
    ],
  ])("exits 2 before any emit on %s", (_, text) => {
    // With no tsconfig the emit could not start, so a refusal naming the ledger came before it.
    fs.rmSync(path.join(top, "tsconfig.json"));
    const file = path.join(top, API_LEDGER_FILENAME);
    fs.writeFileSync(file, text);
    for (const flags of [["--ci"], ["--accept-api", "--reason", "baseline"]]) {
      const run = runCli([top, "--api", mapFile, ...flags]);
      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr.trim().split("\n")).toHaveLength(1);
      expect(run.stderr).toContain(API_LEDGER_FILENAME);
      expect(fs.readFileSync(file, "utf8")).toBe(text);
    }
  });

  it("writes nothing when the map is bad, whatever the ledger holds", () => {
    fs.writeFileSync(mapFile, "{}");
    accept(top, "baseline");
    expect(fs.existsSync(path.join(top, API_LEDGER_FILENAME))).toBe(false);
    expect(check(top).code).toBe(2);
  });
});

describe("the API ledger leaves the other --api runs as they were", () => {
  it("keeps --api-base's refusal of --ci word for word", () => {
    const run = runCli([top, "--api", mapFile, "--api-base", "HEAD", "--ci"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toBe(
      "code-graph: --api takes only --api-base, --api-policy, --json, --pretty and --out; got --ci\n",
    );
  });

  it("does not read the ledger on a view run", () => {
    fs.writeFileSync(path.join(top, API_LEDGER_FILENAME), "{ not json");
    expect(runCli([top, "--api", mapFile]).code).toBe(0);
  });

  it("leaves a plain --ci to the smell gate", () => {
    const run = runCli([top, "--ci"]);
    expect(run.stdout).toContain("code-graph CI:");
    expect(fs.existsSync(path.join(top, API_LEDGER_FILENAME))).toBe(false);
  });
});
