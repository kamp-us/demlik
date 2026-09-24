/**
 * Saved state `run` cannot read is refused, never booted fresh over (#316).
 *
 * `migrate` answers `S`, `null` (nothing saved) or `refuse(reason)`. A refusal,
 * and a `load` or `migrate` throw, reject `ready` with a `StoreRefusedError`
 * before `init` runs, so nothing is written and the stored bytes stay
 * identical. Both engines share the loop, so every case runs on both. It also
 * gates the restore-or-refuse how-to: the page shows the example verbatim, and
 * the example's host really lands on its "couldn't restore" view.
 *
 * It lives under `src/effect/` because it imports `effect`, which only this
 * entry may do.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type NotesState,
  notes,
  openNotes,
  parseNotes,
} from "../../examples/restore-or-refuse";
import {
  type BootingRuntime,
  type Migrated,
  refuse,
  type Store,
  StoreRefusedError,
} from "../index";
import { memoryStore } from "../mem";
import { fileStore } from "../node";
import { run as runPromise } from "../promise";
import { createQueue, type QueueItem } from "../work-queue";
import { run as runEffect } from "./index";

type Msg = { readonly type: "add"; readonly text: string };
type Ready = Awaited<BootingRuntime<NotesState, Msg, never>["ready"]>;

/** Boot a notes machine on one engine and settle `ready`. */
const engines: Record<
  "Promise" | "Effect",
  (store: Store<NotesState>, machine?: typeof notes) => Promise<Ready>
> = {
  Promise: (store, machine = notes) =>
    runPromise(machine, { ctx: {}, store }).ready,
  Effect: async (store, machine = notes) => {
    const scope = await Effect.runPromise(Scope.make());
    const booting = await Effect.runPromise(
      Scope.provide(scope)(runEffect(machine, { ctx: {}, store })),
    );
    // A run that never booted leaves nothing for `stop()` to close.
    return booting.ready.catch(async (err: unknown) => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw err;
    });
  },
};

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tea-refuse-"));
  path = join(dir, "notes.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Boot on `engine` and return what `ready` rejected with. */
async function refusalOn(
  engine: keyof typeof engines,
  store: Store<NotesState>,
  machine?: typeof notes,
): Promise<StoreRefusedError> {
  const failure = await engines[engine](store, machine).then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(StoreRefusedError);
  return failure as StoreRefusedError;
}

describe.each(["Promise", "Effect"] as const)("on the %s engine", (engine) => {
  it("corrupt bytes refuse, and the file is byte-identical afterwards", async () => {
    const corrupt = '{"phase":"open","notes":["half a note';
    await writeFile(path, corrupt, "utf8");

    const refusal = await refusalOn(engine, fileStore(path, parseNotes));

    expect(refusal.cause).toBeInstanceOf(SyntaxError);
    expect(await readFile(path, "utf8")).toBe(corrupt);
    expect(await readdir(dir)).toEqual(["notes.json"]);
  });

  it("a `refuse` from migrate refuses with its reason and writes nothing", async () => {
    const other = JSON.stringify({ version: 2, items: ["a note"] });
    await writeFile(path, other, "utf8");

    const refusal = await refusalOn(engine, fileStore(path, parseNotes));

    expect(refusal.reason).toBe("the saved notes are not a note list");
    expect(await readFile(path, "utf8")).toBe(other);
  });

  it("a fenced store refuses too, and takes no fence", async () => {
    const other = JSON.stringify({ version: 2 });
    await writeFile(path, other, "utf8");

    await refusalOn(engine, fileStore(path, parseNotes, { fenced: true }));

    expect(await readFile(path, "utf8")).toBe(other);
    expect(await readdir(dir)).toEqual(["notes.json"]);
  });

  it("a throwing migrate refuses, carrying the throw as its cause", async () => {
    const boom = new Error("migration not written yet");
    const saved: NotesState = { phase: "open", notes: ["kept"] };
    const inner = memoryStore<NotesState>(saved);
    let saves = 0;
    const store: Store<NotesState> = {
      load: () => inner.load(),
      save: async (state) => {
        saves += 1;
        await inner.save(state);
      },
      migrate: (): Migrated<NotesState> => {
        throw boom;
      },
    };

    const refusal = await refusalOn(engine, store);

    expect(refusal.cause).toBe(boom);
    expect(refusal.reason).toContain("migration not written yet");
    expect(saves).toBe(0);
    expect(await inner.load()).toBe(saved);
  });

  it("init never runs on a refusal", async () => {
    let inits = 0;
    const counted: typeof notes = {
      ...notes,
      init: (loaded, ctx) => {
        inits += 1;
        return notes.init(loaded, ctx);
      },
    };
    const store = memoryStore<NotesState>(null, () => refuse("no"));

    await refusalOn(engine, store, counted);

    expect(inits).toBe(0);
  });

  it("nothing saved still boots fresh", async () => {
    const rt = await engines[engine](fileStore(path, parseNotes));
    expect(rt.getState()).toEqual({ phase: "open", notes: [] });
    await rt.stop();
  });
});

describe("the work queue reads its store the same way", () => {
  it("a queue it cannot read refuses, and no op saves over it", async () => {
    const corrupt = "[{not json";
    await writeFile(path, corrupt, "utf8");
    const queue = createQueue(
      fileStore<QueueItem<string>[]>(path, (raw) =>
        raw === null ? null : refuse("not a queue"),
      ),
    );

    await expect(queue.enqueue("job")).rejects.toThrow(StoreRefusedError);
    expect(await readFile(path, "utf8")).toBe(corrupt);
  });
});

describe("the restore-or-refuse how-to — the host's view", () => {
  it("a refused store opens the couldn't-restore view and leaves the bytes", async () => {
    const other = JSON.stringify({ version: 2 });
    await writeFile(path, other, "utf8");

    const rt = await openNotes(fileStore(path, parseNotes));
    expect(rt.getState()).toEqual({
      phase: "unrestored",
      reason: "the saved notes are not a note list",
    });
    await rt.dispatch({ type: "add", text: "ignored" });
    await rt.stop();

    expect(await readFile(path, "utf8")).toBe(other);
  });

  it("a readable store opens the notes", async () => {
    await writeFile(
      path,
      JSON.stringify({ phase: "open", notes: ["kept"] }),
      "utf8",
    );
    const rt = await openNotes(fileStore(path, parseNotes));
    expect(rt.getState()).toEqual({ phase: "open", notes: ["kept"] });
    await rt.stop();
  });

  it("the page shows the example verbatim", async () => {
    const read = (at: string) =>
      readFile(fileURLToPath(new URL(at, import.meta.url)), "utf8");
    const page = await read("../../docs/how-to/restore-or-refuse.md");
    const blocks = [...page.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) =>
      (m[1] ?? "").trimEnd(),
    );
    const example = (
      await read("../../examples/restore-or-refuse.ts")
    ).trimEnd();
    expect(blocks).toContain(example);
  });
});
