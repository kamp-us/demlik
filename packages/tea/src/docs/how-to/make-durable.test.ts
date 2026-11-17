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

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { downloader, type State } from "../../../examples/downloader";
import { fileJournal } from "../../node";

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
await a.dispatch({ _tag: "start", total: 3 });
await a.dispatch({ _tag: "chunk", size: 1 }); // phase is now "downloading"
await a.stop(); // box.snapshot now holds the persisted Model
// #endregion boot

// #region resume
const b = await run(downloader, { store: memStore(box) }).ready;

const resumed = b.getState(); // phase "downloading", received 1: where A stopped
// #endregion resume

// #region fence
import type { OnError } from "@demlik/tea";
import { fileStore } from "@demlik/tea/node";

// A fenced run must be given a sink, or it does not compile.
const onError: OnError = (error, { phase }) => {
  console.error(`download run, ${phase}:`, error);
};

const file = process.env.DOWNLOAD_FILE ?? "download.json";
const first = await run(downloader, {
  store: fileStore(file, parse, { fenced: true }),
  onError,
}).ready;
// #endregion fence

// #region second-writer
// Process B starts while A is still running. B reads the CURRENT version at
// boot, so B's own boot save swaps cleanly and B runs.
const second = await run(downloader, {
  store: fileStore(file, parse, { fenced: true }),
  onError,
}).ready; // resolves — B now holds the fence
// #endregion second-writer

// #region guard
import { StoreConflictError } from "@demlik/tea";

let takenOver = false;
try {
  await first.dispatch({ _tag: "start", total: 3 }); // A's next save
} catch (err) {
  if (!(err instanceof StoreConflictError)) throw err;
  takenOver = true; // another process owns this run now: stop dispatching
}
// #endregion guard

// #region per-call
// A host that ends its activation after each call retains the journal's storage.
import { z } from "zod";
import { defineMachine } from "../../index";
import { eventSourcedStore, type Journal } from "../../persistence";
import {
  type DeadlinesSub,
  deadlineExceeded,
  deadlinesSub,
  deadlineSub,
  subscribeWith,
} from "../../resilience";

const alarmState = z.object({
  due: z.number().nullable(),
  fired: z.array(z.number()),
});
const alarmMessage = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("schedule"), atMs: z.number() }),
  z.object({
    _tag: z.literal("deadline_exceeded"),
    id: z.string(),
    atMs: z.number(),
  }),
]);
type AlarmState = z.infer<typeof alarmState>;
type AlarmMessage = z.infer<typeof alarmMessage>;

// The feature owns this selector; its Sub and the host both read it.
const deadlinesFor = (s: AlarmState) =>
  s.due === null ? [] : [deadlineSub("reminder", s.due)];
const reminder = defineMachine({
  types: {
    model: {} as AlarmState,
    msg: {} as AlarmMessage,
    sub: {} as DeadlinesSub,
  },
  init: (loaded) => [loaded ?? { due: null, fired: [] }, []],
  update: {
    schedule: (s, m) => [{ ...s, due: m.atMs }, []],
    deadline_exceeded: (s, m) => [
      { due: null, fired: [...s.fired, m.atMs] },
      [],
    ],
  },
  subs: [deadlinesSub(deadlinesFor)],
});

async function call(
  journal: Journal,
  inputs: readonly { msg: AlarmMessage; id: string }[],
  now: number,
): Promise<number | null> {
  try {
    const rt = await run(reminder, {
      store: eventSourcedStore(journal, {
        state: alarmState,
        message: alarmMessage,
        command: z.never(),
      }),
      // No in-isolate timer: after stop, the host sets its external alarm.
      subscribe: { deadline: subscribeWith(() => () => {}) },
    }).ready;
    try {
      for (const d of deadlinesFor(rt.getState()).filter(
        (d) => d.atMs <= now,
      )) {
        await rt.dispatch(deadlineExceeded(d.id, d.atMs), {
          id: `alarm:${d.id}:${d.atMs}`,
        });
      }
      for (const { msg, id } of inputs) await rt.dispatch(msg, { id });
    } finally {
      await rt.stop();
    }
    return deadlinesFor(rt.getState()).reduce<number | null>(
      (next, d) => (next === null ? d.atMs : Math.min(next, d.atMs)),
      null,
    );
  } finally {
    await journal.close();
  }
}
// #endregion per-call

// #region external-work
import {
  Cmd,
  type DeliveryId,
  deliveryIdOf,
  logLedger,
  owed,
} from "../../index";

const externalJobInput = z.object({ key: z.string() });
const externalJob = Cmd.define("external_job", {
  input: externalJobInput,
  ok: z.string(),
  err: [],
});
type ExternalJob = ReturnType<typeof externalJob>;

function handOff(
  enqueue: (work: { id: DeliveryId; cmd: ExternalJob }) => Promise<void>,
) {
  return async (cmd: ExternalJob, ctx: unknown) => {
    const id = deliveryIdOf(ctx);
    if (id === undefined)
      throw new Error("external work needs a logged invocation");
    await enqueue({ id, cmd }); // Await only the external queue's durable acknowledgement.
    return owed();
  };
}
// After dispatch and stop: logLedger(await store.readLog()).surviving()
// #endregion external-work

