/**
 * The reference-docs drift gate — one file, two mutually exclusive modes keyed
 * on the `TEA_DOCS_WRITE` env flag (mirrors the shipped b8e docs factory):
 *
 *   - TEA_DOCS_WRITE=1 → regenerate: write every page to disk (the `docs:reference`
 *     script). Nothing is asserted; this is the author-side regen.
 *   - unset → the mechanism proofs: the drift guard fires on a tampered page,
 *     `docs/reference/` holds nothing the generator does not write, every
 *     function row carries its signature, every page and catalog row prints the
 *     tier `MAINTAINING.md` stamps, and every public subpath has a page.
 *     Whether the committed pages match source is `docs:reference:check`'s
 *     alone (ADR 0008), which regenerates and prints the patch.
 *
 * Both modes generate, and generating refuses a public export with no TSDoc
 * summary, so an undescribed export fails either one.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertEveryRowDescribed,
  collectReferenceDrift,
  collectReferenceStrays,
  generateReferenceDocs,
  loadReferenceInputs,
  MODULE_ALLOWLIST,
  packageExportKeys,
  REFERENCE_DIR,
  type ReferenceInputs,
  referenceFileNames,
  renderReferenceDocs,
  writeReferenceDocs,
} from "./generate-reference";
import { tierOf } from "./tier-table";

const WRITE = process.env.TEA_DOCS_WRITE === "1";

// One typedoc run serves every test that only renders.
let loaded: Promise<ReferenceInputs> | undefined;
const inputs = (): Promise<ReferenceInputs> => {
  loaded ??= loadReferenceInputs();
  return loaded;
};

/** The `ts` block of one symbol's entry on a module page, or "" when it has none. */
const declarationOf = (page: string, symbol: string): string => {
  const entry = page.split(`<a id="${symbol}"></a>`)[1] ?? "";
  const untilNext = entry.split('<a id="')[0] ?? "";
  return untilNext.match(/```ts\n([\s\S]*?)\n```/)?.[1] ?? "";
};

