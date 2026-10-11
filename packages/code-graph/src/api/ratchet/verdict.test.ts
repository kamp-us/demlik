import { describe, expect, it } from "vitest";
import {
  type ApiDiff,
  ApiInputError,
  BumpPolicySchema,
  type Changeset,
  type ChangesetsSince,
  ratchetApiDiff,
} from "../../api.js";
import { parseChangeset } from "./changesets.js";

const text = (value: string) => ({ text: value, references: {} });

const subpath = (tier: string | null, names: Partial<ApiDiff["subpaths"][string]> = {}) => ({
  tier,
  added: {},
  removed: {},
  changed: {},
  ...names,
});

const diffOf = (subpaths: ApiDiff["subpaths"]): ApiDiff => ({
  root: "packages/demo",
  base: "4b1c0de0000000000000000000000000000000aa",
  compiler: "7.0.0",
  subpaths,
});

const since = (...changesets: Changeset[]): ChangesetsSince => ({
  package: "@demo/pkg",
  changesets,
});

const file = (bump: Changeset["bump"], body = "A change.", name = "a"): Changeset => ({
  file: `.changeset/${name}.md`,
  bump,
  body,
});

const row = (bump: string, callout = false) => ({
  added: { bump, callout },
  changed: { bump, callout },
  removed: { bump, callout },
});

const policy = { callout: "**Breaking", tiers: { stable: row("minor", true), labs: row("none") } };

const changedStable = diffOf({
  ".": subpath("stable", { changed: { make: { before: text("a"), after: text("b") } } }),
});

describe("ratchetApiDiff — the verdict (SPEC §13.5)", () => {
  it("passes a diff with no rows with no changeset, whatever the policy names", () => {
    const empty = diffOf({
      ".": subpath("stable"),
      "./other": subpath("unnamed"),
      "./x": subpath(null),
    });
    expect(ratchetApiDiff(empty, policy, since())).toEqual({
      passed: true,
      base: empty.base,
      package: "@demo/pkg",
      changesets: [],
      highestBump: "none",
      calloutFound: false,
      misses: [],
    });
  });

  it("misses a row whose bump is above the highest counted bump", () => {
    const verdict = ratchetApiDiff(changedStable, policy, since(file("patch", "**Breaking: x")));
    expect(verdict.passed).toBe(false);
    expect(verdict.misses).toEqual([
      {
        subpath: ".",
        tier: "stable",
        name: "make",
        kind: "changed",
        needs: { bump: "minor", callout: true },
        before: text("a"),
        after: text("b"),
      },
    ]);
  });

  it("misses a row that asks for the callout when no counted body carries the marker", () => {
    expect(ratchetApiDiff(changedStable, policy, since(file("major"))).passed).toBe(false);
    expect(ratchetApiDiff(changedStable, policy, since(file("minor", "**Breaking"))).passed).toBe(
      true,
    );
  });

  it("takes the higher of two bumps, and the callout from either file", () => {
    const verdict = ratchetApiDiff(
      changedStable,
      policy,
      since(file("patch", "**Breaking: x", "b"), file("minor", "A change.", "a")),
    );
    expect(verdict).toMatchObject({
      passed: true,
      highestBump: "minor",
      calloutFound: true,
      changesets: [".changeset/a.md", ".changeset/b.md"],
    });
  });

  it("gives an added row a null before and a removed row a null after, sorted by subpath then name", () => {
    const diff = diffOf({
      "./b": subpath("stable", { removed: { gone: { before: text("g") } } }),
      ".": subpath("stable", {
        added: { zed: { after: text("z") } },
        changed: { alpha: { before: text("1"), after: text("2") } },
      }),
    });
    const { misses } = ratchetApiDiff(diff, policy, since());
    expect(misses.map(({ subpath: at, name, kind }) => `${at} ${name} ${kind}`)).toEqual([
      ". alpha changed",
      ". zed added",
      "./b gone removed",
    ]);
    expect(misses[1]).toMatchObject({ before: null, after: text("z") });
    expect(misses[2]).toMatchObject({ before: text("g"), after: null });
  });

  it("refuses a reported tier the policy does not name, naming the subpath and tier", () => {
    const diff = diffOf({ "./beta": subpath("battery", { added: { x: { after: text("x") } } }) });
    expect(() => ratchetApiDiff(diff, policy, since(file("major", "**Breaking")))).toThrow(
      new ApiInputError(
        'bump policy: subpath ./beta has tier "battery", which the policy gives no row and no default',
      ),
    );
  });

  it("refuses a reported subpath with no tier when the policy has no default", () => {
    const diff = diffOf({ "./raw": subpath(null, { added: { x: { after: text("x") } } }) });
    expect(() => ratchetApiDiff(diff, policy, since())).toThrow(
      new ApiInputError(
        "bump policy: subpath ./raw has no tier, which the policy gives no row and no default",
      ),
    );
    const defaulted = { ...policy, default: row("patch") };
    expect(ratchetApiDiff(diff, defaulted, since()).misses[0]).toMatchObject({
      tier: null,
      needs: { bump: "patch", callout: false },
    });
    expect(ratchetApiDiff(diff, defaulted, since(file("patch"))).passed).toBe(true);
  });

  it("does not read a tier named like an Object.prototype member as a policy row", () => {
    const diff = diffOf({ ".": subpath("constructor", { added: { x: { after: text("x") } } }) });
    expect(() => ratchetApiDiff(diff, policy, since())).toThrow(ApiInputError);
  });

  it("refuses an invalid policy", () => {
    expect(() => ratchetApiDiff(changedStable, { tiers: {} }, since())).toThrow(ApiInputError);
  });
});

