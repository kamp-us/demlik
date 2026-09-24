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
//
// The published map is a CHECKED-IN FIXTURE, never a read of git history. A
// `git show <sha>:package.json` here exits 128 under CI's default
// `actions/checkout` (one commit, no `fetch-depth`), and it does so at COLLECT
// time — which kills the door-list pin above it too, so the gate reports
// `(0 test)` and pins nothing exactly where pinning matters (#51). The v0.12.0
// map is a fixed historical fact; a fixture makes this file depth-independent,
// ref-independent, and runnable in any consumer checkout.
// ═══════════════════════════════════════════════════════════════════════════
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Changesets are workspace-wide; they live beside `pnpm-workspace.yaml`, not in the package.
const WORKSPACE_ROOT = resolve(PKG_ROOT, "../..");

/**
 * The public doors, exactly. Twenty-four module doors plus the two non-module
 * entries — `./package.json` (metadata passthrough) and
 * `./devtools/styles.css` (the asset stays with its door).
 *
 * `./promise` and `./effect` are the two engines beside the neutral core at
 * `.` (#274 R2.1).
 *
 * `./devtools`, `./machine-viz` and `./parity` are here rather than folded
 * because each has a live external callsite (ADR 0016 as amended by #83): a
 * part someone imports keeps its own door.
 *
 * `./otel` is a door because it is the one module that imports
 * `@opentelemetry/api`, an optional peer (#331): folding it into `./agent`
 * would make every agent consumer install OpenTelemetry.
 *
 * The seven grouped `battery` doors are the sweep's other direction (#205),
 * and `./jev` is the eighth, opened on the same terms (#219).
 * The sweep closed sixty-odd doors because each was a permanent promise bought
 * for one caller's convenience; these eight are bought deliberately, at a tier
 * that may break in a minor, because the modules behind them are finished and
 * tested and a consumer who needs one has otherwise to copy the source. They
 * are grouped rather than per-module for the same reason the sweep happened:
 * eight promises, not forty-odd — `./jev` is one door over its three modules,
 * not three. Each is a re-export file over `src/internal/<door>/` — nothing
 * moved to open one.
 */
const PUBLIC_DOORS = [
  ".",
  "./promise",
  "./effect",
  "./do",
  "./node",
  "./mem",
  "./react",
  "./extension",
  "./testing",
  "./pbt",
  "./agent",
  "./retry-backoff",
  "./idempotency",
  "./flow",
  "./resilience",
  "./timing",
  "./persistence",
  "./paginate",
  "./work-queue",
  "./jev",
  "./devtools",
  "./machine-viz",
  "./parity",
  "./otel",
  "./devtools/styles.css",
  "./package.json",
] as const;

/**
 * The map v0.12.0 published — the last one before the sweep, transcribed from
 * `6d1fb6cc5e79a0ab13c48e859b41cdb2c19ec70f:package.json` and checked in beside
 * this test. Historical and therefore frozen: it changes only if that release's
 * `exports` is discovered to have been transcribed wrong.
 */
const PUBLISHED_V0_12_0 = JSON.parse(
  readFileSync(join(PKG_ROOT, "src/__fixtures__/v0.12.0-exports.json"), "utf8"),
) as { version: string; commit: string; exports: string[] };

function exportKeys(json: string): string[] {
  return Object.keys(
    (JSON.parse(json) as { exports: Record<string, unknown> }).exports,
  );
}

const currentDoors = exportKeys(
  readFileSync(join(PKG_ROOT, "package.json"), "utf8"),
);

describe("package.json `exports`", () => {
  it("carries exactly the public doors", () => {
    expect([...currentDoors].sort()).toEqual([...PUBLIC_DOORS].sort());
  });
});

describe("every door closed since v0.12.0 is named in a release note", () => {
  const removed = PUBLISHED_V0_12_0.exports.filter(
    (door) => !currentDoors.includes(door),
  );

  // One haystack: the shipped changelog plus the pending changesets, which are
  // the next changelog. Where the entry lives depends only on whether the
  // release that carries it has run yet.
  const notes =
    readFileSync(join(PKG_ROOT, "CHANGELOG.md"), "utf8") +
    readdirSync(join(WORKSPACE_ROOT, ".changeset"))
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .map((f) => readFileSync(join(WORKSPACE_ROOT, ".changeset", f), "utf8"))
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
