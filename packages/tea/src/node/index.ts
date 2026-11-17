/**
 * @packageDocumentation
 * @demlik/tea/node — Node host adapter for `@demlik/tea`.
 *
 * Every host adapter ships two halves (mirrors `@demlik/tea/do`):
 *
 *   1. `fileStore<S>(path, parse)` — a `Store<S>` over a JSON file on disk.
 *      Atomic save (temp + rename). Absent file → `load()` resolves `null`
 *      (fresh boot). Structurally malformed JSON throws at `load()` (an infra
 *      error), matching `doStore`; a shape mismatch is NOT a throw — the
 *      substrate calls `migrate`, which returns `refuse(reason)`. Both make
 *      `ready` reject with `StoreRefusedError`, and the file is left as is.
 *      Use for resumable scripts / local repro of prod machines. Ephemeral
 *      CLIs can skip persistence with `memoryStore` from `@demlik/tea/mem`.
 *
 *   2. `nodeSubscribe<M, Ctx>({ ws })` — the runners for the three node-native
 *      Sub types this package owns, handed to `run` as its `subscribe`:
 *        - `node_ws`     — deps `{ key, url }`. Opens a `ws` WebSocket; routes
 *                          open/message/close/error into Msgs through the `ws`
 *                          handlers. Registers the live socket in
 *                          `ctx.wsRegistry` under `key` so a Cmd handler can
 *                          write to it (see `sendToWebSocket`). Cleanup closes
 *                          the socket for ANY non-CLOSED state.
 *        - `node_timer`  — deps `{ delayMs, msg, repeat? }`. setTimeout /
 *                          setInterval; cleanup clears it.
 *        - `node_signal` — deps `{ signal, msg }`. A process signal
 *                          (SIGINT/SIGTERM/…) → Msg; cleanup detaches the
 *                          listener.
 *
 * Unlike tea-do — whose `alarm()` / `webSocketMessage()` are DO lifecycle
 * methods the handler can't observe from the outside, hence its registries —
 * a node process is continuously alive: each runner holds its resource in
 * closure and the returned cleanup closes it. The engine runs that cleanup the
 * instant the Sub's `deps` go null, and a changed `deps` value stops the old
 * runner before starting the new one — end-then-start choreography for free
 * (Rule 9, [invariant 4]). A lifecycle-bound resource (a socket, a timer)
 * becomes impossible to leak from a reducer cell, because no reducer cell owns
 * its teardown.
 *
 * `ctx.wsRegistry` is the one shared surface: `node_ws` populates it, keyed by
 * the Sub's `deps.key`; a Cmd interpreter reads it to write to the open
 * socket. Same shape as tea-do's `wsRegistry`.
 */

import * as journalFs from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type WebSocket from "ws";
import type { RawData } from "ws";
import type {
  DeletableStore,
  Dispose,
  FencedStore,
  Migrated,
  Sub,
} from "../index";
import { StoreConflictError } from "../index";
import type {
  Journal,
  JournalEntry,
  JournalRefusal,
} from "../internal/journal";
import { dispatchIfPresent } from "../subs/types";
import { withFileLock } from "./file-lock";

export { type FileLockBlock, FileLockTimeoutError } from "./file-lock";

// ─────────────────────────────────────────────────────────────────────────────
// fileStore — `Store<S>` over a JSON file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a machine's state to a JSON file — pass the `path` and a `parse` that
 * validates what comes back, get a `Store<S>` you hand to `run` so the next run
 * resumes where this one stopped.
 *
 * `parse` is REQUIRED because the file is a real serialization boundary — the
 * bytes that come back through `JSON.parse` are structurally `unknown`, and the
 * caller (who owns `S`) is the only party that can validate the shape.
 * `parse` returns `S` for a shape it recognizes, `null` when nothing was saved
 * (the substrate boots `init` with `loaded = null`), and `refuse(reason)` for
 * saved bytes it cannot read (`ready` rejects with `StoreRefusedError`).
 * `parse` must NOT throw per the `Store<S>.migrate` contract.
 *
 * Pass `{ fenced: true }` to get a `FencedStore<S>` instead — see
 * {@link FileStoreOptions}.
 *
 * Either form is a `DeletableStore<S>`: `delete()` removes the state file and
 * its `<path>.fence` version stamp, so a host that forgets a run needs no
 * knowledge of the layout on disk.
 */
