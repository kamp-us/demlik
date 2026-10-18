import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, contentHash } from "../src/lowering/artifact.js";
import { moveCommand, planScope } from "../src/move/cli.js";
import type { VerdictRow } from "../src/move/manifest.js";
import { fixtureVocabulary, gitIn, repo } from "./helpers.js";

const git = (root: string, ...args: string[]) => gitIn(root, ...args).trim();

/** A scope of seven sources in four folders; `lib/format` is imported by four of them. */
function shop() {
  return repo({
    "app/tsconfig.json": JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
      },
      include: ["src"],
    }),
    "app/src/index.ts":
      'import { money } from "./lib/format";\nimport { total } from "./orders/total";\nimport { name } from "./users/name";\n\nexport const receipt = () => [name(), money(total())].join(" ");\n',
    "app/src/lib/format.ts":
      'export const money = (n: number) => "$" + n.toFixed(2);\n',
    "app/src/orders/total.ts":
      'import { money } from "../lib/format";\n\nexport const total = () => 3;\nexport const label = () => money(total());\n',
    "app/src/orders/total.test.ts":
      'import { vi } from "vitest";\nimport { total } from "./total";\n\nvi.mock("../lib/format");\ntotal();\n',
    "app/src/users/name.ts":
      'import { money } from "../lib/format";\nimport { load } from "./store";\n\nexport const name = () => [load(), money(0)].join(" ");\n',
    "app/src/users/store.ts": 'export const load = () => "ada";\n',
    "app/src/users/badge.ts":
      'import { money } from "../lib/format";\nimport { name } from "./name";\n\nexport const badge = () => [name(), money(1)].join(" ");\n',
  });
}

const PLAN = {
  scope: "app",
  moves: [
    { from: "app/src/lib/format.ts", to: "app/src/shared/format.ts" },
    { from: "app/src/orders/total.ts", to: "app/src/billing/total.ts" },
    {
      from: "app/src/orders/total.test.ts",
      to: "app/src/billing/total.test.ts",
    },
    { from: "app/src/users/name.ts", to: "app/src/accounts/name.ts" },
    { from: "app/src/users/store.ts", to: "app/src/accounts/store.ts" },
  ],
};

/** Writes `plan` outside the repository, so the file itself never dirties the tree apply checks. */
function planFile(plan: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "hand-plan-")), "plan.json");
  writeFileSync(path, JSON.stringify(plan));
  return path;
}

/** Runs `structure-sweep move <argv>` in `root` and returns the JSON report it prints. */
function move(root: string, ...argv: string[]): Record<string, unknown> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    moveCommand(argv, root);
    const printed = log.mock.calls.at(-1)?.[0];
    return JSON.parse(String(printed));
  } finally {
    log.mockRestore();
  }
}

