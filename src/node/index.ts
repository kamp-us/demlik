/**
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
 *   2. `nodeSubscribe<M, Ctx>()` — handler registry for the three node-native
 *      Sub types this package owns:
 *        - `node_ws`     — opens a `ws` WebSocket; routes open/message/close/
 *                          error into Msgs. Registers the live socket in
 *                          `ctx.wsRegistry` so a Cmd handler can write to it
 *                          (see `sendToWebSocket`). Cleanup closes the socket
 *                          for ANY non-CLOSED state.
 *        - `node_timer`  — setTimeout / setInterval; cleanup clears it.
 *        - `node_signal` — a process signal (SIGINT/SIGTERM/…) → Msg; cleanup
 *                          detaches the listener.
 *
 * Unlike tea-do — whose `alarm()` / `webSocketMessage()` are DO lifecycle
 * methods the handler can't observe from the outside, hence its registries —
 * a node process is continuously alive: each handler holds its resource in
 * closure and the returned cleanup closes it. The substrate's subscription
 * reconciler runs that cleanup the instant `subscriptions(state)` stops listing
 * the Sub — end-then-start choreography for free (Rule 9, [invariant 4]).
 * A lifecycle-bound resource (a socket, a timer) becomes impossible to leak
 * from a reducer cell, because no reducer cell owns its teardown.
 *
 * `ctx.wsRegistry` is the one shared surface: `node_ws` populates it; a Cmd
 * interpreter reads it to write to the open socket. Same shape as tea-do's
 * `wsRegistry`.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Store, Sub, SubId } from "../index";
import WebSocket, { type RawData } from "ws";

// ─────────────────────────────────────────────────────────────────────────────
// fileStore — `Store<S>` over a JSON file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `Store<S>` backed by a JSON file at `path`.
 *
 * `parse` is REQUIRED because the file is a real serialization boundary — the
 * bytes that come back through `JSON.parse` are structurally `unknown`, and the
 * caller (who owns `S`) is the only party that can validate the shape.
 * Returning `null` from `parse` means "no usable persisted state" — the
 * substrate boots `init` with `loaded = null`. `parse` must NOT throw per the
 * `Store<S>.migrate` contract.
 */
