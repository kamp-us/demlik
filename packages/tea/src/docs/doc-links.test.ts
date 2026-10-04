/**
 * The link gate (#356, #537): every relative link in the package's published
 * markdown, and every GitHub URL into this repo's own tree, resolves to a file
 * on disk.
 *
 * The pure core is asserted to FIRE on synthetic text as well as to pass on the
 * committed tree, so the gate cannot degenerate into a trivial exit-0.
 */

import { describe, expect, it } from "vitest";
import {
  brokenLinksIn,
  collectBrokenLinks,
  filePathOf,
  formatBrokenLinks,
  inlineTargets,
  linkedPages,
  repoPathOf,
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
