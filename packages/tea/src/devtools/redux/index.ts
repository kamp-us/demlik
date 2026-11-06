/**
 * @packageDocumentation
 * @demlik/tea/devtools/redux — watch, export and import a running machine in
 * the Redux DevTools browser extension.
 *
 * tea ships no debugger window. Redux DevTools already is one, built "for
 * Redux … or any other architecture which handles the state change", and
 * Elmish (the Elm Architecture in F#) debugs through it the same way. This
 * module is the wire between a tea run and that window:
 *
 *   - every applied transition shows up as one action (the Msg) with the State
 *     it produced, so the panel's timeline, state tree and diff work as-is;
 *   - **Export** downloads the session as a file (the panel's own format);
 *   - **Import** loads such a file and replays its Msgs through the machine you
 *     pass in — your current code — without running a single effect, then shows
 *     the states that code computes and names the first Msg where they differ
 *     from the recording, or the Msg your machine no longer has a cell for;
 *   - the panel's **Dispatch** sends a Msg to the run, checked against the Msgs
 *     the current state accepts.
 *
 * What it refuses on purpose: jumping, skipping or reordering never rewind the
 * live run. Its effects already happened, and a rewound State would disagree
 * with the world they changed. Those panel buttons are switched off.
 *
 * `parseDevtoolsExport` turns an exported file into a {@link Trace}, so a
 * session someone saved from the panel becomes a `replayTrace` regression test.
 *
 * The Redux DevTools message shapes are a third-party wire contract; this
 * module breaks when that contract does.
 */

import {
  acceptedTypes,
  type Cmd,
  type Machine,
  type RunHandle,
  type Sub,
} from "../../index";
import type { Trace } from "../../internal/persistence/recorder";
import {
  type ReplayResult,
  replayTrace,
} from "../../internal/persistence/trace-replay";

// === The extension's surface, as far as tea uses it ===

/**
 * The part of `window.__REDUX_DEVTOOLS_EXTENSION__` the bridge calls. Pass a
 * stand-in through {@link ReduxDevtoolsOptions.extension} to test a host
 * without a browser.
 */
export interface ReduxDevtoolsExtension {
  connect(options: Record<string, unknown>): ReduxDevtoolsConnection;
}

/** One connected instance in the panel, as `connect()` returns it. */
export interface ReduxDevtoolsConnection {
  init(state: unknown): void;
  send(action: { readonly type: string } | null, state: unknown): void;
  subscribe(
    listener: (message: MonitorMessage) => void,
  ): (() => void) | undefined;
  unsubscribe(): void;
  error(message: string): void;
}

/**
 * A message the panel sends to the page. Only the fields the bridge reads are
 * typed; the extension sends more.
 */
export interface MonitorMessage {
  readonly type: string;
  readonly payload?: unknown;
}

// === Options and the handle ===

/** The part of a run the bridge listens to — the same on both engines. */
export type DevtoolsRun<S, M extends { type: string }> = Pick<
  RunHandle<S, M>,
  "observe" | "onBoot"
>;

/** Options for {@link connectReduxDevtools}. */
export interface ReduxDevtoolsOptions<M> {
  /** The instance name in the panel's instance picker. Default `"tea"`. */
  readonly name?: string;
  /** How many actions the panel keeps. Default `500`. */
  readonly maxAge?: number;
  /**
   * Enables the panel's Dispatch button: a Msg typed there is checked against
   * the current state's accepted Msgs, then handed to this function. The
   * Promise engine's `runtime.dispatch` fits as it is. On the Effect engine,
   * pass a function that runs the handle's `dispatch` Effect. Omitted, the
   * Dispatch button is off.
   */
  readonly dispatch?: (msg: M) => Promise<unknown>;
  /**
   * The extension to connect to. Default
   * `globalThis.__REDUX_DEVTOOLS_EXTENSION__`.
   */
  readonly extension?: ReduxDevtoolsExtension;
}

/** What {@link connectReduxDevtools} returns. */
export interface DevtoolsBridge {
  /** `false` when no extension was found; the bridge then does nothing. */
  readonly connected: boolean;
  /** Stop listening to the run and to the panel. Idempotent. */
  disconnect(): void;
}