export function fileStore<S>(
  path: string,
  parse: (raw: unknown) => Migrated<S>,
): DeletableStore<S>;
export function fileStore<S>(
  path: string,
  parse: (raw: unknown) => Migrated<S>,
  options: FileStoreOptions & { readonly fenced: true },
): FencedStore<S> & DeletableStore<S>;
export function fileStore<S>(
  path: string,
  parse: (raw: unknown) => Migrated<S>,
  options?: FileStoreOptions,
): DeletableStore<S> | (FencedStore<S> & DeletableStore<S>);
export function fileStore<S>(
  path: string,
  parse: (raw: unknown) => Migrated<S>,
  options: FileStoreOptions = {},
): DeletableStore<S> | (FencedStore<S> & DeletableStore<S>) {
  const base: DeletableStore<S> = {
    async load(): Promise<unknown> {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      // JSON.parse throws on structural malformation — propagate (infra error),
      // matching `doStore`. The decoded value is intentionally returned as
      // `unknown`; the substrate's `migrate` callback is the boundary parse.
      return JSON.parse(raw);
    },
    async save(state: S): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      // Write to a pid-scoped temp then atomically rename. The rename gives
      // torn-write safety (a reader sees the old file or the new one, never a
      // partial) and survives process crash / Ctrl-C — the only failure a local
      // resumable run resumes from. fsync (file + dir) would add power-loss
      // durability the use case doesn't need; the substrate serializes saves
      // through run()'s queue, so there's never a second concurrent writer
      // WITHIN one run. Between two runs there is nothing here refusing one —
      // that is what `{ fenced: true }` below adds (#143).
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state), "utf8");
      await rename(tmp, path);
    },
    migrate(raw: unknown): Migrated<S> {
      return parse(raw);
    },
    async delete(): Promise<void> {
      await removeStateFiles(path);
    },
  };
  return options.fenced === true ? fenceFileStore(base, path) : base;
}

/**
 * Remove a `fileStore`'s state file and its `.fence` stamp; an absent one is
 * already deleted. The unfenced store removes the stamp too, because a file
 * written fenced can be opened unfenced and a stale stamp would outlive it.
 *
 * Stamp FIRST, state second. A crash between the two leaves the bytes at
 * version `0`, which a live fenced run reads as a conflict — the safe
 * direction. The reverse leaves the old version beside no state, and a run
 * still holding that version would swap cleanly onto a deleted run.
 */
