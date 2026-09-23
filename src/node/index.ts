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
 *      substrate calls `migrate`, which returns `null` and boots fresh.
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

import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type WebSocket from "ws";
import type { RawData } from "ws";
import type { Dispose, FencedStore, Store, Sub } from "../index";
import { StoreConflictError } from "../index";
import {
  type Journal,
  type JournalEntry,
  makeJournal,
  type Seq,
} from "../internal/journal";
import { dispatchIfPresent } from "../subs/types";

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
 * Returning `null` from `parse` means "no usable persisted state" — the
 * substrate boots `init` with `loaded = null`. `parse` must NOT throw per the
 * `Store<S>.migrate` contract.
 *
 * Pass `{ fenced: true }` to get a `FencedStore<S>` instead — see
 * {@link FileStoreOptions}.
 */
export function fileStore<S>(
  path: string,
  parse: (raw: unknown) => S | null,
): Store<S>;
export function fileStore<S>(
  path: string,
  parse: (raw: unknown) => S | null,
  options: FileStoreOptions & { readonly fenced: true },
): FencedStore<S>;
export function fileStore<S>(
  path: string,
  parse: (raw: unknown) => S | null,
  options?: FileStoreOptions,
): Store<S> | FencedStore<S>;
export function fileStore<S>(
  path: string,
  parse: (raw: unknown) => S | null,
  options: FileStoreOptions = {},
): Store<S> | FencedStore<S> {
  const base: Store<S> = {
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
    migrate(raw: unknown): S | null {
      return parse(raw);
    },
  };
  return options.fenced === true ? fenceFileStore(base, path) : base;
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
function fenceFileStore<S>(base: Store<S>, path: string): FencedStore<S> {
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
      await mkdir(dirname(path), { recursive: true });
      await acquireFileLock(dirname(path), lockPath);
      try {
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
      } finally {
        await unlink(lockPath).catch(() => {});
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fileJournal — a `Journal<R>` over one on-disk JSONL file per stream.
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_SPIN_MS = 10;

/**
 * The Node file substrate for the journal (`src/internal/journal/`), beside
 * `fileStore`. A
 * stream is one JSONL file under `dir` (`<encoded-stream>.jsonl`), one
 * `{"seq":n,"record":…}` object per line — readable and greppable on disk, no
 * SQLite. `parse` is REQUIRED for the same reason `fileStore` requires it: the
 * bytes read back through `JSON.parse` are structurally `unknown`, and the
 * caller who owns `R` is the only party that can validate a record's shape.
 *
 * `append` rewrites the whole stream file via a pid-scoped temp + `rename`,
 * exactly as `fileStore.save` does — a reader sees the old file or the new one,
 * never a torn line, and the write survives a crash mid-append. The append is
 * O(n) in the stream's length; a durable record log a machine replays is read
 * whole anyway, so the atomic-rewrite guarantee is worth the cost.
 *
 * The ordering key is taken under a `wx` lock file (`<file>.lock`) holding the
 * writer's PID: a second writer racing the same stream blocks on the lock, so
 * `seq` is a single total order across processes. A crashed writer's lock is
 * stolen once its PID proves dead (`process.kill(pid, 0)` → `ESRCH`), so a
 * crash never wedges the stream. This is the lock phoenix spike #6673 proved:
 * its only job is an honest order key, not the win.
 *
 * `changes` fires for appends made through THIS instance; a cross-process
 * append lands on disk but is not broadcast here (that is a polling concern the
 * log leaves to its consumer, and the remote-journal work downstream).
 */
export function fileJournal<R>(
  dir: string,
  parse: (raw: unknown) => R,
): Journal<R> {
  const streamPath = (stream: string): string =>
    join(dir, `${encodeURIComponent(stream)}.jsonl`);

  const readEntries = async (stream: string): Promise<JournalEntry<R>[]> => {
    const path = streamPath(stream);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const row = JSON.parse(line) as { seq: Seq; record: unknown };
        return { stream, seq: row.seq, record: parse(row.record) };
      });
  };

  return makeJournal<R>({
    read: readEntries,
    async append(stream, record) {
      const entries = await readEntries(stream);
      const entry: JournalEntry<R> = {
        stream,
        seq: entries.length + 1,
        record,
      };
      const path = streamPath(stream);
      const lines = [...entries, entry]
        .map((e) => JSON.stringify({ seq: e.seq, record: e.record }))
        .join("\n");
      await mkdir(dir, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${lines}\n`, "utf8");
      await rename(tmp, path);
      return entry;
    },
    async lock(stream, fx) {
      const lockPath = `${streamPath(stream)}.lock`;
      await acquireFileLock(dir, lockPath);
      try {
        return await fx();
      } finally {
        await unlink(lockPath).catch(() => {});
      }
    },
  });
}

/**
 * Acquire an exclusive lock by creating `lockPath` with `wx` (O_CREAT|O_EXCL) —
 * the one primitive that is atomic across processes. On contention, steal the
 * lock only once its holder's PID proves dead; otherwise spin. `process.kill(pid,
 * 0)` sends no signal — it tests existence: it throws `ESRCH` for a dead PID,
 * and `EPERM` for a live one this process may not signal (still alive, so hold
 * off). A lock that vanishes between the failed create and the read is already
 * free, so retry.
 */
async function acquireFileLock(dir: string, lockPath: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await stealIfStale(lockPath)) continue;
      await new Promise((resolve) => setTimeout(resolve, LOCK_SPIN_MS));
    }
  }
}

async function stealIfStale(lockPath: string): Promise<boolean> {
  let holder: string;
  try {
    holder = await readFile(lockPath, "utf8");
  } catch (err) {
    // Vanished between the failed create and this read — already free.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
  const pid = Number(holder.trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (isProcessAlive(pid)) return false;
  await unlink(lockPath).catch(() => {});
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
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
 * this door at all (`ERR_MODULE_NOT_FOUND`). The type import above is erased,
 * and the value arrives through this loader at the moment a socket is actually
 * opened — so the cost of an optional peer is paid by the feature that needs
 * it, not by the door it happens to share.
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