export function fileStore<S>(path: string, parse: (raw: unknown) => S | null): Store<S> {
  return {
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
      // through run()'s queue, so there's never a second concurrent writer.
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state), "utf8");
      await rename(tmp, path);
    },
    migrate(raw: unknown): S | null {
      return parse(raw);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NodeSub — the three node-native subscription variants.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A node WebSocket sub. The substrate diffs subs by `id`; the same `id` across
 * transitions = the same socket (kept open). Emit a DIFFERENT `id` to force a
 * reconnect.
 *
 * Only `onMessage` returns `M | null` (null drops the frame) because inbound
 * frames are the boundary that needs a parse-and-maybe-discard seam. `onOpen`/
 * `onClose`/`onError` always dispatch — a spurious one is dropped in the reducer
 * (the cell ignores it), not here.
 */
export type NodeWsSub<M> = {
  id: SubId;
  type: "node_ws";
  url: string;
  onMessage: (data: string) => M | null;
  onOpen?: () => M;
  onClose?: (code: number, reason: string) => M;
  onError?: (message: string) => M;
};

/**
 * A node timer sub. One-shot `setTimeout` by default; `repeat: true` →
 * `setInterval`. Cleanup clears the timer — a timer keyed to a phase is
 * cancelled the moment the machine leaves that phase.
 */
export type NodeTimerSub<M> = {
  id: SubId;
  type: "node_timer";
  delayMs: number;
  msg: M;
  repeat?: boolean;
};

/**
 * A process-signal sub: `signal` (SIGINT/SIGTERM/…) → `msg`. Cleanup detaches
 * the listener. Lets graceful shutdown be a real machine transition rather than
 * an out-of-band `process.on` that the reducer can't see.
 */
export type NodeSignalSub<M> = {
  id: SubId;
  type: "node_signal";
  signal: NodeJS.Signals;
  msg: M;
};

export type NodeSub<M> = NodeWsSub<M> | NodeTimerSub<M> | NodeSignalSub<M>;

// Compile-time guarantee: `NodeSub<M>` is structurally a `Sub` (has `id`+`type`).
// Erased at runtime — the `extends Sub` constraint on the alias's type
// parameter fails to compile if `NodeSub` ever drifts off the `Sub` shape.
export type AssertNodeSubIsSub<T extends Sub = NodeSub<unknown>> = T;

// ─────────────────────────────────────────────────────────────────────────────
// Ctx — what the node Subs read / populate.
// ─────────────────────────────────────────────────────────────────────────────

export type NodeWsRegistry = Map<SubId, WebSocket>;

/**
 * The Ctx fields the node Subs depend on. A consumer's Ctx must extend this so
 * `node_ws` can register the live socket and Cmd handlers can reach it.
 *
 * Deliberately NOT parameterized by Msg (unlike tea-do's `DoSubscribeCtx<M>`):
 * the registry holds raw `WebSocket`s, and each Sub variant carries its own
 * Msg-typed callbacks. Trip-wire: if a future node Sub holds a Msg-typed
 * callback on ctx (the way tea-do's registries do), this becomes
 * `NodeSubscribeCtx<M>`.
 */
export interface NodeSubscribeCtx {
  wsRegistry: NodeWsRegistry;
}

/**
 * Write a frame to a registered `node_ws` socket. No-op (returns `false`) when
 * the socket is absent, not OPEN, or `send()` throws. The Cmd-side companion to
 * the `node_ws` Sub: the Sub owns the socket's lifetime; this writes to it.
 *
 * The contract is a boolean no-op, never a throw: the socket can transition out
 * of OPEN between the `readyState` check and `send()` (or `ws` can throw on an
 * errored underlying connection), and a Cmd interpreter must not crash on that.
 */
export function sendToWebSocket(ctx: NodeSubscribeCtx, id: SubId, data: string): boolean {
  const socket = ctx.wsRegistry.get(id);
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(data);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// nodeSubscribe — the handler registry.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the `subscribe` handlers for `node_ws`, `node_timer`, and
 * `node_signal`. Matches `Machine#subscribe`'s
 * `[K in U["type"]]: (sub, ctx, dispatch) => () => void` contract for the
 * `NodeSub<M>` variants. Generic `Ctx` must extend `NodeSubscribeCtx` so the
 * `node_ws` handler can register its socket.
 */
export function nodeSubscribe<M, Ctx extends NodeSubscribeCtx>(): {
  node_ws: (sub: NodeWsSub<M>, ctx: Ctx, dispatch: (msg: M) => void) => () => void;
  node_timer: (sub: NodeTimerSub<M>, ctx: Ctx, dispatch: (msg: M) => void) => () => void;
  node_signal: (sub: NodeSignalSub<M>, ctx: Ctx, dispatch: (msg: M) => void) => () => void;
} {
  return {
    node_ws: (sub, ctx, dispatch) => {
      const socket = new WebSocket(sub.url);
      ctx.wsRegistry.set(sub.id, socket);

      socket.on("open", () => {
        if (sub.onOpen) dispatch(sub.onOpen());
      });
      socket.on("message", (data: RawData) => {
        const msg = sub.onMessage(data.toString());
        if (msg !== null) dispatch(msg);
      });
      socket.on("close", (code: number, reason: Buffer) => {
        if (sub.onClose) dispatch(sub.onClose(code, reason.toString()));
      });
      socket.on("error", (err: Error) => {
        if (sub.onError) dispatch(sub.onError(err.message));
      });

      return () => {
        ctx.wsRegistry.delete(sub.id);
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
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1000, "tea-node sub cleanup");
        } else if (socket.readyState !== WebSocket.CLOSED) {
          socket.terminate();
        }
      };
    },

    node_timer: (sub, _ctx, dispatch) => {
      // Two reconcile lifecycles under one variant: a one-shot (`setTimeout`)
      // that `subscriptions(state)` should drop on the render after it fires,
      // vs a repeating (`setInterval`) one the state keeps listing across
      // renders. Same Sub.type; the `repeat` flag picks the install + cleanup.
      if (sub.repeat) {
        const handle = setInterval(() => dispatch(sub.msg), sub.delayMs);
        return () => clearInterval(handle);
      }
      const handle = setTimeout(() => dispatch(sub.msg), sub.delayMs);
      return () => clearTimeout(handle);
    },

    node_signal: (sub, _ctx, dispatch) => {
      const handler = () => dispatch(sub.msg);
      process.on(sub.signal, handler);
      return () => {
        process.off(sub.signal, handler);
      };
    },
  };
}