afterAll(async () => {
  // `first` is not stopped here: the refused save already stopped it.
  await b.stop();
  await second.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("docs/how-to/make-durable.md — it runs", () => {
  it("hands a Cmd back, re-hands its stable id, then accepts its answer on a later call", async () => {
    const externalState = z.object({ settled: z.array(z.string()) });
    const externalCommand = z.object({
      _tag: z.literal(externalJob.cmdType),
      ...externalJobInput.shape,
    });
    const externalMessage = z.discriminatedUnion("_tag", [
      z.object({ _tag: z.literal("submit"), ...externalJobInput.shape }),
      z.object({
        _tag: z.literal(externalJob.okType),
        cmd: externalCommand,
        value: z.string(),
        at: z.number(),
      }),
      z.object({
        _tag: z.literal(externalJob.errType),
        cmd: externalCommand,
        error: z.object({ _tag: z.literal("malformed_result") }),
        at: z.number(),
      }),
    ]);
    const work = defineMachine({
      types: {
        model: {} as z.infer<typeof externalState>,
        msg: {} as { _tag: "submit"; key: string },
      },
      cmds: [externalJob],
      init: (loaded) => [loaded ?? { settled: [] }, []],
      update: {
        submit: (s, m) => [s, [externalJob({ key: m.key })]],
        external_job_ok: (s, m) => [{ settled: [...s.settled, m.value] }, []],
        external_job_err: (s, m) => [
          { settled: [...s.settled, m.error._tag] },
          [],
        ],
      },
    });
    const handed: { id: DeliveryId; cmd: ExternalJob }[] = [];
    const accepted = new Map<DeliveryId, ExternalJob>();
    const handler = handOff(async ({ id, cmd }) => {
      handed.push({ id, cmd });
      if (!accepted.has(id)) accepted.set(id, cmd);
    });
    const path = join(dir, "external-jobs");
    for (let call = 0; call < 2; call += 1) {
      const journal = fileJournal(path);
      const store = eventSourcedStore(journal, {
        state: externalState,
        message: externalMessage,
        command: externalCommand,
      });
      const rt = await run(work, {
        store,
        interpret: { external_job: handler },
      }).ready;
      try {
        if (call === 0) await rt.dispatch({ _tag: "submit", key: "report-7" });
        await rt.stop();
        expect(rt.getState().settled).toEqual([]);
        expect(logLedger(await store.readLog()).surviving()).toEqual([
          { id: handed[0]?.id, effect: externalJob({ key: "report-7" }) },
        ]);
      } finally {
        await rt.stop();
        await journal.close();
      }
    }
    expect(handed).toHaveLength(2);
    expect(handed[1]).toEqual(handed[0]);
    expect(accepted.size).toBe(1);

    const firstDelivery = handed[0];
    if (!firstDelivery) throw new Error("missing external delivery");
    const journal = fileJournal(path);
    const store = eventSourcedStore(journal, {
      state: externalState,
      message: externalMessage,
      command: externalCommand,
    });
    const rt = await run(work, {
      store,
      interpret: { external_job: handler },
    }).ready;
    try {
      // #region external-answer
      // The host parses its worker reply, then uses this Cmd's own builder.
      const reply = { ...firstDelivery, value: "report-ready", atMs: 12_345 };
      await rt.dispatch(externalJob.ok(reply.cmd, reply.value, reply.atMs), {
        answerTo: reply.id,
      });
      // This admission is also the receipt, so there is no separate confirmation.
      await rt.stop();
      const stillOwed = logLedger(await store.readLog()).surviving();
      // #endregion external-answer
      expect(stillOwed).toEqual([]);
      expect(rt.getState().settled).toEqual(["report-ready"]);
    } finally {
      await rt.stop();
      await journal.close();
    }
    const nextJournal = fileJournal(path);
    const wake = await run(work, {
      store: eventSourcedStore(nextJournal, {
        state: externalState,
        message: externalMessage,
        command: externalCommand,
      }),
      interpret: { external_job: handler },
    }).ready;
    await wake.stop();
    await nextJournal.close();
    expect(wake.getState().settled).toEqual(["report-ready"]);
    expect(handed).toHaveLength(3);
  });

  it("reads an absolute next deadline across closed calls, then delivers the host's wake once", async () => {
    const path = join(dir, "reminders");
    const next = await call(
      fileJournal(path),
      [{ msg: { _tag: "schedule", atMs: 12_345 }, id: "request-1" }],
      10_000,
    );
    assert.equal(next, 12_345);
    assert.equal(await call(fileJournal(path), [], 11_000), next);
    assert.equal(await call(fileJournal(path), [], 12_345), null);
    assert.equal(await call(fileJournal(path), [], 12_345), null);
    const journal = fileJournal(path);
    try {
      const saved = await eventSourcedStore(journal, {
        state: alarmState,
        message: alarmMessage,
        command: z.never(),
      }).load();
      assert.deepEqual(saved, { due: null, fired: [12_345] });
    } finally {
      await journal.close();
    }
  });

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

    await second.dispatch({ _tag: "start", total: 3 });
    expect(await saved()).toMatchObject({ phase: "downloading" });
  });
});