const SPECIFIER = /from "(\.[^"]+)"|vi\.mock\("(\.[^"]+)"\)/g;

/** Every relative import and `vi.mock` specifier in the scope's sources, with whether it resolves. */
function specifiers(root: string) {
  const sources = git(root, "ls-files", "app/src").split("\n");
  return sources.flatMap((source) =>
    [...readFileSync(join(root, source), "utf8").matchAll(SPECIFIER)].map(
      (m) => {
        const spec = (m[1] ?? m[2]) as string;
        const target = join(dirname(join(root, source)), `${spec}.ts`);
        return { source, spec, resolves: existsSync(target) };
      },
    ),
  );
}

const renameRows = (plan: typeof PLAN) =>
  plan.moves.map((m) => `R100\t${m.from}\t${m.to}`).sort();

afterEach(() => vi.restoreAllMocks());

describe("move apply --plan", () => {
  it("renames every row in one commit, rewrites every import and vi.mock in the next, and is a no-op the second time", () => {
    const root = shop();
    const before = git(root, "rev-parse", "HEAD");
    const path = planFile(PLAN);

    const report = move(root, "apply", "--plan", path);

    expect(report).toMatchObject({ pending: 5, moved: 5 });
    expect(git(root, "rev-parse", "HEAD~2")).toBe(before);
    expect(
      git(root, "diff", "--name-status", "-M100%", "HEAD~2", "HEAD~1")
        .split("\n")
        .sort(),
    ).toEqual(renameRows(PLAN));
    expect(
      git(root, "diff", "--name-status", "-M", "HEAD~1", "HEAD")
        .split("\n")
        .every((line) => line.startsWith("M\t")),
    ).toBe(true);
    const specs = specifiers(root);
    expect(specs.length).toBeGreaterThanOrEqual(10);
    expect(specs.filter((s) => !s.resolves)).toEqual([]);
    const test = readFileSync(
      join(root, "app/src/billing/total.test.ts"),
      "utf8",
    );
    expect(test).toContain('vi.mock("../shared/format")');
    expect(test).toContain('from "./total"');
    expect(
      readFileSync(join(root, "app/src/users/badge.ts"), "utf8"),
    ).toContain('from "../accounts/name"');
    expect(git(root, "status", "--porcelain")).toBe("");

    const head = git(root, "rev-parse", "HEAD");
    const again = move(root, "apply", "--plan", path);

    expect(again).toMatchObject({
      pending: 0,
      done: 5,
      filesTouched: 0,
      lint: "untouched",
      commits: { rename: null, rewrite: null },
    });
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });

  it("resumes with the rewrite commit alone when a run stopped after the rename commit", () => {
    const root = shop();
    const path = planFile(PLAN);
    move(root, "apply", "--plan", path);
    const finished = git(root, "rev-parse", "HEAD^{tree}");
    const renameCommit = git(root, "rev-parse", "HEAD~1");
    gitIn(root, "reset", "-q", "--hard", renameCommit);

    const resumed = move(root, "apply", "--plan", path);

    expect(resumed).toMatchObject({
      commits: { rename: null, rewrite: git(root, "rev-parse", "HEAD") },
    });
    expect(git(root, "rev-parse", "HEAD~1")).toBe(renameCommit);
    expect(git(root, "rev-parse", "HEAD^{tree}")).toBe(finished);
  });

  it("says in both commits that the moves were hand-planned and names the plan's content hash", () => {
    const root = shop();
    move(root, "apply", "--plan", planFile(PLAN));
    const trailer = `Structure-Sweep-Plan: ${contentHash(canonicalJson(PLAN))}`;

    for (const rev of ["HEAD~1", "HEAD"]) {
      const message = git(root, "log", "-1", "--format=%B", rev);
      expect(message).toContain("hand-planned");
      expect(message).not.toContain("feature folders");
      expect(message).not.toContain("Structure-Sweep-Manifest");
      expect(message.split("\n")).toContain(trailer);
    }
  });

  describe("refuses before committing anything, naming the bad row", () => {
    const refusal = (plan: unknown): string => {
      const root = shop();
      const head = git(root, "rev-parse", "HEAD");
      let message = "no refusal";
      try {
        move(root, "apply", "--plan", planFile(plan));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(git(root, "rev-parse", "HEAD")).toBe(head);
      expect(git(root, "status", "--porcelain")).toBe("");
      return message;
    };
    const withRow = (row: Record<string, unknown>) => ({
      ...PLAN,
      moves: [...PLAN.moves.slice(0, 2), row, ...PLAN.moves.slice(3)],
    });
    const third = PLAN.moves[2] as (typeof PLAN.moves)[number];

    it.each([
      ["feature", { feature: "billing" }],
      ["role", { role: "api_surface" }],
      ["confidence", { confidence: 0.9 }],
    ])("a row carrying %s", (field, extra) => {
      const message = refusal(withRow({ ...third, ...extra }));
      expect(message).toContain(
        `moves[2] ${third.from} -> ${third.to}: Unrecognized key: "${field}"`,
      );
    });

    it.each([
      ["an absolute path", { ...third, from: "/etc/total.test.ts" }],
      ["a path holding ..", { ...third, to: "app/../total.test.ts" }],
    ])("a row with %s", (_, row) => {
      const message = refusal(withRow(row));
      expect(message).toContain(`moves[2] ${row.from} -> ${row.to}`);
      expect(message).toContain("repo-relative path");
    });

    it("two rows sharing a from", () => {
      const twin = { from: third.from, to: "app/src/elsewhere.test.ts" };
      const message = refusal({ ...PLAN, moves: [...PLAN.moves, twin] });
      expect(message).toContain(
        `moves[2] ${third.from} -> ${third.to} and moves[5] ${twin.from} -> ${twin.to} share a \`from\``,
      );
    });

    it("two rows sharing a to", () => {
      const twin = { from: "app/src/users/badge.ts", to: third.to };
      const message = refusal({ ...PLAN, moves: [...PLAN.moves, twin] });
      expect(message).toContain(
        `moves[2] ${third.from} -> ${third.to} and moves[5] ${twin.from} -> ${twin.to} share a \`to\``,
      );
    });

    it("a Jev manifest passed as a hand plan", () => {
      const message = refusal({ ...PLAN, features: ["billing"], floor: 0.8 });
      expect(message).toMatch(/Unrecognized keys: "features", "floor"/);
    });
  });

  it("fails naming both flags when --plan comes with an explicit --manifest", () => {
    const root = shop();
    const head = git(root, "rev-parse", "HEAD");
    expect(() =>
      move(root, "apply", "--plan", planFile(PLAN), "--manifest", "m.json"),
    ).toThrow(/--plan and --manifest/);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });
});

describe("move apply without --plan", () => {
  const verdict = (path: string, role: string): VerdictRow => ({
    path,
    answers: {
      feature: { choice: "audit_runs", confidence: 0.95 },
      role: { choice: role },
    },
  });

  it("reads the manifest and writes the same commit messages as before", () => {
    const root = shop();
    const manifest = planScope({
      root,
      scope: "app",
      vocabulary: fixtureVocabulary(),
      features: ["audit_runs"],
      floor: 0.8,
      verdicts: [
        verdict("app/src/orders/total.ts", "api_surface"),
        verdict("app/src/lib/format.ts", "api_surface"),
      ],
    });
    expect(manifest.moves.length).toBeGreaterThan(0);
    const path = planFile(manifest);
    const id = contentHash(canonicalJson(manifest));
    const count = manifest.moves.length;

    move(root, "apply", "--manifest", path);

    expect(git(root, "log", "-1", "--format=%B", "HEAD~1")).toBe(
      `structure-sweep move: rename ${count} files into feature folders

Content unchanged, so git records each move as a 100% rename and history follows it.
The import rewrites follow in the next commit.

Structure-Sweep-Step: rename
Structure-Sweep-Manifest: ${id}`,
    );
    expect(git(root, "log", "-1", "--format=%B", "HEAD")).toBe(
      `structure-sweep move: rewrite imports after the renames

Specifier rewrites, heals and formatting for the files the previous commit moved.

Structure-Sweep-Manifest: ${id}`,
    );
  });
});
