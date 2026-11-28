/// <reference types="@cloudflare/workers-types" />
/**
 * @demlik/tea/do — one stored cell of the event-sourced log, kept under the
 * storage value bound.
 *
 * NOT part of the public `./do` barrel: `doEventSourcedStore` and
 * `doEventLogReader` write and read every snapshot and event cell through it.
 *
 * A value whose UTF-8 text is under {@link STORED_VALUE_BYTES} is written as
 * itself at its key, so a log written before this module reads unchanged. A
 * value at or over the bound is written as a versioned manifest at its key
 * (`@@es/cell:1:{"parts":N,"bytes":B}`) and N parts under the parts prefix,
 * each strictly under the bound and cut on a UTF-8 character boundary. The
 * manifest, its parts and the deletion of the parts an earlier, longer value
 * of the key left behind are written in the caller's one transaction, so an
 * interrupted write leaves the stored bytes as they were.
 *
 * A read reassembles a manifest from its parts before anything parses it. A
 * part that is missing, or parts whose bytes do not add up to the manifest's,
 * read as {@link MissingParts} instead of a value, never as a shorter text.
 */

/** Every value the store writes is strictly under this many bytes of UTF-8. */
export const STORED_VALUE_BYTES = 1_000_000;
/** Default key prefix of the parts; the cell's key follows it. */
export const DEFAULT_PART_PREFIX = "@@es/part/";
/** The manifest's prefix, versioned so a later layout can be told apart. */
const MANIFEST_PREFIX = "@@es/cell:1:";
/** Zero-pad part indexes so a part's key sorts by index. */
const PART_INDEX_WIDTH = 6;
/** Keys per `get` / `delete` call; the storage API takes at most 128. */
const GET_BATCH = 128;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * A cell stored in parts whose parts do not reassemble. `serializedBytes` is
 * the size of the parts read before the first missing one, or of all of them
 * when their total does not match the manifest.
 */
export class MissingParts {
  constructor(
    readonly key: string,
    readonly serializedBytes: number,
  ) {}
}

/** What a stored cell's manifest says: how many parts, and their total bytes. */
interface Manifest {
  readonly parts: number;
  readonly bytes: number;
}

/** The rows one cell is written as, and how many of them are parts. */
export interface StoredWrite {
  readonly key: string;
  readonly rows: readonly (readonly [string, string])[];
  readonly parts: number;
}

function partKey(partPrefix: string, key: string, index: number): string {
  return `${partPrefix}${key}/${String(index).padStart(PART_INDEX_WIDTH, "0")}`;
}

/** The manifest a stored value is, or `null` for an ordinary value. PURE. */
function manifestOf(value: unknown): Manifest | null {
  if (typeof value !== "string" || !value.startsWith(MANIFEST_PREFIX))
    return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value.slice(MANIFEST_PREFIX.length));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const { parts, bytes } = raw as { parts?: unknown; bytes?: unknown };
  return typeof parts === "number" &&
    Number.isSafeInteger(parts) &&
    parts > 1 &&
    typeof bytes === "number" &&
    Number.isSafeInteger(bytes) &&
    bytes >= 0
    ? { parts, bytes }
    : null;
}

const isContinuation = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0xc0) === 0x80;

/** `bytes` as texts of under `limit` bytes each, cut between characters. PURE. */
function cut(bytes: Uint8Array, limit: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + limit - 1);
    while (end < bytes.length && end > start && isContinuation(bytes[end]))
      end -= 1;
    parts.push(fromUtf8.decode(bytes.subarray(start, end)));
    start = end;
  }
  return parts;
}

/**
 * The rows `value` is stored as at `key`: itself when it is under the bound,
 * else its manifest followed by its parts. PURE.
 */
export function storedRows(
  partPrefix: string,
  key: string,
  value: string,
): StoredWrite {
  const bytes = utf8.encode(value);
  if (bytes.byteLength < STORED_VALUE_BYTES)
    return { key, rows: [[key, value]], parts: 0 };
  const texts = cut(bytes, STORED_VALUE_BYTES);
  const manifest: Manifest = { parts: texts.length, bytes: bytes.byteLength };
  return {
    key,
    parts: texts.length,
    rows: [
      [key, MANIFEST_PREFIX + JSON.stringify(manifest)],
      ...texts.map(
        (text, index) => [partKey(partPrefix, key, index), text] as const,
      ),
    ],
  };
}

/**
 * Write one cell's rows inside `txn`, first deleting the parts an earlier
 * value of the key had past the new value's count.
 */
export async function putStoredRows(
  txn: DurableObjectTransaction,
  partPrefix: string,
  write: StoredWrite,
): Promise<void> {
  const before = manifestOf(await txn.get<unknown>(write.key));
  if (before !== null && before.parts > write.parts) {
    const stale: string[] = [];
    for (let index = write.parts; index < before.parts; index += 1)
      stale.push(partKey(partPrefix, write.key, index));
    for (let at = 0; at < stale.length; at += GET_BATCH)
      await txn.delete(stale.slice(at, at + GET_BATCH));
  }
  for (const [key, value] of write.rows) await txn.put(key, value);
}

/**
 * `cells` as stored values: an ordinary value as it is, a manifest as the text
 * its parts join to, or {@link MissingParts} when they do not. Keeps the order
 * of `cells`.
 */
export async function readStoredCells(
  storage: DurableObjectStorage,
  partPrefix: string,
  cells: ReadonlyMap<string, unknown>,
  noCache: boolean,
): Promise<Map<string, unknown>> {
  const manifests = new Map<string, Manifest>();
  const wanted: string[] = [];
  for (const [key, value] of cells) {
    const manifest = manifestOf(value);
    if (manifest === null) continue;
    manifests.set(key, manifest);
    for (let index = 0; index < manifest.parts; index += 1)
      wanted.push(partKey(partPrefix, key, index));
  }
  if (manifests.size === 0) return new Map(cells);
  const parts = new Map<string, unknown>();
  for (let at = 0; at < wanted.length; at += GET_BATCH) {
    const page = await storage.get<unknown>(
      wanted.slice(at, at + GET_BATCH),
      noCache ? { noCache } : {},
    );
    for (const [key, value] of page) parts.set(key, value);
  }
  const read = new Map<string, unknown>();
  for (const [key, value] of cells) {
    const manifest = manifests.get(key);
    read.set(
      key,
      manifest === undefined ? value : joined(partPrefix, key, manifest, parts),
    );
  }
  return read;
}

function joined(
  partPrefix: string,
  key: string,
  manifest: Manifest,
  parts: ReadonlyMap<string, unknown>,
): string | MissingParts {
  const texts: string[] = [];
  let bytes = 0;
  for (let index = 0; index < manifest.parts; index += 1) {
    const text = parts.get(partKey(partPrefix, key, index));
    if (typeof text !== "string") return new MissingParts(key, bytes);
    bytes += utf8.encode(text).byteLength;
    texts.push(text);
  }
  return bytes === manifest.bytes
    ? texts.join("")
    : new MissingParts(key, bytes);
}

/** One stored value read at `key`, reassembled as {@link readStoredCells} does. */
export async function readStoredCell(
  storage: DurableObjectStorage,
  partPrefix: string,
  key: string,
  value: unknown,
  noCache: boolean,
): Promise<unknown> {
  if (manifestOf(value) === null) return value;
  return (
    await readStoredCells(storage, partPrefix, new Map([[key, value]]), noCache)
  ).get(key);
}
