// ═══════════════════════════════════════════════════════════════════════════
// THE EXPORT MAP IS THE CONTRACT, SO THE EXPORT MAP IS PINNED.
//
// `exports` in `package.json` is what a consumer can open (MAINTAINING.md), and
// nothing in the repo used to fail when it grew: a new subpath added for one
// caller's convenience became a permanent semver promise the moment it
// published, and the closing sweep (#51) had to walk sixty-odd doors back down
// to thirteen. Adding a door is a decision — it earns a tier row and a
// maintenance cost — so it is made deliberately, HERE, by editing this list in
// the same diff that adds the export.
//
// The changelog arm is the other half of ADR 0016's promise (a removal lands in
// one minor with a changeset callout naming where each part went): a door that
// closes is a break a consumer reads about in the changelog, naming where the
// parts went. So every subpath the published v0.12.0 map carried and this one
// does not has to be named somewhere a release note is assembled from —
// `CHANGELOG.md` for what already shipped, `.changeset/*.md` for what is about
// to. A silent removal is the failure this catches.
// ═══════════════════════════════════════════════════════════════════════════
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The public doors, exactly. Thirteen module doors plus the two non-module
 * entries — `./package.json` (metadata passthrough) and
 * `./devtools/styles.css` (the asset stays with its door).
 *
 * `./devtools`, `./machine-viz` and `./parity` are here rather than folded
 * because each has a live external callsite (ADR 0016 as amended by #83): a
 * part someone imports keeps its own door.
 */
const PUBLIC_DOORS = [
  ".",
  "./do",
  "./node",
  "./mem",
  "./react",
  "./extension",
  "./testing",
  "./pbt",
  "./agent",
  "./retry-backoff",
  "./devtools",
  "./machine-viz",
  "./parity",
  "./devtools/styles.css",
  "./package.json",
] as const;

/** The commit that released v0.12.0 — the last map published before the sweep. */
const V0_12_0 = "6d1fb6c";

function exportKeys(json: string): string[] {
  return Object.keys(
    (JSON.parse(json) as { exports: Record<string, unknown> }).exports,
  );
}

const currentDoors = exportKeys(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
);

describe("package.json `exports`", () => {
  it("carries exactly the public doors", () => {
    expect([...currentDoors].sort()).toEqual([...PUBLIC_DOORS].sort());
  });
});

describe("every door closed since v0.12.0 is named in a release note", () => {
  const published = exportKeys(
    execFileSync("git", ["show", `${V0_12_0}:package.json`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  const removed = published.filter((door) => !currentDoors.includes(door));

  // One haystack: the shipped changelog plus the pending changesets, which are
  // the next changelog. Where the entry lives depends only on whether the
  // release that carries it has run yet.
  const notes =
    readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8") +
    readdirSync(join(REPO_ROOT, ".changeset"))
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .map((f) => readFileSync(join(REPO_ROOT, ".changeset", f), "utf8"))
      .join("\n");

  it("removed at least the sub-doors this sweep closed", () => {
    expect(removed).toEqual(expect.arrayContaining(["./pure", "./subs"]));
  });

  it.each(removed)("%s", (door) => {
    // The specifier as a consumer wrote it — that is the string a reader
    // searches the changelog for when their import stops resolving.
    expect(notes).toContain(`@demlik/tea/${door.slice(2)}`);
  });
});
