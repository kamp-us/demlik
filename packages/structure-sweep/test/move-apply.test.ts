import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyManifest } from "../src/move/apply.js";
import { planScope } from "../src/move/cli.js";
import type { Manifest, VerdictRow } from "../src/move/manifest.js";
import { fixtureVocabulary, gitIn, repo } from "./helpers.js";

const verdict = (path: string, role: string): VerdictRow => ({
  path,
  answers: {
    feature: { choice: "audit_runs", confidence: 0.95 },
    role: { choice: role },
  },
});

function service() {
  return repo({
    "svc/package.json": JSON.stringify({
      name: "svc",
      main: "./dist/index.js",
    }),
    "svc/tsconfig.json": JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
      },
      include: ["src"],
    }),
    "svc/src/index.ts":
      'import { startRun } from "./handlers/runs";\n\nexport default { startRun };\n',
    "svc/src/handlers/runs.ts":
      'import { saveRun } from "../db/run-store";\n\nexport const startRun = () => saveRun();\n',
    "svc/src/handlers/runs.test.ts":
      'import { vi } from "vitest";\nimport { startRun } from "./runs";\n\nvi.mock("../db/run-store");\nstartRun();\n',
    "svc/src/db/run-store.ts": "export const saveRun = () => 1;\n",
    "svc/src/lonely.ts": "export const alone = 1;\n",
  });
}

const read = (root: string, path: string) =>
  readFileSync(join(root, path), "utf8");

const git = (root: string, ...args: string[]) => gitIn(root, ...args).trim();

function plan(root: string) {
  return planScope({
    root,
    scope: "svc",
    vocabulary: fixtureVocabulary(),
    features: ["audit_runs"],
    floor: 0.8,
    verdicts: [
      verdict("svc/src/index.ts", "api_surface"),
      verdict("svc/src/handlers/runs.ts", "api_surface"),
      verdict("svc/src/db/run-store.ts", "persistence"),
    ],
  });
}

/** A copy of `root` at the same HEAD, as a second machine would clone it. */
function cloneOf(root: string): string {
  const copy = join(mkdtempSync(join(tmpdir(), "structure-sweep-clone-")), "r");
  gitIn(root, "clone", "-q", root, copy);
  gitIn(copy, "config", "user.email", "other@example.com");
  gitIn(copy, "config", "user.name", "other");
  gitIn(copy, "config", "commit.gpgsign", "false");
  return copy;
}

const RENAMES = [
  "R100\tsvc/src/db/run-store.ts\tsvc/src/audit-runs/store/run-store.ts",
  "R100\tsvc/src/handlers/runs.test.ts\tsvc/src/audit-runs/api/runs.test.ts",
  "R100\tsvc/src/handlers/runs.ts\tsvc/src/audit-runs/api/runs.ts",
];

