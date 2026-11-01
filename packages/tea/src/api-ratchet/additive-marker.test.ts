/**
 * The ruled path for a changed name that breaks no ordinary call (#777).
 *
 * Each case builds a throwaway git repository holding one package the way tea
 * is laid out, commits it as the base, then edits the working tree the way a
 * pull request does and runs the real check, `runApiRatchet`, under tea's own
 * policy. Three names change on a `stable` subpath: `draw` and `pick` gain an
 * optional option, and `parse` gains a required parameter, a real break.
 *
 * The check reads the changeset markers and never the kind of change, so a real
 * break is gated by the author having to state one of two things. Removing a
 * name has only the breaking marker.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runApiRatchet } from "./ratchet";

const AT_BASE = [
  "export function draw(options?: { maxLength?: number }): number {",
  "  return options?.maxLength ?? 0;",
  "}",
  "export function pick(options?: { limit?: number }): number {",
  "  return options?.limit ?? 0;",
  "}",
  "export function parse(text: string): number {",
  "  return text.length;",
  "}",
  "export const version = 1;",
  "",
].join("\n");

const THREE_CHANGED = [
  "export function draw(options?: { maxLength?: number; size?: string }): number {",
  "  return options?.maxLength ?? 0;",
  "}",
  "export function pick(options?: { limit?: number; seed?: number }): number {",
  "  return options?.limit ?? 0;",
  "}",
  "export function parse(text: string, radix: number): number {",
  "  return text.length + radix;",
  "}",
  "export const version = 1;",
  "",
].join("\n");

const ADDITIVE =
  "**Additive (declaration only):** `draw` takes `size` and `pick` takes `seed`.";
const BREAKING = "**Breaking:** `parse` now requires `radix`.";
const NEEDS =
  'needs a minor changeset with a "**Breaking" or "**Additive (declaration only)" callout';

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

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

type Fixture = {
  readonly top: string;
  readonly root: string;
  readonly base: string;
};

/** A repository whose base publishes `AT_BASE` on one `stable` subpath. */
function repository(): Fixture {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "tea-api-additive-")));
  scratch.push(top);
  const root = join(top, "packages", "demo");
  git(top, "init", "--quiet", "--initial-branch=main");
  write(join(top, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  write(join(top, ".changeset", "README.md"), "# Changesets\n");
  write(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        skipLibCheck: true,
        types: [],
      },
      include: ["src"],
    }),
  );
  write(
    join(root, "package.json"),
    JSON.stringify({
      name: "@fixture/demo",
      version: "0.1.0",
      type: "module",
      exports: {
        ".": { import: "./dist/index.js" },
        "./package.json": "./package.json",
      },
    }),
  );
  write(
    join(root, "MAINTAINING.md"),
    "# Maintaining\n\n| Subpath | Tier | Notes |\n|---|---|---|\n| `.` | stable | |\n",
  );
  write(
    join(root, "tsup.config.ts"),
    'export default { entry: { index: "src/index.ts" }, format: ["esm"] };\n',
  );
  write(join(root, "src", "index.ts"), AT_BASE);
  git(top, "add", "-A");
  git(top, "commit", "--quiet", "--no-gpg-sign", "-m", "base");
  return { top, root, base: git(top, "rev-parse", "HEAD").trim() };
}

function changeSource({ root }: Fixture, text: string): void {
  write(join(root, "src", "index.ts"), text);
}

function addChangeset(
  { top }: Fixture,
  name: string,
  bump: "patch" | "minor",
  body: string,
): void {
  write(
    join(top, ".changeset", `${name}.md`),
    `---\n"@fixture/demo": ${bump}\n---\n\n${body}\n`,
  );
}

/** The fixture with all three names changed and uncommitted. */
function threeNamesChanged(): Fixture {
  const fixture = repository();
  changeSource(fixture, THREE_CHANGED);
  return fixture;
}

const run = (fixture: Fixture) => runApiRatchet(fixture.base, fixture.root);

const passLine = (fixture: Fixture, changesets: number): string =>
  `api-ratchet: pass — 3 published names changed against ${fixture.base.slice(0, 7)}; @fixture/demo changesets since: ${changesets}, highest bump minor\n`;

describe(
  "three changed names on a stable subpath, one a real break",
  { timeout: 120_000 },
  () => {
    it("misses all three with no changeset, and names both markers it accepts", async () => {
      const fixture = threeNamesChanged();

      const first = await run(fixture);
      const second = await run(fixture);

      expect(first.passed).toBe(false);
      for (const name of ["draw", "pick", "parse"]) {
        expect(first.text).toContain(
          `api-ratchet: ${name} in . (stable) changed — ${NEEDS}; found no changeset`,
        );
      }
      expect(first.text).toContain("api-ratchet: 3 of 3 published names");
      expect(second).toEqual(first);
    });

    it("passes when the break says Breaking and the rest say additive", async () => {
      const fixture = threeNamesChanged();
      addChangeset(fixture, "two-options", "minor", ADDITIVE);
      addChangeset(fixture, "parse-radix", "minor", BREAKING);

      const result = await run(fixture);

      expect(result.text).toBe(passLine(fixture, 2));
      expect(result.passed).toBe(true);
    });

    it("misses all three on a minor changeset with neither marker", async () => {
      const fixture = threeNamesChanged();
      addChangeset(fixture, "all-three", "minor", "Three changes, plainly.");

      const result = await run(fixture);

      expect(result.passed).toBe(false);
      expect(result.text).toContain(
        `api-ratchet: parse in . (stable) changed — ${NEEDS}; found a minor changeset with no callout`,
      );
      expect(result.text).toContain("api-ratchet: 3 of 3 published names");
    });

    it("misses a patch changeset even with the marker, saying it found the marker", async () => {
      const fixture = threeNamesChanged();
      addChangeset(fixture, "two-options", "patch", ADDITIVE);

      const result = await run(fixture);

      expect(result.passed).toBe(false);
      expect(result.text).toContain(
        `api-ratchet: draw in . (stable) changed — ${NEEDS}; found a patch changeset with the callout`,
      );
    });

    it("refuses additive wording that does not limit itself to the declaration", async () => {
      const fixture = threeNamesChanged();
      addChangeset(
        fixture,
        "all-three",
        "minor",
        "**Additive:** three options.",
      );

      expect((await run(fixture)).passed).toBe(false);
    });

    it("takes the author's word: the additive marker alone passes a real break too", async () => {
      // The ruling picked a stated marker over reading the change, so this pass
      // is the known limit of that choice and not a bug to find later.
      const fixture = threeNamesChanged();
      addChangeset(fixture, "all-three", "minor", ADDITIVE);

      const result = await run(fixture);

      expect(result.text).toBe(passLine(fixture, 1));
      expect(result.passed).toBe(true);
    });

    it("still holds a removed name to the breaking marker, whatever else the additive marker covers", async () => {
      const fixture = threeNamesChanged();
      changeSource(
        fixture,
        THREE_CHANGED.replace("export const version = 1;\n", ""),
      );
      addChangeset(fixture, "all-four", "minor", ADDITIVE);

      const additiveOnly = await run(fixture);

      expect(additiveOnly.passed).toBe(false);
      expect(additiveOnly.text).toContain(
        'api-ratchet: version in . (stable) removed — needs a minor changeset with a "**Breaking" callout; found a minor changeset with no callout',
      );
      expect(additiveOnly.text).toContain(
        "api-ratchet: 1 of 4 published names",
      );

      addChangeset(
        fixture,
        "gone",
        "minor",
        "**Breaking:** `version` is removed.",
      );

      expect((await run(fixture)).passed).toBe(true);
    });
  },
);
