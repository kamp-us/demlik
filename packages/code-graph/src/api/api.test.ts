import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiInputError, type PublishedApi, readPublishedApi } from "../api.js";
import { tsgoBinary } from "../engine/tsgo.js";
import { stableStringify } from "../render/json.js";

// The committed fixture package (test/api/fixture): four entries over a function, an overloaded
// function, a type alias, an interface, a class, a const with an inferred return type, two private
// types a published name reads, and `hidden`, which no entry publishes.
const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(here, "..", "..");
const FIXTURE = path.join(PACKAGE_DIR, "test", "api", "fixture");
const MAP_FILE = path.join(FIXTURE, "api-map.json");
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");
const map: unknown = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));

const STEP = { "src/fns.d.ts#Step": "type Step = {\n    readonly by: number;\n};" };
const PLAIN = "export declare function plain(n: number, step?: Step): number;";

const expectedSubpaths = (): PublishedApi["subpaths"] => ({
  ".": {
    entry: "src/index.ts",
    tier: "stable",
    names: {
      Alias: { text: "export type Alias = {\n    readonly id: string;\n};", references: {} },
      Shape: {
        text: "export interface Shape {\n    readonly side: number;\n    readonly corner: Corner;\n}",
        references: {
          "src/types.d.ts#Corner":
            "interface Corner {\n    readonly x: number;\n    readonly y: number;\n}",
        },
      },
      over: {
        text: "export declare function over(a: string): string;\nexport declare function over(a: number): number;",
        references: {},
      },
      plain: { text: PLAIN, references: STEP },
    },
  },
  "./relay": {
    entry: "src/relay/index.ts",
    tier: "experimental",
    names: { LIMIT: { text: "export declare const LIMIT = 3;", references: {} } },
  },
  "./renamed": {
    entry: "src/renamed/index.ts",
    tier: null,
    names: { increment: { text: PLAIN, references: STEP } },
  },
  "./testing": {
    entry: "src/testing/index.ts",
    tier: "stable",
    names: {
      Box: { text: "export declare class Box {\n    readonly v = 1;\n}", references: {} },
      make: { text: "export declare const make: () => {\n    a: number;\n};", references: {} },
    },
  },
});

const quiet = { warn: () => {} };
const scratch: string[] = [];

// A copy of the fixture with one file rewritten, so a single change is the only difference.
function editedFixture(file: string, from: string, to: string): string {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-api-test-"));
  scratch.push(copy);
  fs.cpSync(FIXTURE, copy, { recursive: true });
  const target = path.join(copy, file);
  const before = fs.readFileSync(target, "utf8");
  expect(before).toContain(from);
  fs.writeFileSync(target, before.replace(from, to));
  return copy;
}

let view: PublishedApi;

beforeAll(async () => {
  view = await readPublishedApi(FIXTURE, map, quiet);
});

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readPublishedApi — the published-API view (SPEC §13.3)", () => {
  it("lists exactly what each entry publishes, with its emitted text and references", async () => {
    expect(view.subpaths).toEqual(expectedSubpaths());
    expect(view.compiler).toBe((await tsgoBinary()).version);
    expect(view.root).toBe(path.relative(process.cwd(), fs.realpathSync(FIXTURE)) || ".");
  });

  it("lists a name no entry publishes under no subpath", () => {
    const listed = Object.values(view.subpaths).flatMap((subpath) => Object.keys(subpath.names));
    expect(listed).not.toContain("hidden");
    expect(JSON.stringify(view)).not.toContain("hidden");
  });

  it("changes a published name's references when only a private type it reads changes", async () => {
    const root = editedFixture("src/fns.ts", "readonly by: number", "readonly by: string");
    const edited = await readPublishedApi(root, map, quiet);
    const changed = { "src/fns.d.ts#Step": "type Step = {\n    readonly by: string;\n};" };
    expect(edited.subpaths["."]?.names.plain).toEqual({ text: PLAIN, references: changed });
    expect(edited.subpaths["./renamed"]?.names.increment).toEqual({
      text: PLAIN,
      references: changed,
    });
    expect(edited.subpaths["./testing"]).toEqual(view.subpaths["./testing"]);
  });

  it("changes a const's text when only its inferred return type changes", async () => {
    const root = editedFixture("src/values.ts", "({ a: 1 })", '({ a: "1" })');
    const edited = await readPublishedApi(root, map, quiet);
    expect(edited.subpaths["./testing"]?.names.make?.text).toBe(
      "export declare const make: () => {\n    a: string;\n};",
    );
  });

  it("drops every comment from a text", async () => {
    const root = editedFixture(
      "src/types.ts",
      "readonly side: number;",
      "/* kept by the emit */ readonly side: number; // and this",
    );
    const edited = await readPublishedApi(root, map, quiet);
    expect(edited.subpaths["."]?.names.Shape).toEqual(view.subpaths["."]?.names.Shape);
  });

  it("gives the same bytes on a second run", async () => {
    const again = await readPublishedApi(FIXTURE, map, quiet);
    expect(stableStringify(again, true)).toBe(stableStringify(view, true));
  });
});

describe("readPublishedApi — inputs it refuses (SPEC §13.2)", () => {
  const refusals: ReadonlyArray<readonly [string, unknown]> = [
    ["an empty map", {}],
    ["an unknown key", { ".": { entry: "src/index.ts", extra: true } }],
    ["an empty entry", { ".": { entry: "" } }],
    ["an empty tier", { ".": { entry: "src/index.ts", tier: "" } }],
    ["an entry that is not TypeScript source", { ".": { entry: "api-map.json" } }],
    ["an entry outside the package", { ".": { entry: "../../../src/api.ts" } }],
    ["an entry that does not exist", { ".": { entry: "src/missing.ts" } }],
  ];

  it.each(refusals)("refuses %s with ApiInputError", async (_, bad) => {
    await expect(readPublishedApi(FIXTURE, bad, quiet)).rejects.toBeInstanceOf(ApiInputError);
  });
});

describe("code-graph --api", () => {
  const run = (args: readonly string[]) => {
    try {
      const stdout = execFileSync(process.execPath, ["--import", "tsx", CLI, FIXTURE, ...args], {
        cwd: PACKAGE_DIR,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string };
      return { code: failed.status, stdout: failed.stdout, stderr: failed.stderr };
    }
  };

  it("prints the library's view as sorted JSON", async () => {
    const printed = run(["--api", MAP_FILE]);
    expect(printed.code).toBe(0);
    const fromCli = JSON.parse(printed.stdout) as PublishedApi;
    expect(fromCli.subpaths).toEqual(expectedSubpaths());
    expect(printed.stdout).toBe(`${stableStringify(JSON.parse(printed.stdout), false)}\n`);
  });

  it("exits 2 and prints nothing beside a flag it does not take", () => {
    const refused = run(["--api", MAP_FILE, "--plan"]);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("--plan");
  });

  it("exits 2 on a map file that is not JSON", () => {
    const refused = run(["--api", path.join(FIXTURE, "src", "index.ts")]);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
  });
});
