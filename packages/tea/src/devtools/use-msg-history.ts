import { useCallback, useRef, useState } from "react";
import type { MsgLogEntry } from "./msg-log";

function nowTs(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false }).slice(3);
}

/**
 * Wrap a `dispatch` so every Msg it sees lands in a bounded history buffer.
 *
 * `derive` lets you map a Msg to a richer entry (e.g. assign `kind: "sub"` to
 * subscription-triggered messages). Default: every msg becomes a `"msg"` row
 * tagged with `msg.type` (or `String(msg)` if it has no `type`). The substrate
 * uses `type` as the Msg discriminant — using `_tag` here would render every
 * Msg as `[object Object]` in the inspector.
 *
 * `max` caps the buffer — oldest entries fall off (LIFO, newest first).
 *
 * `now` is the timestamp source for the default `derive`. Defaults to
 * `nowTs` (real wall-clock). Tests inject a deterministic shim so
 * snapshots don't drift; production code never sets it.
 */
export function useMsgHistory<M>(
  dispatch: (msg: M) => void | Promise<void>,
  opts: {
    max?: number;
    derive?: (msg: M) => MsgLogEntry;
    now?: () => string;
  } = {},
): readonly [readonly MsgLogEntry[], (msg: M) => void, () => void] {
  const max = opts.max ?? 60;
  const now = opts.now ?? nowTs;
  const derive =
    opts.derive ??
    ((msg: M): MsgLogEntry => {
      const tag =
        msg && typeof msg === "object" && "type" in msg
          ? String((msg as { type: unknown }).type)
          : String(msg);
      return { ts: now(), kind: "msg", text: tag };
    });

  const [history, setHistory] = useState<readonly MsgLogEntry[]>([]);
  // Stable ref to `dispatch` so the wrapper identity stays stable across
  // renders — important when this is passed to keyboard handlers and the like.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const deriveRef = useRef(derive);
  deriveRef.current = derive;

  const wrapped = useCallback(
    (msg: M) => {
      const entry = deriveRef.current(msg);
      setHistory((prev) => [entry, ...prev].slice(0, max));
      // Fire-and-forget — `dispatch` may return a Promise; we don't await it
      // here because callers historically treat dispatch as void.
      void dispatchRef.current(msg);
    },
    [max],
  );

  const clear = useCallback(() => setHistory([]), []);

  return [history, wrapped, clear] as const;
}
