/**
 * The ratchet holds a pull request that deletes whole export subpaths (#622).
 *
 * Each case builds a throwaway git repository holding one package the way tea
 * is laid out — `package.json` `exports`, a `MAINTAINING.md` tier table, a
 * `tsup.config.ts` and one source folder per subpath — commits it as the base,
 * then edits the working tree the way a pull request does and runs the real
 * check, `runApiRatchet`, against the base. Nothing here is mocked: the
 * compiler emits both trees.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Tier } from "../docs/reference/tier-table";
import { runApiRatchet } from "./ratchet";

type Subpaths = Readonly<Record<string, Tier>>;

/** Six subpaths, two per tier. */
const AT_BASE: Subpaths = {
  ".": "stable",
  "./testing": "stable",
  "./mem": "battery",
  "./flow": "battery",
  "./labs": "experimental",
  "./probe": "experimental",
};

const without = (subpaths: Subpaths, ...gone: readonly string[]): Subpaths =>
  Object.fromEntries(
    Object.entries(subpaths).filter(([subpath]) => !gone.includes(subpath)),
  );

/** `./mem` → `mem`; the root subpath is `core`. */
const stem = (subpath: string): string =>
  subpath === "." ? "core" : subpath.slice(2);
const sourceOf = (subpath: string): string =>
  subpath === "." ? "src/index.ts" : `src/${stem(subpath)}/index.ts`;
const builtKey = (subpath: string): string =>
  subpath === "." ? "index" : `${stem(subpath)}/index`;

/** Two published names per subpath: `<stem>Run` and `<stem>Version`. */
const sourceText = (subpath: string): string =>
  [
    `export const ${stem(subpath)}Version = 1;`,
    `export function ${stem(subpath)}Run(input: string): string {`,
    "  return input;",
    "}",
    "",
  ].join("\n");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.com",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * Write the package so it publishes exactly `subpaths`: the `exports` keys, the
 * tier-table rows, the build entries and the source folders, and nothing left
 * over from what it published before.
 */
function publish(
  root: string,
  subpaths: Subpaths,
  sources: (subpath: string) => string = sourceText,
): void {
  const listed = Object.keys(subpaths);
  const exported = Object.fromEntries([
    ...listed.map((subpath) => [
      subpath,
      { import: `./dist/${builtKey(subpath)}.js` },
    ]),
    ["./package.json", "./package.json"],
  ]);
  write(
    join(root, "package.json"),
    `${JSON.stringify({ name: "@fixture/demo", version: "0.1.0", type: "module", exports: exported }, null, 2)}\n`,
  );
  write(
    join(root, "MAINTAINING.md"),
    [
      "# Maintaining",
      "",
      "| Subpath | Tier | Notes |",
      "|---|---|---|",
      ...listed.map((subpath) => `| \`${subpath}\` | ${subpaths[subpath]} | |`),
      "",
    ].join("\n"),
  );
  write(
    join(root, "tsup.config.ts"),
    [
      "export default {",
      "  entry: {",
      ...listed.map(
        (subpath) =>
          `    ${JSON.stringify(builtKey(subpath))}: ${JSON.stringify(sourceOf(subpath))},`,
      ),
      "  },",
      '  format: ["esm"],',
      "};",
      "",
    ].join("\n"),
  );
  rmSync(join(root, "src"), { recursive: true, force: true });
  for (const subpath of listed) {
    write(join(root, sourceOf(subpath)), sources(subpath));
  }
}

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

type Fixture = {
  readonly top: string;
  readonly root: string;
  readonly base: string;
};

/** A repository whose base commit publishes `AT_BASE` from `packages/demo`. */
function repository(): Fixture {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "tea-api-ratchet-")));
  scratch.push(top);
  const root = join(top, "packages", "demo");
  git(top, "init", "--quiet", "--initial-branch=main");
  write(join(top, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  write(join(top, ".changeset", "README.md"), "# Changesets\n");
  write(
    join(root, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
  );
  publish(root, AT_BASE);
  git(top, "add", "-A");
  git(top, "commit", "--quiet", "--no-gpg-sign", "-m", "base");
  return { top, root, base: git(top, "rev-parse", "HEAD").trim() };
}

function addChangeset(
  { top }: Fixture,
  name: string,
  bump: "patch" | "minor" | "major",
  body: string,
): void {
  write(
    join(top, ".changeset", `${name}.md`),
    `---\n"@fixture/demo": ${bump}\n---\n\n${body}\n`,
  );
}

function filesUnder(dir: string, top = dir): readonly string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git")
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return filesUnder(full, top);
      const bytes = createHash("sha256")
        .update(readFileSync(full))
        .digest("hex");
      return [`${relative(top, full)} ${bytes}`];
    })
    .sort();
}