const INIT_ACTION = { type: "@@INIT" } as const;

/**
 * Connect a running machine to the Redux DevTools extension.
 *
 * ```ts
 * const runtime = run(machine, { ctx });
 * connectReduxDevtools(machine, runtime, { dispatch: runtime.dispatch });
 * ```
 *
 * Attach it to the synchronous `run()` handle or later; boot is delivered
 * either way. Without the extension (production, Node, a test) it returns
 * `{ connected: false }` and touches nothing, so it can stay in the code.
 *
 * @param machine - the machine the run was started from. Import replays
 *                  sessions through it, and Dispatch checks Msgs against it.
 * @param run     - the run to watch: its `observe` and `onBoot`.
 */
export function connectReduxDevtools<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  run: DevtoolsRun<S, M>,
  opts: ReduxDevtoolsOptions<M> = {},
): DevtoolsBridge {
  const extension =
    opts.extension ??
    (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: ReduxDevtoolsExtension })
      .__REDUX_DEVTOOLS_EXTENSION__;
  if (extension === undefined) {
    return { connected: false, disconnect: () => {} };
  }

  const dispatch = opts.dispatch;
  const conn = extension.connect({
    name: opts.name ?? "tea",
    maxAge: opts.maxAge ?? 500,
    features: {
      pause: true,
      export: true,
      import: "custom",
      dispatch: dispatch !== undefined,
      lock: false,
      persist: false,
      jump: false,
      skip: false,
      reorder: false,
      test: false,
    },
  });

  // The latest State the run committed: what panel Dispatch checks against.
  let latest: { readonly state: S } | undefined;

  const unboot = run.onBoot((state) => {
    latest = { state };
    conn.init(state);
  });
  const unobserve = run.observe((msg, state) => {
    latest = { state };
    conn.send(msg, state);
  });

  const importSession = (payload: ImportPayload): void => {
    const parsed = traceFromLifted<S, M>(payload.nextLiftedState);
    if (typeof parsed === "string") {
      conn.error(parsed);
      return;
    }
    const result = replayTrace(machine, parsed);
    conn.send(null, liftedFromReplay(parsed, result));
    const verdict = describeReplay(result);
    if (verdict !== null) conn.error(verdict);
  };

  const dispatchFromPanel = (payload: unknown): void => {
    if (dispatch === undefined) return;
    const msg = msgFromPanel(payload);
    if (typeof msg === "string") {
      conn.error(msg);
      return;
    }
    if (latest === undefined) {
      conn.error(
        "tea: the machine has not booted yet; nothing can take a Msg.",
      );
      return;
    }
    const accepted = acceptedTypes(machine, latest.state);
    if (!accepted.includes(msg.type)) {
      conn.error(
        `tea: the current state takes no "${msg.type}" Msg. It accepts: ${
          accepted.length === 0 ? "nothing" : accepted.join(", ")
        }.`,
      );
      return;
    }
    dispatch(msg as M).catch((err: unknown) => {
      conn.error(`tea: dispatching "${msg.type}" failed: ${String(err)}`);
    });
  };

  // One row per panel command. `ignore` rows are commands whose buttons the
  // features above switch off, or that the extension answers on its own
  // (PAUSE_RECORDING); they never rewind the run.
  const onPanelDispatch = {
    IMPORT_STATE: (p) => importSession(p as ImportPayload),
    JUMP_TO_STATE: ignore,
    JUMP_TO_ACTION: ignore,
    TOGGLE_ACTION: ignore,
    ROLLBACK: ignore,
    SWEEP: ignore,
    REORDER_ACTION: ignore,
    LOCK_CHANGES: ignore,
    PAUSE_RECORDING: ignore,
  } satisfies Record<PanelDispatchType, (payload: object) => void>;

  const onMessage = {
    DISPATCH: (payload) => {
      const type = typeField(payload);
      if (type !== undefined && isPanelDispatchType(type)) {
        onPanelDispatch[type](payload as object);
      }
    },
    ACTION: dispatchFromPanel,
    START: ignore,
    STOP: ignore,
    IMPORT: ignore,
    EXPORT: ignore,
    UPDATE: ignore,
    OPTIONS: ignore,
  } satisfies Record<MonitorMessageType, (payload: unknown) => void>;

  const unsubscribe = conn.subscribe((message) => {
    if (isMonitorMessageType(message.type)) {
      onMessage[message.type](message.payload);
    }
  });

  let connected = true;
  return {
    get connected() {
      return connected;
    },
    disconnect() {
      if (!connected) return;
      connected = false;
      unboot();
      unobserve();
      unsubscribe?.();
      conn.unsubscribe();
    },
  };
}

