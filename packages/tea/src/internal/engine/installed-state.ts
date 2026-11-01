/**
 * The one read a view needs before `ready`: the State a `subscribe` listener was
 * last told about. `ready` waits for boot's Cmds, so a store-backed machine whose
 * `init` starts work has told its listeners a State the booted handle cannot
 * serve yet (#695).
 *
 * `RunHandle` still has no `getState`: a caller reading State before boot stays a
 * compile error, and the export map does not change. Symbol-keyed so it reaches
 * no export, and enumerable so it survives the spread a wrapper does over the
 * handle, as `liveWork` is. Its own file so `/react` reads it without importing
 * an engine.
 */
export const installedState: unique symbol = Symbol(
  "demlik-tea.installedState",
);

/** A run handle a view can read the installed State of. */
export interface InstalledStateRead<S> {
  /** `undefined` until the first State is past its save and listeners heard it. */
  readonly [installedState]: () => S | undefined;
}

/**
 * The State `handle` last told its listeners about, or `undefined` when it has
 * told them none yet or carries no such read. An engine typed only to `RunHandle`
 * carries none, and a view on it waits for `ready`.
 */
export function readInstalledState<S>(handle: object): S | undefined {
  return (handle as Partial<InstalledStateRead<S>>)[installedState]?.();
}