/** Everything a run must leave as it found it. */
const checkoutState = ({ top }: Fixture) => ({
  files: filesUnder(top),
  status: git(
    top,
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ),
  index: git(top, "ls-files", "--stage"),
  head: git(top, "rev-parse", "HEAD"),
  branch: git(top, "symbolic-ref", "HEAD"),
  stash: git(top, "stash", "list"),
});

const BREAK = 'a minor changeset with a "**Breaking" callout';
const CALLOUT = "**Breaking:** `./testing`, `./flow` and `./labs` are removed.";
const PLAIN = "Remove three subpaths.";

/** One subpath deleted from each tier. */
const THREE_GONE = without(AT_BASE, "./testing", "./flow", "./labs");

/** The fixture with `./testing`, `./flow` and `./labs` deleted and uncommitted. */
function threeSubpathsDeleted(): Fixture {
  const fixture = repository();
  publish(fixture.root, THREE_GONE);
  return fixture;
}

const run = (fixture: Fixture) => runApiRatchet(fixture.base, fixture.root);

describe(
  "a pull request that deletes whole export subpaths",
  {
    timeout: 120_000,
  },
  () => {
    it("fails with no changeset, naming each removed subpath, its base tier and what it owes", async () => {
      const fixture = threeSubpathsDeleted();
      const before = checkoutState(fixture);
      expect(before.status).not.toBe("");

      const first = await run(fixture);
      const second = await run(fixture);

      expect(first.passed).toBe(false);
      expect(first.text).toBe(
        [
          `api-ratchet: ./flow (battery) removed, with the 2 names it published — needs ${BREAK}; found no changeset`,
          "  removed: flowRun, flowVersion",
          "api-ratchet: ./labs (experimental) removed, with the 2 names it published — needs a patch changeset; found no changeset",
          "  removed: labsRun, labsVersion",
          `api-ratchet: ./testing (stable) removed, with the 2 names it published — needs ${BREAK}; found no changeset`,
          "  removed: testingRun, testingVersion",
          `api-ratchet: 6 of 6 published names changed against ${fixture.base.slice(0, 7)} without the changeset MAINTAINING.md's semver policy asks for — add one with \`pnpm changeset\``,
          "",
        ].join("\n"),
      );
      expect(second).toEqual(first);
      // Reading the base wrote nothing: files, status, index, HEAD, branch, stash.
      expect(checkoutState(fixture)).toEqual(before);
    });

    it("passes once a minor changeset carries the breaking callout", async () => {
      const fixture = threeSubpathsDeleted();
      addChangeset(fixture, "remove-three", "minor", CALLOUT);

      const result = await run(fixture);

      expect(result.text).toBe(
        `api-ratchet: pass — 6 published names changed against ${fixture.base.slice(0, 7)}; @fixture/demo changesets since: 1, highest bump minor\n`,
      );
      expect(result.passed).toBe(true);
    });

    it.each([
      ["a minor changeset with no callout", "minor", PLAIN],
      ["a patch changeset, callout or not", "patch", CALLOUT],
    ] as const)("still fails on %s, naming the stable and battery subpaths", async (_label, bump, body) => {
      const fixture = threeSubpathsDeleted();
      addChangeset(fixture, "remove-three", bump, body);

      const result = await run(fixture);

      expect(result.passed).toBe(false);
      expect(result.text).toContain(
        `api-ratchet: ./testing (stable) removed, with the 2 names it published — needs ${BREAK}; found a ${bump} changeset with ${bump === "minor" ? "no" : "the"} callout`,
      );
      expect(result.text).toContain(
        `api-ratchet: ./flow (battery) removed, with the 2 names it published — needs ${BREAK}`,
      );
      // The experimental subpath owes any changeset, and it has one.
      expect(result.text).not.toContain("./labs");
      expect(result.text).toContain("api-ratchet: 4 of 6 published names");
    });

    it("holds a removed experimental subpath to a changeset of any bump", async () => {
      const fixture = repository();
      publish(fixture.root, without(AT_BASE, "./labs"));

      const bare = await run(fixture);

      expect(bare.passed).toBe(false);
      expect(bare.text).toContain(
        "api-ratchet: ./labs (experimental) removed, with the 2 names it published — needs a patch changeset; found no changeset",
      );

      addChangeset(fixture, "remove-labs", "patch", PLAIN);

      expect((await run(fixture)).passed).toBe(true);
    });

    it("reads a removed subpath's tier from the base, whatever the working tree stamps", async () => {
      // The pull request also restamps every subpath it keeps as experimental.
      // `./testing`'s row is gone from that table; the base called it stable.
      const fixture = repository();
      publish(
        fixture.root,
        Object.fromEntries(
          Object.keys(without(AT_BASE, "./testing")).map((subpath) => [
            subpath,
            "experimental" as const,
          ]),
        ),
      );
      addChangeset(fixture, "remove-testing", "patch", PLAIN);

      const result = await run(fixture);

      expect(result.passed).toBe(false);
      expect(result.text).toContain(
        `api-ratchet: ./testing (stable) removed, with the 2 names it published — needs ${BREAK}; found a patch changeset with no callout`,
      );
    });

    it("holds a moved subpath: ./mem renamed to ./store names ./mem as removed", async () => {
      const fixture = repository();
      publish(
        fixture.root,
        { ...without(AT_BASE, "./mem"), "./store": "battery" },
        (subpath) => sourceText(subpath === "./store" ? "./mem" : subpath),
      );

      const result = await run(fixture);

      expect(result.passed).toBe(false);
      expect(result.text).toContain(
        `api-ratchet: ./mem (battery) removed, with the 2 names it published — needs ${BREAK}; found no changeset`,
      );
      expect(result.text).toContain(
        "api-ratchet: memRun in ./store (battery) added — needs a minor changeset; found no changeset",
      );
    });
  },
);

