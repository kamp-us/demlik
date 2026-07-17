/**
 * The reference-docs drift gate — one file, two mutually exclusive modes keyed
 * on the `TEA_DOCS_WRITE` env flag (mirrors the shipped b8e docs factory):
 *
 *   - TEA_DOCS_WRITE=1 → regenerate: write every page to disk (the `docs:reference`
 *     script). Nothing is asserted; this is the author-side regen.
 *   - unset → the CI gate: assert the committed pages match the freshly
 *     generated model (no drift), PLUS a guard-fires proof (a tampered page is
 *     detected), PLUS allowlist-integrity (every curated subpath is a real
 *     package.json export). The guard-fires proof is what keeps the gate from
 *     degenerating into a trivial exit-0.
 */

import { describe, expect, it } from "vitest";
import {
  collectReferenceDrift,
  generateReferenceDocs,
  MODULE_ALLOWLIST,
  packageExportKeys,
  REFERENCE_DIR,
  writeReferenceDocs,
} from "./generate-reference";

const WRITE = process.env.TEA_DOCS_WRITE === "1";
// typedoc compiles the whole package on each generate; give it real headroom.
const TIMEOUT = 120_000;

describe.runIf(WRITE)("reference docs — regenerate (TEA_DOCS_WRITE=1)", () => {
  it(
    "writes every generated page to docs/reference/",
    async () => {
      await writeReferenceDocs();
    },
    TIMEOUT,
  );
});

describe.skipIf(WRITE)("reference docs — drift gate", () => {
  it(
    "the drift guard fires when a committed page is tampered",
    async () => {
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
    },
    TIMEOUT,
  );

  it("every curated module subpath is a real package.json export", async () => {
    const keys = new Set(await packageExportKeys());
    for (const entry of MODULE_ALLOWLIST) {
      expect(
        keys.has(entry.subpath),
        `curated subpath ${entry.subpath} is not a package.json export key`,
      ).toBe(true);
    }
  });

  it("curated page filenames are unique", () => {
    const files = MODULE_ALLOWLIST.map((e) => e.file);
    expect(new Set(files).size).toBe(files.length);
  });
});