async function removeStateFiles(path: string): Promise<void> {
  for (const file of [`${path}.fence`, path]) {
    await unlink(file).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}

/** Options for {@link fileStore}. */
export interface FileStoreOptions {
  /**
   * Refuse a second live writer (#143). With `{ fenced: true }` the returned
   * store is a `FencedStore<S>`: it carries a version stamp beside the state
   * file, and `run` compare-and-swaps against it on every save. A process that
   * boots reads the current version and takes the fence; the older live writer
   * that started from the same version is refused with a `StoreConflictError`
   * at its next save. Omit it and the store is exactly as it was — the last
   * writer wins, and single-writer is the caller's precondition to keep.
   *
   * A run on a fenced store must be given an `onError`, or it does not compile
   * (see `StoreAndOnError`). A lost fence can surface with no caller to reject
   * at, under `"stop-save"` or `"follow-up"`, and the default sink would rethrow
   * it and end the process. Treat a `StoreConflictError` there as this run having
   * moved to another process: stop that run, and leave the others alone.
   *
   * Each save and `delete()` takes a lock file, `<path>.fence.lock`, and a
   * writer that dies holding it leaves it behind. The next write steals a lock
   * whose holder is proven gone: an empty one older than a short grace period,
   * one from an earlier boot of this machine, or one whose process is dead.
   *
   * Any other lock is waited on for up to 10 seconds, and then the write rejects
   * with a {@link FileLockTimeoutError} naming the file. That includes a lock
   * from another host, which is never stolen because that host may be live on a
   * shared volume. So a folder restored onto a new machine can need one clear
   * step: once the old machine is known to be gone, delete the file. Hosts are
   * told apart by `os.hostname()`, so give two live hosts on one volume two
   * names.
   */
  readonly fenced?: true;
}

/**
 * The fencing half of {@link fileStore}. The state file itself is unchanged, so
 * a file written unfenced resumes fenced and back again; the version lives in a
 * sidecar `<path>.fence` holding a decimal integer, and an absent stamp is `0`.
 *
 * The compare-and-swap is taken under the same `wx` lock file `fileJournal`
 * uses, because `open(…, "wx")` is the one primitive that is atomic ACROSS
 * PROCESSES. Without it the read-compare-write is a TOCTOU race and two writers
 * both pass their own check. Rename-over-tmp still does the torn-write work for
 * each of the two files; the lock does the exclusion no rename could.
 */
function fenceFileStore<S>(
  base: DeletableStore<S>,
  path: string,
): FencedStore<S> & DeletableStore<S> {
  const fencePath = `${path}.fence`;
  const lockPath = `${path}.fence.lock`;

  async function readVersion(): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(fencePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
    const version = Number.parseInt(raw.trim(), 10);
    // A stamp we cannot read is not a version we may assume: defaulting it to 0
    // would let a fresh writer win a fence against a live one.
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error(
        `fileStore: version stamp at "${fencePath}" is not an integer: ${raw}`,
      );
    }
    return version;
  }

  return {
    ...base,
    fenced: true,
    async loadFenced(): Promise<{ raw: unknown; version: number }> {
      // Version FIRST, bytes second: a writer landing between the two reads
      // leaves us with a version OLDER than the bytes, so our next save is
      // refused. Reading bytes first could hand back a version newer than them,
      // and that save would silently win.
      const version = await readVersion();
      return { raw: await base.load(), version };
    },
    async saveFenced(state: S, expectedVersion: number): Promise<number> {
      return withFileLock(dirname(path), lockPath, async () => {
        const actual = await readVersion();
        if (actual !== expectedVersion) {
          throw new StoreConflictError(expectedVersion, actual);
        }
        const next = expectedVersion + 1;
        // State before stamp. A crash between the two leaves a stamp BEHIND the
        // bytes, which reads as a conflict for the next writer — the safe
        // direction. The reverse advertises a write that never landed.
        await base.save(state);
        const tmp = `${fencePath}.${process.pid}.tmp`;
        await writeFile(tmp, String(next), "utf8");
        await rename(tmp, fencePath);
        return next;
      });
    },
    async delete(): Promise<void> {
      // Under the swap's own lock, so a delete never lands between another
      // writer's state write and its stamp write.
      await withFileLock(dirname(path), lockPath, () => base.delete());
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fileJournal — a `Journal<R>` over one on-disk JSONL file per stream.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append encoded JSON text in atomic batches under `dir`.
 * Each stream is `<encoded-stream>.jsonl`; each LF-terminated storage frame
 * contains one array of opaque strings. The driver never parses record bodies.
 *
 * One writer per stream is the caller's precondition. This driver takes no
 * cross-process lock and offers no fenced widening. Reads refresh incrementally,
 * omit an incomplete tail without changing it, and the next append truncates
 * that tail before writing. Short writes are completed before acknowledgement.
 * Complete batches survive controlled process interruption; no fsync or
 * power-loss guarantee is made.
 *
 * The factory remains experimental on the stable `./node` subpath.
 * @experimental
 */
export function fileJournal(dir: string): Journal {
  const streams = new Map<
    string,
    { end: number; tail: number; rows: JournalEntry[] }
  >();
  const path = (stream: string) =>
    join(dir, `${encodeURIComponent(stream)}.jsonl`);
  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  const corruption = (detail: string) => new SyntaxError(detail);
  const refusal = (
    error: unknown,
    operation: "read" | "append",
  ): JournalRefusal =>
    error instanceof SyntaxError
      ? { _tag: "journal_corrupt", message: message(error) }
      : {
          _tag: "journal_io",
          operation,
          message: message(error),
          uncertain: operation === "append",
        };

  journalFs.mkdirSync(dir, { recursive: true });
  function refresh(stream: string) {
    const info = streams.get(stream) ?? { end: 0, tail: 0, rows: [] };
    let fd: number;
    try {
      fd = journalFs.openSync(path(stream), "r");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT" &&
        info.end === 0
      )
        return info;
      throw error;
    }
    try {
      const size = journalFs.fstatSync(fd).size;
      if (size < info.end) throw corruption("Storage shrank behind a reader");
      const raw = Buffer.alloc(size - info.end);
      let offset = 0;
      while (offset < raw.length) {
        const count = journalFs.readSync(
          fd,
          raw,
          offset,
          raw.length - offset,
          info.end + offset,
        );
        if (count === 0) throw new Error("Unexpected storage end");
        offset += count;
      }
      const end = raw.lastIndexOf(10) + 1;
      const added: JournalEntry[] = [];
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          raw.subarray(0, end),
        );
      } catch {
        throw corruption("Invalid UTF-8 storage frame");
      }
      for (const line of text.split("\n").slice(0, -1)) {
        const frame: unknown = JSON.parse(line);
        if (
          !Array.isArray(frame) ||
          frame.length === 0 ||
          !frame.every((value: unknown) => typeof value === "string")
        ) {
          throw corruption("Invalid storage frame");
        }
        for (const record of frame)
          added.push({ seq: info.rows.length + added.length + 1, record });
      }
      for (const entry of added) info.rows.push(entry);
      info.end += end;
      info.tail = raw.length - end;
      streams.set(stream, info);
      return info;
    } finally {
      journalFs.closeSync(fd);
    }
  }
  return {
    async read(stream, after) {
      try {
        const { rows } = refresh(stream);
        return { _tag: "read", head: rows.length, entries: rows.slice(after) };
      } catch (error) {
        return refusal(error, "read");
      }
    },
    async append(stream, records) {
      try {
        const info = refresh(stream);
        const entries = records.map((record, i) => ({
          seq: info.rows.length + i + 1,
          record,
        }));
        const bytes = Buffer.from(`${JSON.stringify(records)}\n`);
        const fd = journalFs.openSync(path(stream), "a");
        try {
          if (info.tail) journalFs.ftruncateSync(fd, info.end);
          let offset = 0;
          while (offset < bytes.length) {
            const count = journalFs.writeSync(
              fd,
              bytes,
              offset,
              bytes.length - offset,
            );
            if (count === 0) throw new Error("Storage write made no progress");
            offset += count;
          }
        } finally {
          journalFs.closeSync(fd);
        }
        for (const entry of entries) info.rows.push(entry);
        info.end += bytes.length;
        info.tail = 0;
        streams.set(stream, info);
        return { _tag: "appended", head: info.rows.length, entries };
      } catch (error) {
        streams.delete(stream);
        return refusal(error, "append");
      }
    },
    async close() {
      streams.clear();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NodeSub — the three node-native subscription variants.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `deps` of a `node_ws` Sub: which socket (`key`) and where it connects
 * (`url`). Both are plain data, so the engine derives the Sub's id from them —
 * the same `{ key, url }` across transitions is the same socket (kept open),
 * and a changed one closes it and opens a fresh one.
 *
 * `key` is the author's name for the socket: the Cmd side addresses it through
 * {@link sendToWebSocket} by that key, since the derived Sub id is not
 * something a Cmd handler can know. It must be unique among the machine's live
 * `node_ws` Subs.
 */
export type NodeWsDeps = { readonly key: string; readonly url: string };

/**
 * A node WebSocket sub. Its callbacks are not data, so they live on the runner
 * side — {@link NodeWsHandlers}, handed to {@link nodeSubscribe}.
 */
export type NodeWsSub = Sub<"node_ws", NodeWsDeps>;

/**
 * The `deps` of a `node_timer` Sub. One-shot `setTimeout` by default;
 * `repeat: true` → `setInterval`.
 */
export type NodeTimerDeps<M> = {
  readonly delayMs: number;
  readonly msg: M;
  readonly repeat?: boolean;
};

/**
 * A node timer sub. Cleanup clears the timer — a timer keyed to a phase is
 * cancelled the moment the machine leaves that phase, and a changed
 * `delayMs` / `msg` / `repeat` is a new id, so the timer restarts. For a plain
 * one-shot, the engine's built-in `timer` Sub needs no runner at all.
 */
export type NodeTimerSub<M> = Sub<"node_timer", NodeTimerDeps<M>>;

/** The `deps` of a `node_signal` Sub: `signal` (SIGINT/SIGTERM/…) → `msg`. */
export type NodeSignalDeps<M> = {
  readonly signal: NodeJS.Signals;
  readonly msg: M;
};

/**
 * A process-signal sub. Cleanup detaches the listener. Lets graceful shutdown
 * be a real machine transition rather than an out-of-band `process.on` that the
 * reducer can't see.
 */
export type NodeSignalSub<M> = Sub<"node_signal", NodeSignalDeps<M>>;

/**
 * The union of the Sub types the Node adapter ships runners for: WebSocket,
 * timer and process signal.
 */
export type NodeSub<M> = NodeWsSub | NodeTimerSub<M> | NodeSignalSub<M>;

// ─────────────────────────────────────────────────────────────────────────────
// Ctx — what the node Subs read / populate.
// ─────────────────────────────────────────────────────────────────────────────

/** The live `node_ws` sockets, keyed by each Sub's `deps.key`. */
export type NodeWsRegistry = Map<string, WebSocket>;

// ─────────────────────────────────────────────────────────────────────────────
// ws — loaded on first use, never at module load.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ws` is an OPTIONAL peer: the `node_ws` Sub needs it, `fileStore` and
 * `fileJournal` — everything the tutorial uses — do not. A static
 * `import … from "ws"` puts the dependency on the module's load path, so a
 * consumer who installed only the tutorial's three packages could not import
 * this subpath at all (`ERR_MODULE_NOT_FOUND`). The type import above is erased,
 * and the value arrives through this loader at the moment a socket is actually
 * opened — so the cost of an optional peer is paid by the feature that needs
 * it, not by the subpath it happens to share.
 *
 * `createRequire` rather than `await import("ws")` because a runner's
 * contract is synchronous — it must return its cleanup on the same tick the
 * engine starts it, and a deferred socket would give cleanup nothing to close.
 */
type NodeWsConstructor = new (url: string) => WebSocket;

let cachedWs: NodeWsConstructor | undefined;

function loadWebSocket(): NodeWsConstructor {
  if (cachedWs) return cachedWs;
  let mod: unknown;
  try {
    mod = createRequire(import.meta.url)("ws");
  } catch (cause) {
    throw new Error(
      'The `node_ws` Sub needs the optional peer dependency "ws". Install it: `npm install ws`.',
      { cause },
    );
  }
  const ctor = (mod as { default?: NodeWsConstructor }).default ?? mod;
  cachedWs = ctor as NodeWsConstructor;
  return cachedWs;
}

/**
 * `WebSocket.OPEN`, inlined. Reading it off the class would drag `ws` onto the
 * load path of `sendToWebSocket`, which is a Cmd-side helper a caller can reach
 * without ever opening a socket. The value is fixed by the WHATWG WebSocket
 * spec, not by `ws`.
 */
const WS_OPEN = 1;

/** `WebSocket.CLOSED`, inlined for the same reason as {@link WS_OPEN}. */
const WS_CLOSED = 3;

/**
 * The Ctx fields the `node_ws` runner depends on. A consumer's Ctx must extend
 * this so the runner can register the live socket and Cmd handlers can reach
 * it.
 *
 * Deliberately NOT parameterized by Msg: the registry holds raw `WebSocket`s,
 * and the Msg-typed callbacks live in the {@link NodeWsHandlers} handed to
 * `nodeSubscribe`. Trip-wire: if a future node Sub holds a Msg-typed callback
 * on ctx, this becomes `NodeSubscribeCtx<M>`.
 */
export interface NodeSubscribeCtx {
  wsRegistry: NodeWsRegistry;
}

/**
 * Write a frame to the `node_ws` socket whose `deps.key` is `key`. No-op
 * (returns `false`) when the socket is absent, not OPEN, or `send()` throws.
 * The Cmd-side companion to the `node_ws` Sub: the Sub owns the socket's
 * lifetime; this writes to it.
 *
 * The contract is a boolean no-op, never a throw: the socket can transition out
 * of OPEN between the `readyState` check and `send()` (or `ws` can throw on an
 * errored underlying connection), and a Cmd interpreter must not crash on that.
 */
export function sendToWebSocket(
  ctx: NodeSubscribeCtx,
  key: string,
  data: string,
): boolean {
  const socket = ctx.wsRegistry.get(key);
  if (!socket || socket.readyState !== WS_OPEN) return false;
  try {
    socket.send(data);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// nodeSubscribe — the runner table.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a `node_ws` socket's events become. Functions cannot be `deps`, so they
 * live here, on the runner side; each receives the running Sub so one handler
 * table can branch on `sub.deps` (its `key` or `url`) when a machine runs more
 * than one socket.
 *
 * Only `onMessage` returns `M | null` (null drops the frame) because inbound
 * frames are the boundary that needs a parse-and-maybe-discard seam. `onOpen`/
 * `onClose`/`onError` always dispatch — a spurious one is dropped in the reducer
 * (the cell ignores it), not here. An omitted one dispatches nothing.
 */
export interface NodeWsHandlers<M> {
  onMessage(data: string, sub: NodeWsSub): M | null;
  onOpen?(sub: NodeWsSub): M;
  onClose?(code: number, reason: string, sub: NodeWsSub): M;
  onError?(message: string, sub: NodeWsSub): M;
}

/** The options of {@link nodeSubscribe}: the `node_ws` handlers, when used. */
export interface NodeSubscribeOpts<M> {
  readonly ws: NodeWsHandlers<M>;
}

/** The `node_timer` + `node_signal` runners — what every `nodeSubscribe` returns. */
export interface NodeSubscribeBase<M> {
  node_timer: (
    sub: NodeTimerSub<M>,
    ctx: unknown,
    dispatch: (msg: M) => void,
  ) => Dispose;
  node_signal: (
    sub: NodeSignalSub<M>,
    ctx: unknown,
    dispatch: (msg: M) => void,
  ) => Dispose;
}

/** The full runner table, with `node_ws` — `nodeSubscribe({ ws })`. */
export interface NodeSubscribeWithWs<M, Ctx extends NodeSubscribeCtx>
  extends NodeSubscribeBase<M> {
  node_ws: (sub: NodeWsSub, ctx: Ctx, dispatch: (msg: M) => void) => Dispose;
}

/**
 * Build the `subscribe` runners for the node Sub types, to hand to `run`:
 * `run(machine, { subscribe: nodeSubscribe<M, Ctx>({ ws: { onMessage } }), ctx })`.
 *
 * `node_timer` and `node_signal` read everything off `sub.deps`, so they need
 * no options. `node_ws` needs its {@link NodeWsHandlers}; called without them,
 * the table has no `node_ws` runner, so a machine that declares `NodeWsSub`
 * fails to typecheck at `run` rather than opening a socket nobody listens to.
 * `Ctx` must extend {@link NodeSubscribeCtx} so the `node_ws` runner can
 * register its socket.
 */
export function nodeSubscribe<M>(): NodeSubscribeBase<M>;
export function nodeSubscribe<M, Ctx extends NodeSubscribeCtx>(
  opts: NodeSubscribeOpts<M>,
): NodeSubscribeWithWs<M, Ctx>;
export function nodeSubscribe<M, Ctx extends NodeSubscribeCtx>(
  opts?: NodeSubscribeOpts<M>,
): NodeSubscribeBase<M> | NodeSubscribeWithWs<M, Ctx> {
  const base: NodeSubscribeBase<M> = {
    node_timer: (sub, _ctx, dispatch) => {
      // Two reconcile lifecycles under one type: a one-shot (`setTimeout`)
      // whose `deps` should go null on the state after it fires, vs a
      // repeating (`setInterval`) one the state keeps on. The `repeat` flag
      // picks the install + cleanup.
      const { delayMs, msg, repeat } = sub.deps;
      if (repeat) {
        const handle = setInterval(() => dispatch(msg), delayMs);
        return () => clearInterval(handle);
      }
      const handle = setTimeout(() => dispatch(msg), delayMs);
      return () => clearTimeout(handle);
    },

    node_signal: (sub, _ctx, dispatch) => {
      const { signal, msg } = sub.deps;
      const handler = () => dispatch(msg);
      process.on(signal, handler);
      return () => {
        process.off(signal, handler);
      };
    },
  };
  if (opts === undefined) return base;
  return { ...base, node_ws: nodeWsRunner<M, Ctx>(opts.ws) };
}

function nodeWsRunner<M, Ctx extends NodeSubscribeCtx>(
  handlers: NodeWsHandlers<M>,
): NodeSubscribeWithWs<M, Ctx>["node_ws"] {
  return (sub, ctx, dispatch) => {
    const { key, url } = sub.deps;
    // Two live sockets under one key would make `sendToWebSocket` ambiguous,
    // and the first one's cleanup would unregister the second. The engine
    // stops a Sub before it starts its replacement, so a key still held here
    // is two concurrent Subs sharing it — an authoring bug, refused loudly.
    if (ctx.wsRegistry.has(key)) {
      throw new Error(
        `node_ws: a live socket is already registered under key "${key}" — each running node_ws Sub needs its own \`deps.key\`.`,
      );
    }
    const socket = new (loadWebSocket())(url);
    ctx.wsRegistry.set(key, socket);

    socket.on("open", () => {
      if (handlers.onOpen) dispatch(handlers.onOpen(sub));
    });
    socket.on("message", (data: RawData) => {
      dispatchIfPresent(dispatch, handlers.onMessage(data.toString(), sub));
    });
    socket.on("close", (code: number, reason: Buffer) => {
      if (handlers.onClose)
        dispatch(handlers.onClose(code, reason.toString(), sub));
    });
    socket.on("error", (err: Error) => {
      if (handlers.onError) dispatch(handlers.onError(err.message, sub));
    });

    return () => {
      ctx.wsRegistry.delete(key);
      socket.removeAllListeners();
      // Swallow teardown-induced errors: terminate()-ing a CONNECTING socket
      // emits an 'error' ("closed before the connection was established"),
      // and with our listeners gone that would be an unhandled 'error' that
      // crashes the process. A no-op listener absorbs it.
      socket.on("error", () => {});
      // Close for ANY non-closed state: a graceful 1000 when OPEN, a hard
      // terminate() otherwise (CONNECTING/CLOSING) so a socket caught mid-
      // handshake can't dangle. This is the teardown the hand-driven Cmd-pair
      // approach (`cleanup_browser` closing the ws only `if OPEN`) could not
      // guarantee.
      if (socket.readyState === WS_OPEN) {
        socket.close(1000, "tea-node sub cleanup");
      } else if (socket.readyState !== WS_CLOSED) {
        socket.terminate();
      }
    };
  };
}