describe("BumpPolicySchema", () => {
  it("defaults a rule's callout to false and keeps the caller's default row", () => {
    const parsed = BumpPolicySchema.parse({
      callout: "!",
      tiers: {
        stable: {
          added: { bump: "minor" },
          changed: { bump: "major" },
          removed: { bump: "major", callout: true },
        },
      },
    });
    expect(parsed.tiers.stable?.added).toEqual({ bump: "minor", callout: false });
    expect(parsed.default).toBeUndefined();
  });

  it.each([
    ["an unknown key", { callout: "!", tiers: {}, extra: 1 }],
    ["an empty marker", { callout: "", tiers: {} }],
    ["a row missing a change kind", { callout: "!", tiers: { s: { added: { bump: "none" } } } }],
    ["an unknown bump", { callout: "!", tiers: { s: row("huge") } }],
    [
      "an unknown rule key",
      { callout: "!", tiers: { s: { ...row("none"), added: { bump: "none", note: 1 } } } },
    ],
  ])("refuses %s", (_what, value) => {
    expect(BumpPolicySchema.safeParse(value).success).toBe(false);
  });
});

describe("parseChangeset — the changesets frontmatter", () => {
  it("reads each package's bump and the body after the closing line", () => {
    const parsed = parseChangeset(
      "---\n\"@demo/pkg\": minor\n'@demo/other': patch\nbare: none\n---\n\nBody\n---\nmore\n",
    );
    expect([...(parsed?.bumps ?? [])]).toEqual([
      ["@demo/pkg", "minor"],
      ["@demo/other", "patch"],
      ["bare", "none"],
    ]);
    expect(parsed?.body).toBe("\nBody\n---\nmore\n");
  });

  it("reads an empty changeset and CRLF line ends", () => {
    expect(parseChangeset("---\n---\n")?.bumps.size).toBe(0);
    expect(parseChangeset('---\r\n"a": major\r\n---\r\nBody\r\n')?.bumps.get("a")).toBe("major");
  });

  it.each([
    ["no opening line", '"a": minor\n---\n'],
    ["no closing line", '---\n"a": minor\n'],
    ["a bump that is not one", '---\n"a": huge\n---\n'],
    ["a line that is not a bump", "---\nnot a bump line\n---\n"],
  ])("gives null for %s", (_what, value) => {
    expect(parseChangeset(value)).toBeNull();
  });
});
