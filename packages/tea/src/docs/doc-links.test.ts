/**
 * The relative-link gate (#356): every relative link in the package's
 * published markdown resolves to a file on disk.
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
  linkedPages,
} from "./doc-links";

describe("published markdown — relative link gate", () => {
  const present = new Set(["/pkg/docs/how-to/a.md", "/pkg/README.md"]);
  const exists = (path: string) => present.has(path);

  it("fires on a relative link that names a missing file, and passes one that resolves", () => {
    const page = [
      "See [a](./a.md) and [the readme](../../README.md#install).",
      "Then [gone](../../.decisions/0017-x.md) and ![img](./missing.png).",
      "[ref]: ./also-missing.md",
    ].join("\n");

    expect(brokenLinksIn("/pkg/docs/how-to/x.md", page, exists)).toEqual([
      {
        file: "/pkg/docs/how-to/x.md",
        line: 2,
        target: "../../.decisions/0017-x.md",
      },
      { file: "/pkg/docs/how-to/x.md", line: 2, target: "./missing.png" },
      { file: "/pkg/docs/how-to/x.md", line: 3, target: "./also-missing.md" },
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

    expect(brokenLinksIn("/pkg/docs/how-to/x.md", page, exists)).toEqual([]);
    expect(filePathOf("./a.md#b")).toBe("./a.md");
    expect(filePathOf("#b")).toBeUndefined();
  });

  it("reads the package-root pages and every page under docs/", async () => {
    const pages = await linkedPages();

    for (const name of ["CHANGELOG.md", "README.md", "MAINTAINING.md"])
      expect(pages.some((p) => p.endsWith(`/tea/${name}`))).toBe(true);
    expect(pages.some((p) => p.includes("/docs/tutorial/"))).toBe(true);
    expect(pages.some((p) => p.includes("/docs/reference/"))).toBe(true);
  });

  it("every relative link in the committed pages resolves", async () => {
    expect(formatBrokenLinks(await collectBrokenLinks())).toBe("");
  });
});
