import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mentionedPaths, repoFromRemoteUrl, resolveRepo } from "../src/repo.js";

function checkout(origin?: string): string {
  const root = mkdtempSync(join(tmpdir(), "backlog-sweep-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (origin !== undefined)
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: root });
  return root;
}

describe("resolveRepo", () => {
  it("takes --repo as given", () => {
    expect(resolveRepo("acme/widgets", checkout())).toBe("acme/widgets");
  });

  it("falls back to the checkout's origin remote, never to a built-in repository", () => {
    expect(
      resolveRepo(undefined, checkout("git@github.com:acme/widgets.git")),
    ).toBe("acme/widgets");
    expect(
      resolveRepo(undefined, checkout("https://github.com/acme/widgets")),
    ).toBe("acme/widgets");
  });

  it("refuses when there is neither a --repo nor a GitHub origin", () => {
    expect(() => resolveRepo(undefined, checkout())).toThrow(
      /pass --repo owner\/name/,
    );
    expect(() =>
      resolveRepo(undefined, checkout("https://gitlab.com/acme/widgets.git")),
    ).toThrow(/not a GitHub remote/);
    expect(() => resolveRepo("widgets", checkout())).toThrow(/owner\/name/);
  });
});

describe("repoFromRemoteUrl", () => {
  it("reads owner/name out of ssh and https remotes", () => {
    expect(repoFromRemoteUrl("ssh://git@github.com/acme/widgets.git\n")).toBe(
      "acme/widgets",
    );
    expect(
      repoFromRemoteUrl("https://example.com/acme/widgets"),
    ).toBeUndefined();
  });
});

describe("mentionedPaths", () => {
  it("keeps only paths that start at a folder at the root of this repository", () => {
    const text =
      "Broken in `lib/parser/index.ts:12` and docs/guide.md, see https://x.io/a/b and src/x.";
    expect(mentionedPaths(text, new Set(["lib", "docs"]))).toEqual([
      "lib/parser/index.ts",
      "docs/guide.md",
    ]);
  });
});
