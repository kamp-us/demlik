/**
 * `docs/explanation/export-tiers.md` names the tier `MAINTAINING.md` stamps
 * (#542).
 *
 * `MAINTAINING.md`'s tier table is the canonical stamp per subpath, and
 * `scripts/check-export-stamps.mjs` holds it to the export map. The
 * explanation page names tiers a second time, for consumers: a row per
 * battery door, and the experimental subpaths in one paragraph. Nothing held
 * the two together, and the page fell behind when `./jev` and `./otel` were
 * stamped. Here every battery and experimental stamp must be named on the
 * page under that tier, and the page must name no other subpath there.
 * `stable` is every subpath left over, which the page leaves to the table.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PKG_ROOT } from "./in-memory-program";

const read = (path: string) => readFile(join(PKG_ROOT, path), "utf8");

/** The subpaths `MAINTAINING.md`'s tier table stamps `tier`, sorted. */
function stamped(maintaining: string, tier: string): string[] {
  return [...maintaining.matchAll(/^\| `(\.\/[^`]+)` \| ([a-z]+) \|/gm)]
    .filter((row) => row[2] === tier)
    .map((row) => row[1] ?? "")
    .sort();
}

/** The paragraph of the page that opens `**\`<tier>\``. */
function paragraphOf(page: string, tier: string): string {
  const paragraph = page
    .split("\n\n")
    .find((text) => text.startsWith(`**\`${tier}\``));
  if (paragraph === undefined)
    throw new Error(`export-tiers.md has no \`${tier}\` paragraph`);
  return paragraph;
}

describe("docs/explanation/export-tiers.md agrees with MAINTAINING.md", async () => {
  const maintaining = await read("MAINTAINING.md");
  const page = await read("docs/explanation/export-tiers.md");

  it("gives every battery subpath a door row, and no other subpath one", () => {
    const doors = [...page.matchAll(/^\| `@demlik\/tea\/([^`]+)` \|/gm)]
      .map((row) => `./${row[1]}`)
      .sort();

    expect(doors).toEqual(stamped(maintaining, "battery"));
  });

  it("names every experimental subpath in the experimental paragraph, and no other", () => {
    const named = [
      ...paragraphOf(page, "experimental").matchAll(/`(\.\/[^`]+)`/g),
    ]
      .map((mention) => mention[1] ?? "")
      .sort();

    expect(named).toEqual(stamped(maintaining, "experimental"));
  });
});