// === The panel's commands ===

const MONITOR_MESSAGE_TYPES = [
  "DISPATCH",
  "ACTION",
  "START",
  "STOP",
  "IMPORT",
  "EXPORT",
  "UPDATE",
  "OPTIONS",
] as const;
type MonitorMessageType = (typeof MONITOR_MESSAGE_TYPES)[number];

const PANEL_DISPATCH_TYPES = [
  "IMPORT_STATE",
  "JUMP_TO_STATE",
  "JUMP_TO_ACTION",
  "TOGGLE_ACTION",
  "ROLLBACK",
  "SWEEP",
  "REORDER_ACTION",
  "LOCK_CHANGES",
  "PAUSE_RECORDING",
] as const;
type PanelDispatchType = (typeof PANEL_DISPATCH_TYPES)[number];

function isMonitorMessageType(type: string): type is MonitorMessageType {
  return (MONITOR_MESSAGE_TYPES as readonly string[]).includes(type);
}

function isPanelDispatchType(type: string): type is PanelDispatchType {
  return (PANEL_DISPATCH_TYPES as readonly string[]).includes(type);
}

function ignore(): void {}

function typeField(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

interface ImportPayload {
  readonly nextLiftedState?: unknown;
}

/**
 * Read the Msg the panel's Dispatch box sends. The extension passes the typed
 * text through as a string; tea reads it as JSON rather than evaluating it.
 */
function msgFromPanel(payload: unknown): { type: string } | string {
  const hint =
    'tea: type the Msg as JSON with a string "type", e.g. {"type":"increment"}.';
  if (typeof payload !== "string") return hint;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return hint;
  }
  return typeField(value) === undefined ? hint : (value as { type: string });
}

// === Sessions: the panel's lifted state <-> a tea Trace ===

interface PerformAction {
  readonly type: "PERFORM_ACTION";
  readonly action: { readonly type: string };
  readonly timestamp: number;
}

interface LiftedState {
  readonly actionsById: Readonly<Record<number, PerformAction>>;
  readonly computedStates: readonly {
    readonly state: unknown;
    readonly error?: string;
  }[];
  readonly stagedActionIds: readonly number[];
  readonly skippedActionIds: readonly number[];
  readonly committedState: unknown;
  readonly currentStateIndex: number;
  readonly nextActionId: number;
  readonly isLocked: boolean;
  readonly isPaused: boolean;
  readonly monitorState: unknown;
}

/**
 * Turn the panel's session into a Trace, or return why it cannot be one.
 *
 * The first staged action is the panel's `@@INIT`; its computed state is the
 * State the run booted into, the replay anchor. Every later staged action is a
 * Msg, and its computed state is the State the recording reached after it.
 * Skipped actions were not applied, so they are left out. A bare list of
 * actions is refused: it records no State to start from or compare against.
 */
function traceFromLifted<S, M>(lifted: unknown): Trace<S, M> | string {
  if (!isLiftedState(lifted)) {
    return "tea: this is not a Redux DevTools session with its States (it needs actionsById, computedStates and stagedActionIds).";
  }
  const skipped = new Set(lifted.skippedActionIds);
  const [initId, ...ids] = lifted.stagedActionIds;
  const anchor = lifted.computedStates[0];
  if (initId === undefined || anchor === undefined) {
    return "tea: this session is empty; it has no starting State.";
  }
  const steps: { msg: M; state: S }[] = [];
  for (const [i, id] of ids.entries()) {
    if (skipped.has(id)) continue;
    const performed = lifted.actionsById[id];
    const computed = lifted.computedStates[i + 1];
    if (performed === undefined || computed === undefined) {
      return `tea: action ${id} is staged but missing from the session.`;
    }
    steps.push({ msg: performed.action as M, state: computed.state as S });
  }
  const loaded = anchor.state as S;
  return {
    loaded,
    msgs: steps.map((s) => s.msg),
    finalState: steps.at(-1)?.state ?? loaded,
    steps,
  };
}

