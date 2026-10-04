/**
 * The durability how-to's compile-and-run gate (#542).
 *
 * `docs/how-to/make-durable.md` walks a reader from a hand-written `Store` to
 * a fenced file two processes share. Its blocks are `examples/downloader.ts`
 * and this file's `#region` bodies, verbatim (`../page-mirrors.ts` holds the
 * row), so the page shows code the test program compiles. It runs here too:
 * the regions sit at module level and execute once, in page order, and the
 * tests below read what they left behind.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin import blocks the page reproduces verbatim; sorting the harness's imports
// into them would move a marker and break the row this file backs.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { downloader, type State } from "../../../examples/downloader";

/** The file step 4 fences: this run's own, never the page's default. */
const dir = await mkdtemp(join(tmpdir(), "tea-make-durable-"));
process.env.DOWNLOAD_FILE = join(dir, "download.json");

// #region store
import { type Migrated, refuse, type Store } from "@demlik/tea";

/** Recognize a saved State, boot fresh on nothing, refuse anything else. */
function parse(raw: unknown): Migrated<State> {
  if (raw === null) return null;
  return typeof raw === "object" && "phase" in raw
    ? (raw as State)
    : refuse("not a saved State");
}

function memStore(box: { snapshot: string | null }): Store<State> {
  return {
    load: () => Promise.resolve(box.snapshot),
    save: (state) => {
      box.snapshot = JSON.stringify(state);
      return Promise.resolve();
    },
    migrate: (raw) => parse(typeof raw === "string" ? JSON.parse(raw) : raw),
  };
}
// #endregion store

// #region boot
import { run } from "@demlik/tea/promise";

const box = { snapshot: null as string | null };

const a = await run(downloader, { store: memStore(box) }).ready;
await a.dispatch({ type: "start", total: 3 });
await a.dispatch({ type: "chunk", size: 1 }); // phase is now "downloading"
await a.stop(); // box.snapshot now holds the persisted Model
// #endregion boot

// #region resume
const b = await run(downloader, { store: memStore(box) }).ready;

const resumed = b.getState(); // phase "downloading", received 1: where A stopped
// #endregion resume

// #region fence
import { fileStore } from "@demlik/tea/node";

const file = process.env.DOWNLOAD_FILE ?? "download.json";
const first = await run(downloader, {
  store: fileStore(file, parse, { fenced: true }),
}).ready;
// #endregion fence

// #region second-writer
// Process B starts while A is still running. B reads the CURRENT version at
// boot, so B's own boot save swaps cleanly and B runs.
const second = await run(downloader, {
  store: fileStore(file, parse, { fenced: true }),
}).ready; // resolves — B now holds the fence
// #endregion second-writer

// #region guard
import { StoreConflictError } from "@demlik/tea";

let takenOver = false;
try {
  await first.dispatch({ type: "start", total: 3 }); // A's next save
} catch (err) {
  if (!(err instanceof StoreConflictError)) throw err;
  takenOver = true; // another process owns this run now: stop dispatching
}
// #endregion guard

afterAll(async () => {
  // `first` is not stopped here: the refused save already stopped it.
  await b.stop();
  await second.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("docs/how-to/make-durable.md — it runs", () => {
  it("step 2 saves through the Store on every dispatch", () => {
    expect(box.snapshot).not.toBeNull();
    expect(a.getState()).toEqual({
      phase: "downloading",
      received: 1,
      total: 3,
    });
  });

  it("step 3 resumes a fresh runtime where the first one stopped", () => {
    expect(resumed).toEqual(a.getState());
  });

  it("the Store refuses saved bytes it cannot read", () => {
    expect(parse(null)).toBeNull();
    expect(parse({ rows: [] })).toEqual(refuse("not a saved State"));
  });

  it("step 4: the newer starter takes the fence, and the older writer's next save is refused", async () => {
    const saved = async () => JSON.parse(await readFile(file, "utf8"));

    expect(takenOver).toBe(true);
    // A's refused save wrote nothing: the file is still B's boot save.
    expect(await saved()).toMatchObject({ phase: "idle" });

    await second.dispatch({ type: "start", total: 3 });
    expect(await saved()).toMatchObject({ phase: "downloading" });
  });
});