/** The cells of every row of a page's exports table: symbol, kind, tier. */
const exportRows = (page: string) =>
  [...page.matchAll(/^\| \[`([^`]+)`\]\(#[^)]+\) \| (\w+) \| (\w+) \|/gm)].map(
    ([, symbol = "", kind = "", tier = ""]) => ({ symbol, kind, tier }),
  );

// typedoc compiles the whole package on each generate; give it real headroom.
describe("reference generator", { timeout: 120_000 }, () => {
  describe.runIf(WRITE)(
    "reference docs — regenerate (TEA_DOCS_WRITE=1)",
    () => {
      it("writes every generated page to docs/reference/", async () => {
        await writeReferenceDocs();
      });
    },
  );

  describe.skipIf(WRITE)("reference docs — drift gate", () => {
    it("the drift guard fires when a committed page is tampered", async () => {
      const docs = await generateReferenceDocs();
      const tampered = "index.md";
      expect(docs.has(tampered)).toBe(true);
      // readOnDisk returns each page's true generated content EXCEPT the one
      // page we corrupt — so the ONLY reported drift must be that page.
      const drift = await collectReferenceDrift(REFERENCE_DIR, async (path) => {
        const rel = path.slice(REFERENCE_DIR.length + 1);
        if (rel === tampered) return "<!-- tampered -->";
        return docs.get(rel) ?? null;
      });
      expect(drift).toEqual([tampered]);
    });

    it("a row with no summary is refused, named by module and symbol", () => {
      const refusal = (): void =>
        assertEveryRowDescribed([
          {
            module: "@demlik/tea",
            symbol: "replay",
            summary: "Run a machine.",
          },
          { module: "@demlik/tea/promise", symbol: "run", summary: "" },
          { module: "@demlik/tea/flow", symbol: "ActivityCmd", summary: "  " },
        ]);
      expect(refusal).toThrowError(/@demlik\/tea\/promise: run/);
      expect(refusal).toThrowError(/@demlik\/tea\/flow: ActivityCmd/);
      expect(refusal).not.toThrowError(/replay/);
    });

    it("every curated module subpath is a real package.json export", async () => {
      const keys = new Set(await packageExportKeys());
      for (const entry of MODULE_ALLOWLIST) {
        expect(
          keys.has(entry.subpath),
          `curated subpath ${entry.subpath} is not a package.json export key`,
        ).toBe(true);
      }
    });

    it("every public subpath has a page", async () => {
      const paged = new Set(MODULE_ALLOWLIST.map((e) => e.subpath));
      // `./package.json` is metadata and a stylesheet is an asset: neither has an API.
      const api = (await packageExportKeys()).filter(
        (k) => k !== "./package.json" && !k.endsWith(".css"),
      );
      expect(api.filter((k) => !paged.has(k))).toEqual([]);
    });

    it("curated page filenames are unique", () => {
      const files = MODULE_ALLOWLIST.map((e) => e.file);
      expect(new Set(files).size).toBe(files.length);
    });

    it("every function row carries its signature on the same page", async () => {
      const docs = renderReferenceDocs(await inputs());
      const unsigned: string[] = [];
      let functions = 0;
      for (const entry of MODULE_ALLOWLIST) {
        const page = docs.get(entry.file) ?? "";
        for (const row of exportRows(page)) {
          if (row.kind !== "Function") continue;
          functions += 1;
          if (
            !declarationOf(page, row.symbol).includes(`function ${row.symbol}`)
          )
            unsigned.push(`${entry.file}: ${row.symbol}`);
        }
      }
      expect(functions).toBeGreaterThan(0);
      expect(unsigned).toEqual([]);
      // The question the page exists to answer, on the page that answers it.
      const defineMachine = declarationOf(
        docs.get("tea.md") ?? "",
        "defineMachine",
      );
      expect(defineMachine).toMatch(/\n {2}m: .*Machine</);
      expect(defineMachine).toMatch(/\): Machine<S, M, C, U, Ctx>/);
    });

    it("every page and catalog row prints the tier MAINTAINING.md stamps", async () => {
      const { tiers } = await inputs();
      const docs = renderReferenceDocs(await inputs());
      const compass = docs.get("index.md") ?? "";
      const catalog = docs.get("all-modules.md") ?? "";
      for (const entry of MODULE_ALLOWLIST) {
        const tier = tierOf(tiers, entry.subpath);
        expect(docs.get(entry.file)).toContain(`\nTier: \`${tier}\`\n`);
        expect(compass).toContain(`(./${entry.file}) — ${tier}\n`);
        expect(catalog).toContain(`(./${entry.file}) | ${tier} |`);
      }
      // An export inherits its door's tier unless its own TSDoc opts out.
      const node = exportRows(docs.get("node.md") ?? "");
      expect(node.find((r) => r.symbol === "fileJournal")?.tier).toBe(
        "experimental",
      );
      expect(node.find((r) => r.symbol === "fileStore")?.tier).toBe("stable");
    });

    it("re-stamping a subpath in the tier table changes its page and its rows", async () => {
      const base = await inputs();
      const restamped = renderReferenceDocs({
        ...base,
        tiers: new Map([...base.tiers, ["./node", "battery"]]),
      });
      expect(restamped.get("node.md")).toContain("\nTier: `battery`\n");
      expect(restamped.get("index.md")).toContain("(./node.md) — battery\n");
      expect(restamped.get("all-modules.md")).toContain(
        "(./node.md) | battery |",
      );
      // The symbol-level opt-out is the symbol's own, so it survives the re-stamp.
      const rows = exportRows(restamped.get("node.md") ?? "");
      expect(rows.find((r) => r.symbol === "fileStore")?.tier).toBe("battery");
      expect(rows.find((r) => r.symbol === "fileJournal")?.tier).toBe(
        "experimental",
      );
    });

    // `docs:reference:check` runs this one by name, before it regenerates: the
    // writer removes a stray, so afterwards there is nothing left to catch.
    it("docs/reference/ holds nothing the generator does not write", async () => {
      expect(await collectReferenceStrays()).toEqual([]);
    });

    it("a file the generator did not write is named as a stray, and the writer removes it", async () => {
      const root = await mkdtemp(join(tmpdir(), "tea-reference-"));
      try {
        await writeFile(join(root, "removed-module.md"), "# gone\n", "utf8");
        expect(await collectReferenceStrays(root)).toEqual([
          "removed-module.md",
        ]);
        await writeReferenceDocs(root);
        expect((await readdir(root)).sort()).toEqual(
          referenceFileNames().sort(),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
