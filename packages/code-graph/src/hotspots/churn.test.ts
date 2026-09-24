import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { churnFor, loadChurn, resolveChurnWindow } from "./churn.js";

function git(cwd: string, args: string[], commitIso?: string): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      ...(commitIso ? { GIT_AUTHOR_DATE: commitIso, GIT_COMMITTER_DATE: commitIso } : {}),
    },
  });
}

const INITIAL_DATE = "2020-01-01T00:00:00Z";
const HOT_TOUCH_2_DATE = "2020-01-02T00:00:00Z";
const HOT_TOUCH_3_DATE = "2020-01-03T00:00:00Z";
const NARROW_WINDOW_SINCE = "2020-01-01T12:00:00Z";
const WIDE_WINDOW_SINCE = "2019-12-31T00:00:00Z";

describe("churn.ts", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-churn-"));
    git(tmpRoot, ["init", "-q"]);
    git(tmpRoot, ["config", "commit.gpgsign", "false"]);

    fs.mkdirSync(path.join(tmpRoot, "src"));
    fs.writeFileSync(path.join(tmpRoot, "src", "hot.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(tmpRoot, "src", "cold.ts"), "export const b = 1;\n");
    git(tmpRoot, ["add", "."]);
    git(tmpRoot, ["commit", "-q", "-m", "initial"], INITIAL_DATE);

    fs.writeFileSync(path.join(tmpRoot, "src", "hot.ts"), "export const a = 2;\n");
    git(tmpRoot, ["commit", "-q", "-am", "touch hot 2"], HOT_TOUCH_2_DATE);
    fs.writeFileSync(path.join(tmpRoot, "src", "hot.ts"), "export const a = 3;\n");
    git(tmpRoot, ["commit", "-q", "-am", "touch hot 3"], HOT_TOUCH_3_DATE);

    fs.writeFileSync(path.join(tmpRoot, "src", "untracked.ts"), "export const c = 1;\n");
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("resolveChurnWindow: days-based window ends now and spans ~days", () => {
    const window = resolveChurnWindow(90, undefined);
    const spanMs = new Date(window.untilIso).getTime() - new Date(window.sinceIso).getTime();
    expect(window.days).toBe(90);
    expect(Math.round(spanMs / 86_400_000)).toBe(90);
  });

  it("resolveChurnWindow: an explicit --since pins the start and recomputes days honestly", () => {
    const since = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const window = resolveChurnWindow(90, since);
    expect(window.sinceIso).toBe(since);
    expect(window.days).toBe(10);
  });

  it("loadChurn counts commits per file within the window, hot > cold", () => {
    const window = resolveChurnWindow(0, WIDE_WINDOW_SINCE);
    const churn = loadChurn(tmpRoot, window);
    expect(churn).not.toBeNull();
    if (churn === null) return;
    expect(churnFor(churn, "src/hot.ts")).toBe(3);
    expect(churnFor(churn, "src/cold.ts")).toBe(1);
  });

  it("a tracked file untouched in a narrow window reports a real 0, not null", () => {
    const window = resolveChurnWindow(0, NARROW_WINDOW_SINCE);
    const churn = loadChurn(tmpRoot, window);
    expect(churn).not.toBeNull();
    if (churn === null) return;
    expect(churnFor(churn, "src/cold.ts")).toBe(0);
    expect(churnFor(churn, "src/hot.ts")).toBe(2);
  });

  it("an untracked file (new, no git history) is null, not a crash and not a silent 0", () => {
    const window = resolveChurnWindow(0, WIDE_WINDOW_SINCE);
    const churn = loadChurn(tmpRoot, window);
    expect(churn).not.toBeNull();
    if (churn === null) return;
    expect(churnFor(churn, "src/untracked.ts")).toBeNull();
  });

  it("loadChurn returns null for a path outside any git repository", () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-nonrepo-"));
    try {
      const window = resolveChurnWindow(90, undefined);
      expect(loadChurn(nonRepo, window)).toBeNull();
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("loadChurn scopes by pathspec: a subdirectory root only sees its own files", () => {
    const window = resolveChurnWindow(0, WIDE_WINDOW_SINCE);
    const churn = loadChurn(path.join(tmpRoot, "src"), window);
    expect(churn).not.toBeNull();
    if (churn === null) return;
    expect(churnFor(churn, "hot.ts")).toBe(3);
    expect(churnFor(churn, "cold.ts")).toBe(1);
  });
});