function isLiftedState(value: unknown): value is LiftedState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<LiftedState>;
  return (
    typeof v.actionsById === "object" &&
    Array.isArray(v.computedStates) &&
    Array.isArray(v.stagedActionIds)
  );
}

/**
 * The session as the current machine computes it, in the panel's shape. A
 * refused Msg is kept as the last action, carrying the refusal as its error.
 */
function liftedFromReplay<S, M extends { type: string }>(
  trace: Trace<S, M>,
  result: ReplayResult<S, M>,
): LiftedState {
  const now = Date.now();
  const perform = (action: { type: string }): PerformAction => ({
    type: "PERFORM_ACTION",
    action,
    timestamp: now,
  });
  const actions: PerformAction[] = [perform(INIT_ACTION)];
  const computed: { state: unknown; error?: string }[] = [
    { state: trace.loaded },
  ];
  for (const [i, state] of result.states.entries()) {
    const msg = trace.msgs[i];
    if (msg === undefined) break;
    actions.push(perform(msg));
    computed.push({ state });
  }
  if (result.refusal !== undefined) {
    actions.push(perform(result.refusal.msg));
    computed.push({ state: result.actual, error: refusalText(result.refusal) });
  }
  const ids = actions.map((_, id) => id);
  return {
    actionsById: Object.fromEntries(actions.map((a, id) => [id, a])),
    computedStates: computed,
    stagedActionIds: ids,
    skippedActionIds: [],
    committedState: trace.loaded,
    currentStateIndex: ids.length - 1,
    nextActionId: ids.length,
    isLocked: false,
    isPaused: false,
    monitorState: {},
  };
}

function refusalText(
  refusal: NonNullable<ReplayResult<unknown, { type: string }>["refusal"]>,
): string {
  const accepts =
    refusal.acceptedTypes.length === 0
      ? "accepts no Msg"
      : `accepts ${refusal.acceptedTypes.join(", ")}`;
  return `Msg #${refusal.index + 1} "${refusal.msg.type}" has no cell in state "${refusal.stateName}" (it ${accepts}).`;
}

/** The one line the panel shows after an import, or `null` when it matches. */
function describeReplay<S, M extends { type: string }>(
  result: ReplayResult<S, M>,
): string | null {
  if (result.refusal !== undefined) {
    return `tea: your machine cannot replay this session. ${refusalText(result.refusal)}`;
  }
  const d = result.divergence;
  if (d === undefined) return null;
  const where =
    d.at === undefined
      ? "by its last Msg"
      : `at Msg #${d.at.index + 1} "${d.at.msg.type}"`;
  return `tea: your current code diverges from this session ${where}: ${d.path} was ${show(d.expected)}, now ${show(d.actual)}.`;
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/**
 * Read a session file the panel's Export button saved into a {@link Trace},
 * ready for `replayTrace`. The panel saves its lifted state as plain JSON, or
 * wrapped as `{ payload }` with the payload a JSON string; both are read.
 * Throws with the reason when the file is not a session.
 *
 * ```ts
 * const trace = parseDevtoolsExport<State, Msg>(readFileSync("state.json", "utf8"));
 * expect(replayTrace(machine, trace).matches).toBe(true);
 * ```
 */
export function parseDevtoolsExport<S, M>(json: string): Trace<S, M> {
  const file: unknown = JSON.parse(json);
  const payload = (file as { payload?: unknown } | null)?.payload;
  const lifted: unknown =
    typeof payload === "string" ? JSON.parse(payload) : file;
  const trace = traceFromLifted<S, M>(lifted);
  if (typeof trace === "string") throw new Error(trace);
  return trace;
}
