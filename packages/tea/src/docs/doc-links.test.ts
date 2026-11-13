/**
 * The link gate (#356, #537, #930): every relative link in the package's
 * published markdown, and every GitHub URL into this repo's own tree, resolves
 * to a file on disk, and a relative link in a page the tarball ships names a
 * file the tarball holds.
 *
 * The pure core is asserted to FIRE on synthetic text as well as to pass on the
 * committed tree, so the gate cannot degenerate into a trivial exit-0.
 */

import { describe, expect, it } from "vitest";
import {
  brokenLinksIn,
  collectBrokenLinks,
  collectUnshippedLinks,
  filePathOf,
  formatBrokenLinks,
  formatUnshippedLinks,
  inlineTargets,
  linkedPages,
  packs,
  repoPathOf,
  shippedPages,
  unshippedLinksIn,
} from "./doc-links";

describe("published markdown — link gate", () => {
  const repoRoot = "/repo";
  const present = new Set(["/pkg/docs/how-to/a.md", "/pkg/README.md"]);
  const exists = (path: string) => present.has(path);

  it("fires on a relative link that names a missing file, and passes one that resolves", () => {
    const page = [
      "See [a](./a.md) and [the readme](../../README.md#install).",
      "Then [gone](../../.decisions/0017-x.md) and ![img](./missing.png).",
      "[ref]: ./also-missing.md",
    ].join("\n");

    expect(
      brokenLinksIn("/pkg/docs/how-to/x.md", page, exists, repoRoot),
    ).toEqual([
      {
        file: "/pkg/docs/how-to/x.md",
        line: 2,
        target: "../../.decisions/0017-x.md",
      },
      { file: "/pkg/docs/how-to/x.md", line: 2, target: "./missing.png" },
      { file: "/pkg/docs/how-to/x.md", line: 3, target: "./also-missing.md" },
    ]);
  });

  it("reads a target with parentheses in it whole, not up to the first `)`", () => {
    expect(
      inlineTargets("[a](./a_(b).md) and [c](<./c (d).md> 'title')"),
    ).toEqual(["./a_(b).md", "./c (d).md"]);
    expect(inlineTargets(String.raw`[e](./e\).md "t") [f](./f.md)`)).toEqual([
      String.raw`./e\).md`,
      "./f.md",
    ]);
    expect(filePathOf(String.raw`./e\).md`)).toBe("./e).md");

    const present = new Set(["/pkg/docs/how-to/a_(b).md"]);
    const page = "[kept](./a_(b).md) and [gone](./gone_(v2).md#top)";
    expect(
      brokenLinksIn(
        "/pkg/docs/how-to/x.md",
        page,
        (p) => present.has(p),
        repoRoot,
      ),
    ).toEqual([
      { file: "/pkg/docs/how-to/x.md", line: 1, target: "./gone_(v2).md#top" },
    ]);
  });

  it("reads no link out of code, and checks no external link or anchor", () => {
    const page = [
      "```ts",
      "const [x](./in-fence.md) = y;",
      "```",
      "`[code](./in-span.md)` [site](https://demlik.run/x) [top](#usage)",
      "[mail](mailto:a@b.c) [root](/docs/x.md)",
    ].join("\n");

    expect(
      brokenLinksIn("/pkg/docs/how-to/x.md", page, exists, repoRoot),
    ).toEqual([]);
    expect(filePathOf("./a.md#b")).toBe("./a.md");
    expect(filePathOf("#b")).toBeUndefined();
  });

  it("fires on a URL into this repo's tree that names a missing file, and passes one that resolves", () => {
    const gone = "https://github.com/kamp-us/demlik/blob/main/docs/how-to/x.md";
    const kept =
      "https://github.com/kamp-us/demlik/blob/main/packages/tea/docs/how-to/x.md#run";
    const folder = "https://github.com/kamp-us/demlik/tree/main/.patterns";
    const inRepo = new Set([
      "/repo/packages/tea/docs/how-to/x.md",
      "/repo/.patterns",
    ]);
    const page = `[gone](${gone})\n[kept](${kept}) [folder](${folder})`;

    expect(
      brokenLinksIn(
        "/repo/packages/tea/README.md",
        page,
        (p) => inRepo.has(p),
        repoRoot,
      ),
    ).toEqual([
      { file: "/repo/packages/tea/README.md", line: 1, target: gone },
    ]);
  });

  it("checks no link to another host, another repo or another ref", () => {
    const page = [
      "[host](https://gitlab.com/kamp-us/demlik/blob/main/docs/gone.md)",
      "[repo](https://github.com/kamp-us/phoenix/blob/main/docs/gone.md)",
      "[ref](https://github.com/kamp-us/demlik/blob/v1/docs/gone.md)",
      "[issue](https://github.com/kamp-us/demlik/issues/537)",
    ].join("\n");

    expect(
      brokenLinksIn(
        "/repo/packages/tea/README.md",
        page,
        () => false,
        repoRoot,
      ),
    ).toEqual([]);
    expect(
      repoPathOf("https://github.com/kamp-us/demlik/blob/main/a/b.md#c"),
    ).toBe("a/b.md");
  });

  it("reads the package-root pages and every page under docs/", async () => {
    const pages = await linkedPages();

    for (const name of ["CHANGELOG.md", "README.md", "MAINTAINING.md"])
      expect(pages.some((p) => p.endsWith(`/tea/${name}`))).toBe(true);
    expect(pages.some((p) => p.includes("/docs/tutorial/"))).toBe(true);
    expect(pages.some((p) => p.includes("/docs/reference/"))).toBe(true);
  });

  it("every link in the committed pages resolves", async () => {
    expect(formatBrokenLinks(await collectBrokenLinks())).toBe("");
  });
});