describe("applyManifest", () => {
  it("moves files, rewrites the imports that named them, and leaves entry files where they are", () => {
    const root = service();
    const manifest = plan(root);
    expect(manifest.pinned).toContainEqual({
      path: "svc/src/index.ts",
      entry: "package.json main (source of dist/index.js)",
    });

    const report = applyManifest(root, manifest);

    expect(report.moved).toBe(3);
    expect(existsSync(join(root, "svc/src/index.ts"))).toBe(true);
    expect(existsSync(join(root, "svc/src/handlers/runs.ts"))).toBe(false);
    expect(read(root, "svc/src/index.ts")).toContain(
      'from "./audit-runs/api/runs"',
    );
    expect(read(root, "svc/src/audit-runs/api/runs.ts")).toContain(
      'from "../store/run-store"',
    );
    const test = read(root, "svc/src/audit-runs/api/runs.test.ts");
    expect(test).toContain('vi.mock("../store/run-store")');
    expect(test).toContain('from "./runs"');
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("commits the renames alone as 100% renames, then the rewrites with no renames", () => {
    const root = service();
    const before = git(root, "rev-parse", "HEAD");

    const report = applyManifest(root, plan(root));

    expect(report.commits).toEqual({
      rename: git(root, "rev-parse", "HEAD~1"),
      rewrite: git(root, "rev-parse", "HEAD"),
    });
    expect(git(root, "rev-parse", "HEAD~2")).toBe(before);
    expect(
      git(root, "diff", "--name-status", "-M100%", "HEAD~2", "HEAD~1")
        .split("\n")
        .sort(),
    ).toEqual(RENAMES);
    expect(
      git(root, "diff", "--name-status", "-M", "HEAD~1", "HEAD")
        .split("\n")
        .sort(),
    ).toEqual([
      "M\tsvc/src/audit-runs/api/runs.test.ts",
      "M\tsvc/src/audit-runs/api/runs.ts",
      "M\tsvc/src/index.ts",
    ]);
    expect(report.filesTouched).toBe(3);
  });

  it("keeps a moved file's history reachable through git log --follow", () => {
    const root = service();
    const before = git(root, "rev-parse", "HEAD");
    applyManifest(root, plan(root));
    expect(
      git(
        root,
        "log",
        "--follow",
        "--format=%H",
        "--",
        "svc/src/audit-runs/api/runs.ts",
      ).split("\n"),
    ).toContain(before);
  });

  it("makes the rename commit only when the rewrite pass changes no file", () => {
    const root = service();
    const before = git(root, "rev-parse", "HEAD");
    const manifest: Manifest = {
      scope: "svc",
      features: ["audit_runs"],
      floor: 0.8,
      moves: [
        {
          from: "svc/src/lonely.ts",
          to: "svc/src/lib/lonely.ts",
          feature: "audit_runs",
          role: "plumbing",
          confidence: 0.9,
        },
      ],
      review: [],
      pinned: [],
    };

    const report = applyManifest(root, manifest);

    expect(report.commits.rename).toBe(git(root, "rev-parse", "HEAD"));
    expect(report.commits.rewrite).toBeNull();
    expect(git(root, "rev-parse", "HEAD~1")).toBe(before);
    expect(git(root, "diff", "--name-status", "-M100%", "HEAD~1", "HEAD")).toBe(
      "R100\tsvc/src/lonely.ts\tsvc/src/lib/lonely.ts",
    );
    expect(applyManifest(root, manifest)).toMatchObject({
      commits: { rename: null, rewrite: null },
      lint: "untouched",
    });
  });

  it("refuses to start over uncommitted changes, names them, and writes nothing", () => {
    const root = service();
    const manifest = plan(root);
    writeFileSync(join(root, "svc/src/lonely.ts"), "export const alone = 2;\n");
    writeFileSync(join(root, "svc/src/db/run-store.ts"), "export {};\n");
    gitIn(root, "add", "svc/src/db/run-store.ts");
    const head = git(root, "rev-parse", "HEAD");
    const status = git(root, "status", "--porcelain");

    expect(() => applyManifest(root, manifest)).toThrow(
      /uncommitted changes[\s\S]*svc\/src\/db\/run-store\.ts[\s\S]*svc\/src\/lonely\.ts/,
    );
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "status", "--porcelain")).toBe(status);
    expect(existsSync(join(root, "svc/src/handlers/runs.ts"))).toBe(true);
  });

  it("refuses to start while an untracked source sits under the scope, names it, and writes nothing", () => {
    const root = service();
    const manifest = plan(root);
    const scratch = 'import { saveRun } from "./db/run-store";\n\nsaveRun();\n';
    writeFileSync(join(root, "svc/src/scratch.ts"), scratch);
    writeFileSync(join(root, "svc/notes.md"), "not a source\n");
    const head = git(root, "rev-parse", "HEAD");
    const status = git(root, "status", "--porcelain");

    const refusal = (() => {
      try {
        applyManifest(root, manifest);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "no refusal";
    })();
    expect(refusal).toMatch(
      /uncommitted changes[\s\S]*svc\/src\/scratch\.ts \(untracked\)/,
    );
    expect(refusal).not.toContain("notes.md");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "status", "--porcelain")).toBe(status);
    expect(read(root, "svc/src/scratch.ts")).toBe(scratch);
  });

  it("makes identical trees and messages from the same HEAD in two fresh copies", () => {
    const origin = service();
    const manifest = plan(origin);
    const [a, b] = [cloneOf(origin), cloneOf(origin)] as const;

    applyManifest(a, manifest);
    applyManifest(b, manifest);

    for (const rev of ["HEAD~1", "HEAD"]) {
      expect(git(a, "rev-parse", `${rev}^{tree}`)).toBe(
        git(b, "rev-parse", `${rev}^{tree}`),
      );
      expect(git(a, "log", "-1", "--format=%B", rev)).toBe(
        git(b, "log", "-1", "--format=%B", rev),
      );
    }
  });

  it("commits nothing and reports untouched on a second apply", () => {
    const root = service();
    const manifest = plan(root);
    applyManifest(root, manifest);
    const head = git(root, "rev-parse", "HEAD");
    const index = read(root, "svc/src/index.ts");

    const again = applyManifest(root, manifest);

    expect(again).toMatchObject({
      pending: 0,
      done: 3,
      moved: 0,
      filesTouched: 0,
      lint: "untouched",
      commits: { rename: null, rewrite: null },
    });
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(read(root, "svc/src/index.ts")).toBe(index);
  });

  it("makes the rewrite commit alone when a run stopped after the rename commit", () => {
    const root = service();
    const manifest = plan(root);
    applyManifest(root, manifest);
    const finished = git(root, "rev-parse", "HEAD^{tree}");
    const renameCommit = git(root, "rev-parse", "HEAD~1");
    gitIn(root, "reset", "-q", "--hard", renameCommit);

    const resumed = applyManifest(root, manifest);

    expect(resumed.commits.rename).toBeNull();
    expect(resumed.commits.rewrite).toBe(git(root, "rev-parse", "HEAD"));
    expect(git(root, "rev-parse", "HEAD~1")).toBe(renameCommit);
    expect(git(root, "rev-parse", "HEAD^{tree}")).toBe(finished);
  });

  it("refuses a row whose source and destination both exist", () => {
    const root = service();
    const manifest = plan(root);
    const row = manifest.moves.find(
      (m) => m.from === "svc/src/handlers/runs.ts",
    );
    expect(row).toBeDefined();
    const conflicting = {
      ...manifest,
      moves: [{ ...(row as NonNullable<typeof row>), to: "svc/src/index.ts" }],
    };
    expect(() => applyManifest(root, conflicting)).toThrow(/both ends exist/);
  });
});
