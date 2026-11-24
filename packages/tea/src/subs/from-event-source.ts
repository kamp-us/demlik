import type { Sub } from "../index";
import type {
  MinimalEvent,
  MinimalEventSourceCtor,
  MinimalMessageEvent,
  MinimalServerSentMessageEvent,
} from "./platform";
import { dispatchIfPresent, type SubscribeHandler } from "./types";

type EventSourceSubData = { readonly url: string };

declare const EventSource: MinimalEventSourceCtor;

const CONNECTING = 0;
const CLOSED = 2;

/**
 * The connection state of an `EventSource` when its `error` event fired.
 *
 * - `"connecting"` — the browser is reconnecting on its own; more events may
 *   still arrive on the same source.
 * - `"closed"` — the browser gave up (a non-2xx answer, a wrong content type,
 *   or a fatal network error). No event will arrive again until the Sub
 *   restarts, for example on a changed url.
 * - `"open"` — the source was open; reported as-is for completeness.
 */
export type EventSourceReadyState = "connecting" | "open" | "closed";

/**
 * One named server-sent event as a host receives it: the event's `type` (the
 * SSE `event:` field), its `data` (the `data:` lines joined), and the
 * `lastEventId` the browser holds after this event (the `id:` field, or the
 * last one seen).
 */
export interface ServerSentEvent<T extends string = string> {
  readonly type: T;
  readonly data: string;
  readonly lastEventId: string;
}

/**
 * The named server-sent event types a `fromEventSource` Sub listens to, and
 * the one callback that maps each of them to a Msg.
 */
export interface EventSourceNamedEvents<S, M, T extends string = string> {
  /**
   * The SSE `event:` names to listen for. A type the host does not name here
   * never reaches `onEvent`. Naming `"message"` here as well as passing
   * `onMessage` delivers an unnamed event to both.
   */
  readonly types: readonly T[];
  /**
   * Map one named event to a Msg, or to `null` to drop it.
   */
  readonly onEvent: (event: ServerSentEvent<T>, sub: S) => M | null;
}

/**
 * Options for `fromEventSource`: map each server-sent event, error and open
 * event to a Msg, or to `null` to drop it.
 *
 * Every callback is optional; one that is omitted attaches no listener, so its
 * event is dropped silently.
 */
export interface EventSourceFactoryOpts<S, M, T extends string = string> {
  /**
   * An unnamed server-sent event (no `event:` field, or `event: message`).
   * Receives the event's `data` string.
   */
  onMessage?: (data: string, sub: S) => M | null;
  /**
   * The named server-sent event types to receive, and the one callback that
   * maps type, `data` and `lastEventId` to a Msg.
   */
  events?: EventSourceNamedEvents<S, M, T>;
  /**
   * The `error` event. It fires both while the browser reconnects and when it
   * gives up; `readyState` tells the two apart without holding the source:
   * `"connecting"` means a retry is under way, `"closed"` means the source is
   * done.
   */
  onError?: (
    event: MinimalEvent,
    sub: S,
    readyState: EventSourceReadyState,
  ) => M | null;
  /**
   * The `open` event: the connection's handshake succeeded. Treat it as
   * best-effort, since not every browser fires it again on reconnect.
   */
  onOpen?: (sub: S) => M | null;
}

function readyStateOf(state: number): EventSourceReadyState {
  if (state === CLOSED) return "closed";
  if (state === CONNECTING) return "connecting";
  return "open";
}

/**
 * Build a Sub runner that opens an `EventSource` on `sub.deps.url` and
 * dispatches a Msg for each server-sent event.
 *
 * `onMessage` receives unnamed events. A stream whose server names its events
 * (the SSE `event:` field, as `sseHub` writes them) is received through
 * `events`: list the types, and one `onEvent` maps each event's type, `data`
 * and `lastEventId` to a Msg. `onError` receives the source's ready state, so
 * a host can tell a reconnecting source from a closed one.
 *
 * The url lives in the Sub's `deps`, so a changed url is a new Sub id: the
 * engine closes the old source and opens one on the new url. Cleanup removes
 * every listener the runner added and closes the source.
 *
 * @example
 * ```ts
 * import { fromEventSource, type Sub } from "@demlik/tea";
 *
 * type FeedSub = Sub<"feed", { readonly url: string }>;
 * type Msg =
 *   | { _tag: "entry_received"; body: string; id: string }
 *   | { _tag: "feed_reset" }
 *   | { _tag: "feed_lost" };
 *
 * export const subscribe = {
 *   feed: fromEventSource<FeedSub, Msg, "entry" | "reset">({
 *     events: {
 *       types: ["entry", "reset"],
 *       onEvent: (e) =>
 *         e.type === "entry"
 *           ? { _tag: "entry_received", body: e.data, id: e.lastEventId }
 *           : { _tag: "feed_reset" },
 *     },
 *     onError: (_e, _sub, readyState) =>
 *       readyState === "closed" ? { _tag: "feed_lost" } : null,
 *   }),
 * };
 * ```
 */
export function fromEventSource<
  S extends Sub<string, EventSourceSubData>,
  M,
  T extends string = string,
>(opts: EventSourceFactoryOpts<S, M, T>): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const source = new EventSource(sub.deps.url);
    const detach: Array<() => void> = [];

    const onMessage = opts.onMessage;
    if (onMessage) {
      const messageListener = (event: MinimalMessageEvent): void => {
        dispatchIfPresent(dispatch, onMessage(event.data as string, sub));
      };
      source.addEventListener("message", messageListener);
      detach.push(() => source.removeEventListener("message", messageListener));
    }

    const events = opts.events;
    if (events) {
      for (const type of new Set(events.types)) {
        const namedListener = (event: MinimalServerSentMessageEvent): void => {
          dispatchIfPresent(
            dispatch,
            events.onEvent(
              {
                type,
                data: event.data as string,
                lastEventId: event.lastEventId,
              },
              sub,
            ),
          );
        };
        source.addEventListener(type, namedListener);
        detach.push(() => source.removeEventListener(type, namedListener));
      }
    }

    const onError = opts.onError;
    if (onError) {
      const errorListener = (event: MinimalEvent): void => {
        dispatchIfPresent(
          dispatch,
          onError(event, sub, readyStateOf(source.readyState)),
        );
      };
      source.addEventListener("error", errorListener);
      detach.push(() => source.removeEventListener("error", errorListener));
    }

    const onOpen = opts.onOpen;
    if (onOpen) {
      const openListener = (): void => {
        dispatchIfPresent(dispatch, onOpen(sub));
      };
      source.addEventListener("open", openListener);
      detach.push(() => source.removeEventListener("open", openListener));
    }

    return () => {
      for (const remove of detach) remove();
      source.close();
    };
  };
}