describe("published markdown — the tarball holds what a shipped page links to", () => {
  const pkgRoot = "/repo/packages/tea";
  const files = ["dist", "docs"];
  const shipped = (path: string) => packs(files, path);
  const hitsIn = (page: string, text: string) =>
    unshippedLinksIn(`${pkgRoot}/${page}`, text, shipped, pkgRoot);

  it("fires on a relative link out of the tarball, and passes one inside it", () => {
    const page = [
      "[sibling](./index.md) [up](../../README.md#install) [license](../../LICENSE)",
      "[adr](../../../../.decisions/0001-x.md) [example](../../examples/order.ts)",
      "[changelog](../../CHANGELOG.md) [folder](../../src/)",
    ].join("\n");

    expect(hitsIn("docs/how-to/x.md", page)).toEqual([
      {
        file: `${pkgRoot}/docs/how-to/x.md`,
        line: 2,
        target: "../../../../.decisions/0001-x.md",
      },
      {
        file: `${pkgRoot}/docs/how-to/x.md`,
        line: 2,
        target: "../../examples/order.ts",
      },
      {
        file: `${pkgRoot}/docs/how-to/x.md`,
        line: 3,
        target: "../../CHANGELOG.md",
      },
      { file: `${pkgRoot}/docs/how-to/x.md`, line: 3, target: "../../src/" },
    ]);
  });

  it("takes a GitHub URL into the repo as the form that leaves the tarball", () => {
    const page =
      "[example](https://github.com/kamp-us/demlik/blob/main/packages/tea/examples/order.ts)";

    expect(hitsIn("docs/how-to/x.md", page)).toEqual([]);
  });

  it("holds what npm always packs at the root, and what `files` names, a folder or a file", () => {
    for (const name of [
      "package.json",
      "README.md",
      "readme",
      "LICENSE",
      "LICENCE.txt",
      "COPYING",
    ])
      expect(packs([], name)).toBe(true);
    for (const name of ["CHANGELOG.md", "MAINTAINING.md", "README.md~"])
      expect(packs(files, name)).toBe(false);

    expect(packs(files, "docs/how-to/x.md")).toBe(true);
    expect(packs(files, "docs")).toBe(true);
    expect(packs(files, "dist/index.js")).toBe(true);
    expect(packs(files, "docs-extra/x.md")).toBe(false);
    expect(packs(["./docs/"], "docs/how-to/x.md")).toBe(true);
    expect(packs(["CHANGELOG.md"], "CHANGELOG.md")).toBe(true);
    expect(packs(["CHANGELOG.md"], "CHANGELOG.md.bak")).toBe(false);
    expect(packs(["dist"], "docs/how-to/x.md")).toBe(false);
  });

  it("refuses to read a `files` pattern as a plain name", () => {
    expect(() => packs(["dist/**/*.js"], "docs/x.md")).toThrow(
      'files: "dist/**/*.js" is a pattern',
    );
    expect(() => packs(["!dist/x.js"], "dist/y.js")).toThrow("is a pattern");
  });

  it("gates README.md and every page under docs/, and none of the pages left for GitHub", async () => {
    const pages = await shippedPages();

    expect(pages.some((p) => p.endsWith("/tea/README.md"))).toBe(true);
    expect(pages.some((p) => p.includes("/docs/how-to/"))).toBe(true);
    expect(pages.some((p) => p.endsWith("/tea/CHANGELOG.md"))).toBe(false);
    expect(pages.some((p) => p.endsWith("/tea/MAINTAINING.md"))).toBe(false);
  });

  it("every relative link in the shipped pages names a file in the tarball", async () => {
    expect(formatUnshippedLinks(await collectUnshippedLinks())).toBe("");
  });
});
