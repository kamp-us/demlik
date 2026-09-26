import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFakePackages } from "./test-helpers/fake-packages.js";

// The goldens under test/parity/goldens were recorded from the ts-morph engine before the engine
// swap (#397) and are never re-recorded to make this test pass: a diff here is a parity break.
// CODE_GRAPH_PARITY_RECORD=1 rewrites them, which is only honest on the engine they describe.

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(here, "..");
const FIXTURE = path.join(PACKAGE_DIR, "test", "parity", "fixture");
const GOLDENS = path.join(PACKAGE_DIR, "test", "parity", "goldens");
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");
const RECORD = process.env.CODE_GRAPH_PARITY_RECORD === "1";

type View = { readonly name: string; readonly target: string; readonly args: readonly string[] };

const RULES = "<root>/boundary-rules.json";
const FULL_GRAPH = ["--graph", "--unreachable", "--interface-width", "--clusters", "--pretty"];

const VIEWS: readonly View[] = [
  { name: "boundaries.txt", target: "", args: ["--boundaries", "--boundary-rules", RULES] },
  {
    name: "boundaries.json",
    target: "",
    args: ["--boundaries", "--boundary-rules", RULES, "--json", "--pretty"],
  },
  {
    name: "boundaries-ci.json",
    target: "",
    args: ["--boundaries", "--boundary-rules", RULES, "--ci", "--json", "--pretty"],
  },
  { name: "clusters-core.json", target: "apps/core", args: ["--clusters", "--json", "--pretty"] },
  { name: "clusters-svc.json", target: "services/svc", args: ["--clusters", "--json", "--pretty"] },
  { name: "collapse-core.json", target: "apps/core", args: ["--collapse", "--json", "--pretty"] },
  { name: "collapse-core.txt", target: "apps/core", args: ["--collapse"] },
  { name: "collapse-ci.json", target: "", args: ["--collapse", "--ci", "--json", "--pretty"] },
  { name: "smells-core.json", target: "apps/core", args: ["--smells", "--json", "--pretty"] },
  {
    name: "smells-core-edges.json",
    target: "apps/core",
    args: ["--smells", "--edges", "--json", "--pretty"],
  },
  { name: "smells-worker.json", target: "apps/worker", args: ["--smells", "--json", "--pretty"] },
  { name: "kinds-core.json", target: "apps/core", args: ["--kinds", "--json", "--pretty"] },
  { name: "unguarded-core.json", target: "apps/core", args: ["--unguarded", "--json", "--pretty"] },
  {
    name: "unreachable-worker.json",
    target: "apps/worker",
    args: ["--unreachable", "--json", "--pretty"],
  },
  { name: "graph-core-cheap.json", target: "apps/core", args: ["--graph", "--pretty"] },
  { name: "graph-core.json", target: "apps/core", args: [...FULL_GRAPH] },
  { name: "graph-worker.json", target: "apps/worker", args: [...FULL_GRAPH] },
  { name: "graph-svc.json", target: "services/svc", args: ["--graph", "--edges", "--pretty"] },
  { name: "comments-core.json", target: "apps/core", args: ["--comments", "--json", "--pretty"] },
];

let root = "";

function run(view: View): string {
  const target = view.target === "" ? root : path.join(root, view.target);
  const args = view.args.map((a) => a.replace("<root>", root));
  let stdout: string;
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, ["--import", "tsx", CLI, target, ...args], {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    status = failed.status ?? -1;
    stdout = failed.stdout ?? "";
  }
  const relative = path.relative(PACKAGE_DIR, root);
  return `exit ${status}\n${stdout.split(relative).join("<root>").split(root).join("<root>")}`;
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-parity-")));
  fs.cpSync(FIXTURE, root, { recursive: true });
  writeFakePackages(root);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("engine parity: CLI output on the parity fixture matches the ts-morph goldens", () => {
  for (const view of VIEWS) {
    it(
      `${view.name}: ${view.args.filter((a) => a.startsWith("--")).join(" ")}`,
      { timeout: 180_000 },
      () => {
        const actual = run(view);
        const golden = path.join(GOLDENS, view.name);
        if (RECORD) {
          fs.mkdirSync(GOLDENS, { recursive: true });
          fs.writeFileSync(golden, actual);
          return;
        }
        expect(actual).toBe(fs.readFileSync(golden, "utf8"));
      },
    );
  }
});
