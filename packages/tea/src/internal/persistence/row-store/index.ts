import type {
  DeletableStore,
  FencedStore,
  Refusal,
} from "../../../runtime-types";
import { refuse, StoreConflictError } from "../../../runtime-types";

/**
 * One SQL row, bound by the host to its table and row id (and, when the save
 * must be part of the host's transaction, to that transaction's connection).
 * tea imports no SQL library. Each call is ONE atomic statement and the port
 * holds no state.
 *
 * @experimental
 */
export interface RowPort {
  /** The row's columns and its revision, or `null` when no row exists. `row` is never `null`, and a revision starts at 1. */
  read(): Promise<{ readonly row: unknown; readonly revision: number } | null>;
  /** Insert the row with `columns` at revision 1. `true` if inserted; `false`, writing nothing, if a row already exists. */
  insert(columns: Readonly<Record<string, unknown>>): Promise<boolean>;
  /** Set `columns` and the revision to `expected + 1` where the row's revision is `expected`. `true` if a row changed, `false` if none did. */
  update(
    columns: Readonly<Record<string, unknown>>,
    expected: number,
  ): Promise<boolean>;
  /** Delete the row. Resolves when no row exists, so deleting nothing is fine. */
  remove(): Promise<void>;
}

/**
 * The host's side of the boundary for {@link rowStore}.
 *
 * @experimental
 */
export interface RowStoreOptions<S> {
  /** The row's columns to `S`, or `refuse(reason)` for a row it cannot read. It never answers `null`: the row exists, and absence is decided only by `read` returning no row. It is never called with `null`, and it must not throw. */
  readonly parse: (row: unknown) => S | Refusal;
  /** `S` to the row's columns. It must not throw. The revision is the port's, never part of the columns. */
  readonly encode: (state: S) => Readonly<Record<string, unknown>>;
  /** Asked for by name, as on every fenced factory (ADR 0017, item 4). There is no unfenced form. */
  readonly fenced: true;
}

/**
 * A fenced `Store` whose storage is one SQL row: the State lives in the row's
 * own columns, and the fence is the row's revision.
 *
 * Built for a machine whose State is read by SQL and whose writers are
 * stateless requests. A request is one `run`:
 *
 * ```ts
 * const store = rowStore(port, { parse, encode, fenced: true });
 * const rt = await run(job, { store, boot: "restored", interpret, onError }).ready;
 * await rt.dispatch({ _tag: "claim", by: "w1" });
 * await rt.stop();
 * ```
 *
 * `saveFenced(state, n)` writes revision `n + 1` or throws `StoreConflictError`
 * carrying both versions; revision 0 is the insert. `actualVersion` is the
 * revision a diagnostic read observed after the refusal, or 0 when it found no
 * row, so it is not necessarily the revision at the failed comparison. It
 * equals `expectedVersion` when that read finds the revision that was expected,
 * as `StoreConflictError(n, n)` after an update that changed nothing, and as
 * `StoreConflictError(0, 0)` when a refused insert's row has vanished by then.
 * A failed diagnostic read propagates its rejection. A run on a fenced store
 * needs an `onError` (ADR 0031).
 *
 * With `boot: "restored"` (ADR 0039), for an existing row, when `init` returns
 * the loaded State itself (`Object.is`), no Subs or Cmd follow-ups dispatch
 * additional messages, and storage succeeds, a one-Msg request costs one read
 * and zero writes for a no-cell refusal, or one read and one write for an
 * accepted transition. Birth and a changed State from init add a boot write. A
 * failed save can add diagnostic reads and a final save attempt at stop. On a
 * wake, restored init's Cmds do not run; on a birth, with nothing loaded,
 * init's Cmds run.
 *
 * Bind `port` to the host's transaction and the save is part of it. tea opens
 * no transaction and has no commit hook: a lost fence reaches the host as the
 * rejection of the dispatch whose save was refused, or of `ready` for a birth
 * race, and throwing it out of the transaction rolls the sibling writes back.
 *
 * An insert always writes revision 1, so after `delete()` a re-created row
 * starts again at revision 1: a host that re-creates a deleted id must not let
 * writers from before the delete continue.
 *
 * Pending work is not stored: keep it in the State (see
 * `docs/explanation/durability-model.md`).
 *
 * @experimental
 */
export function rowStore<S>(
  port: RowPort,
  options: RowStoreOptions<S>,
): FencedStore<S> & DeletableStore<S> {
  const { parse, encode } = options;
  const loadFenced = async (): Promise<{ raw: unknown; version: number }> => {
    const stored = await port.read();
    return stored === null
      ? { raw: null, version: 0 }
      : { raw: stored.row, version: stored.revision };
  };
  const saveFenced = async (
    state: S,
    expectedVersion: number,
  ): Promise<number> => {
    const columns = encode(state);
    const written =
      expectedVersion === 0
        ? await port.insert(columns)
        : await port.update(columns, expectedVersion);
    if (!written) {
      const actual = (await port.read())?.revision ?? 0;
      throw new StoreConflictError(expectedVersion, actual);
    }
    return expectedVersion + 1;
  };
  return {
    fenced: true,
    loadFenced,
    saveFenced,
    async load() {
      return (await loadFenced()).raw;
    },
    async save(state) {
      await saveFenced(state, (await loadFenced()).version);
    },
    migrate: (raw) => {
      if (raw === null) return null;
      const parsed = parse(raw);
      return parsed === null
        ? refuse("the row exists, and parse answered nothing for it")
        : parsed;
    },
    delete: () => port.remove(),
  };
}