describe(
  "what the ratchet already held, on the same fixture",
  {
    timeout: 120_000,
  },
  () => {
    it("passes a pull request that changes no published name, with no changeset", async () => {
      const fixture = repository();
      write(join(fixture.root, "README.md"), "# demo\n");

      const result = await run(fixture);

      expect(result.text).toBe(
        `api-ratchet: pass — 0 published names changed against ${fixture.base.slice(0, 7)}; @fixture/demo changesets since: 0, highest bump none\n`,
      );
      expect(result.passed).toBe(true);
    });

    it("still catches one name removed from a subpath that stays", async () => {
      const fixture = repository();
      write(
        join(fixture.root, "src", "mem", "index.ts"),
        "export const memVersion = 1;\n",
      );

      const result = await run(fixture);

      expect(result.passed).toBe(false);
      expect(result.text).toBe(
        [
          `api-ratchet: memRun in ./mem (battery) removed — needs ${BREAK}; found no changeset`,
          "  before:",
          "    export declare function memRun(input: string): string;",
          `api-ratchet: 1 of 1 published name changed against ${fixture.base.slice(0, 7)} without the changeset MAINTAINING.md's semver policy asks for — add one with \`pnpm changeset\``,
          "",
        ].join("\n"),
      );
    });

    it("still reports every name of a newly added subpath as added", async () => {
      const fixture = repository();
      publish(fixture.root, { ...AT_BASE, "./store": "battery" });

      const result = await run(fixture);

      expect(result.passed).toBe(false);
      expect(result.text).toContain(
        "api-ratchet: storeRun in ./store (battery) added — needs a minor changeset; found no changeset",
      );
      expect(result.text).toContain(
        "api-ratchet: storeVersion in ./store (battery) added — needs a minor changeset; found no changeset",
      );
      expect(result.text).toContain("api-ratchet: 2 of 2 published names");
    });
  },
);
