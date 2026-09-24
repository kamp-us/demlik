/**
 * `examples/versioned-save.ts` walks old saves up, one step at a time (#315).
 *
 * It gates the migrate-a-saved-state how-to: the page shows the example
 * verbatim, and the example's `migrateSettings` really reads every old version,
 * refuses a version no step reads, and loads through a real `fileStore` on the
 * Promise engine without writing over a refused save.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateSettings, settings } from "../examples/versioned-save";
import { expectPageMirrors, fileMirror } from "./docs/page-mirrors";
import { Refusal, StoreRefusedError } from "./index";
import { fileStore } from "./node";
import { run } from "./promise";

const v3 = { version: 3, theme: "dark", fontSize: 12, compact: false };

describe("examples/versioned-save.ts — migrateSettings", () => {
  it("reads nothing saved as null, so the run boots fresh", () => {
    expect(migrateSettings(null)).toBeNull();
  });

  it("reads a current save as it is", () => {
    expect(migrateSettings(v3)).toEqual(v3);
  });

  it("walks a save with no version stamp up from version 1", () => {
    expect(migrateSettings({ dark: true, fontSize: 12 })).toEqual(v3);
  });

  it("walks a version 2 save through the one step it needs", () => {
    expect(
      migrateSettings({ version: 2, theme: "light", fontSize: 16 }),
    ).toEqual({ version: 3, theme: "light", fontSize: 16, compact: false });
  });

  it("refuses a version no step reads, naming it", () => {
    const answer = migrateSettings({ version: 0, fontSize: 12 });
    expect(answer).toBeInstanceOf(Refusal);
    expect((answer as Refusal).reason).toBe(
      "no migration step from settings version 0",
    );
  });

  it("refuses a version newer than this build", () => {
    expect(migrateSettings({ ...v3, version: 4 })).toBeInstanceOf(Refusal);
  });

  it("refuses a version that is not a whole number", () => {
    expect(migrateSettings({ ...v3, version: "3" })).toBeInstanceOf(Refusal);
    expect(migrateSettings({ ...v3, version: Number.NaN })).toBeInstanceOf(
      Refusal,
    );
  });

  it("refuses a save whose steps do not end on version 3 settings", () => {
    expect(migrateSettings({ version: 2, fontSize: 12 })).toBeInstanceOf(
      Refusal,
    );
  });
});

describe("examples/versioned-save.ts — through a fileStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tea-versioned-save-"));
    path = join(dir, "settings.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("an old save boots migrated, and the next save stamps version 3", async () => {
    await writeFile(path, JSON.stringify({ dark: true, fontSize: 12 }), "utf8");

    const rt = await run(settings, {
      store: fileStore(path, migrateSettings),
    }).ready;
    expect(rt.getState()).toEqual(v3);
    await rt.dispatch({ type: "toggleCompact" });
    await rt.stop();

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...v3,
      compact: true,
    });
  });

  it("a version with no step is refused, and the bytes stay", async () => {
    const old = JSON.stringify({ version: 0, fontSize: 12 });
    await writeFile(path, old, "utf8");

    await expect(
      run(settings, { store: fileStore(path, migrateSettings) }).ready,
    ).rejects.toThrow(StoreRefusedError);
    expect(await readFile(path, "utf8")).toBe(old);
  });
});

describe("the migrate-a-saved-state how-to", () => {
  it("the page shows the example verbatim", async () => {
    await expectPageMirrors(
      new URL("../docs/how-to/migrate-a-saved-state.md", import.meta.url),
      [fileMirror(new URL("../examples/versioned-save.ts", import.meta.url))],
    );
  });
});
