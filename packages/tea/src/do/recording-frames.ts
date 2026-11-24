/**
 * The recording format of a `doEventSourcedStore` log. A recording log keeps a
 * frame per cell instead of a bare Msg: an `init` frame for each boot save and a
 * `step` frame for each applied Msg, each with the State after it and the Cmds
 * the engine started for it. A cell is JSON text that starts with
 * {@link RECORDING_PREFIX}, which is how a reader tells the two formats apart.
 *
 * The evidence is stored whole (the State's deflated JSON, the Cmds' JSON as a
 * delta against it) or as a delta against the previous frame's evidence bytes,
 * `{"state":…,"cmds":…}`. Every {@link FULL_FRAME_EVERY}th frame is whole, so a
 * chain of deltas is bounded. Deltas are Fossil's; a read verifies each checksum.
 */

import { applyDelta, createDelta } from "fossil-delta";

export const RECORDING_FORMAT = "recording/1";

/** Every recording cell's text starts with this. */
export const RECORDING_PREFIX = `{"tea":"${RECORDING_FORMAT}"`;

/** A delta chain is cut by a whole frame at least this often. */
export const FULL_FRAME_EVERY = 32;

/** Which format a log's cells are written in. */
export type LogFormat = "messages" | "recording";

/** How a frame's evidence is stored. */
export type EvidenceEncoding = StoredEvidence["encoding"];

const RECORDING_FAMILY = '{"tea":"recording/';

/**
 * The format of one stored cell. A cell is a recording cell when its text
 * starts with a `tea` field of `recording/<version>`, so a version this build
 * does not know is refused, never read as a Msg. A bare Msg with another `tea`
 * field is a Msg. The one collision is a Msg whose own first field is `tea`,
 * with a value that starts `recording/`.
 */
export function cellFormatOf(value: unknown): LogFormat {
  return typeof value === "string" && value.startsWith(RECORDING_FAMILY)
    ? "recording"
    : "messages";
}

/** A frame's evidence: the State after it and the Cmds it started. */
export interface FrameEvidence {
  readonly state: unknown;
  /** `null` when the engine did not report the Cmds. */
  readonly cmds: readonly unknown[] | null;
}

/**
 * Why a recording cell does not decode as a frame: its text is not a frame of
 * this format (`frame`), a delta's basis is missing (`basis`), the evidence
 * does not rebuild, or fails its checksum (`checksum`), or the frame was too
 * large for a storage row and a refusal marker was written in its place
 * (`oversized`).
 */
export type FrameRefusal = "frame" | "basis" | "checksum" | "oversized";

/**
 * The refusal marker written in place of a frame too large for a storage row:
 * which frame it replaces, the seq it is stored at, and the UTF-8 bytes of the
 * key and cell that were not written. It keeps no evidence and no Msg.
 */
export interface OversizedMarker {
  readonly of: "init" | "step";
  readonly seq: number;
  readonly bytes: number;
}

/** The evidence bytes of one frame, which the next frame's delta is taken from. */
export interface Basis {
  readonly seq: number;
  readonly bytes: Uint8Array;
  /** How many deltas lie between this frame and the last whole one. */
  readonly chain: number;
}

/** A frame's evidence as stored, before it is rebuilt. */
export type StoredEvidence =
  | {
      readonly encoding: "full";
      readonly state: string;
      readonly cmds: string | null;
    }
  | { readonly encoding: "delta"; readonly delta: string };

/** A recording cell as parsed, its evidence still in the form it was stored. */
export type EncodedFrame =
  | {
      readonly frame: "init";
      readonly restored: boolean;
      readonly provenance: unknown;
      readonly skipped: number;
      readonly evidence: StoredEvidence;
    }
  | {
      readonly frame: "step";
      readonly msg: unknown;
      readonly evidence: StoredEvidence;
    };

/** What a frame says about itself, apart from its evidence. */
export type FrameHead =
  | {
      readonly frame: "init";
      readonly restored: boolean;
      readonly provenance: unknown;
      readonly skipped?: number;
    }
  | { readonly frame: "step"; readonly msgJson: string };

const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

function isObject(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * What a recording cell holds apart from its evidence, which is all a fold of
 * its Msgs needs: an init frame (which a fold skips) or a step frame and its
 * Msg, or the marker written in place of an oversized frame. `null` when the
 * JSON is not a frame of this format. The evidence is not read, so a cell whose
 * evidence is unreadable still gives its Msg.
 */
export function parseCellMsg(
  raw: unknown,
):
  | { readonly frame: "init" }
  | { readonly frame: "step"; readonly msg: unknown }
  | ({ readonly frame: "oversized" } & OversizedMarker)
  | null {
  if (!isObject(raw) || raw.tea !== RECORDING_FORMAT) return null;
  if (raw.frame === "init") return { frame: "init" };
  if (raw.frame === "refused") {
    const marker = parseOversized(raw);
    return marker === null ? null : { frame: "oversized", ...marker };
  }
  if (raw.frame === "step" && "msg" in raw) {
    return { frame: "step", msg: raw.msg };
  }
  return null;
}

function parseOversized(raw: Record<string, unknown>): OversizedMarker | null {
  const { reason, of, seq, bytes } = raw;
  if (reason !== "oversized" || (of !== "init" && of !== "step")) return null;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    return null;
  }
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    return null;
  }
  return { of, seq, bytes };
}

/**
 * The cell written in place of a frame too large for a storage row. It names
 * the frame it replaces, its seq and the measured bytes, and nothing else.
 */
export function encodeOversized(marker: OversizedMarker): string {
  return `{"tea":"${RECORDING_FORMAT}","frame":"refused","reason":"oversized","of":"${marker.of}","seq":${marker.seq},"bytes":${marker.bytes}}`;
}

/** Parse a recording cell's JSON, or `null` when it is not a frame of this format. */
export function parseFrame(raw: unknown): EncodedFrame | null {
  const cell = parseCellMsg(raw);
  if (cell === null || cell.frame === "oversized" || !isObject(raw)) {
    return null;
  }
  const stored = raw.evidence;
  if (!isObject(stored)) return null;
  if (stored.cmds !== undefined && typeof stored.cmds !== "string") return null;
  if (stored.delta !== undefined && typeof stored.delta !== "string") {
    return null;
  }
  let evidence: StoredEvidence;
  if (typeof stored.full === "string") {
    evidence = {
      encoding: "full",
      state: stored.full,
      cmds: stored.cmds ?? null,
    };
  } else if (stored.delta !== undefined) {
    evidence = { encoding: "delta", delta: stored.delta };
  } else {
    return null;
  }
  if (cell.frame === "step") return { frame: "step", msg: cell.msg, evidence };
  if (typeof raw.restored !== "boolean") return null;
  const skipped = raw.skipped ?? 0;
  if (
    typeof skipped !== "number" ||
    !Number.isSafeInteger(skipped) ||
    skipped < 0
  ) {
    return null;
  }
  return {
    frame: "init",
    restored: raw.restored,
    provenance: raw.provenance ?? null,
    skipped,
    evidence,
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 32768) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1)
    bytes[at] = binary.charCodeAt(at);
  return bytes;
}

async function through(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The bytes a frame's delta is taken from: its State and its Cmds as JSON. */
function evidenceBytes(stateJson: string, cmdsJson: string | null): Uint8Array {
  return utf8.encode(
    cmdsJson === null
      ? `{"state":${stateJson}}`
      : `{"state":${stateJson},"cmds":${cmdsJson}}`,
  );
}

/**
 * Write one frame at `seq`. A frame is a delta against `basis` when `basis` is
 * the frame just before it, the chain is not too long and the delta is smaller;
 * otherwise it is whole. Returns the cell's text and the basis for the next frame.
 */
export async function encodeFrame(
  seq: number,
  head: FrameHead,
  evidence: FrameEvidence,
  basis: Basis | null,
): Promise<{ readonly json: string; readonly basis: Basis }> {
  const stateJson = JSON.stringify(evidence.state);
  const cmdsJson =
    evidence.cmds === null ? null : JSON.stringify(evidence.cmds);
  const target = evidenceBytes(stateJson, cmdsJson);
  const stateBytes = utf8.encode(stateJson);
  const state = toBase64(
    await through(stateBytes, new CompressionStream("deflate-raw")),
  );
  const full =
    cmdsJson === null
      ? `{"full":"${state}"}`
      : `{"full":"${state}","cmds":"${toBase64(createDelta(stateBytes, utf8.encode(cmdsJson)))}"}`;
  let stored = full;
  let chain = 0;
  if (
    basis !== null &&
    basis.seq === seq - 1 &&
    basis.chain < FULL_FRAME_EVERY - 1
  ) {
    const delta = toBase64(createDelta(basis.bytes, target));
    if (delta.length + 2 < full.length) {
      stored = `{"delta":"${delta}"}`;
      chain = basis.chain + 1;
    }
  }
  const json =
    head.frame === "init"
      ? `{"tea":"${RECORDING_FORMAT}","frame":"init","restored":${head.restored},${(head.skipped ?? 0) > 0 ? `"skipped":${head.skipped},` : ""}"provenance":${JSON.stringify(head.provenance) ?? "null"},"evidence":${stored}}`
      : `{"tea":"${RECORDING_FORMAT}","frame":"step","msg":${head.msgJson},"evidence":${stored}}`;
  return { json, basis: { seq, bytes: target, chain } };
}

/**
 * Rebuild one frame's evidence bytes. A whole frame needs nothing; a delta needs
 * `basis` to be the frame just before it. Returns the refusal when it cannot.
 */
export async function rebuildEvidence(
  seq: number,
  stored: StoredEvidence,
  basis: Basis | null,
): Promise<Basis | "basis" | "checksum"> {
  if (stored.encoding === "full") {
    try {
      const stateBytes = await through(
        fromBase64(stored.state),
        new DecompressionStream("deflate-raw"),
      );
      const cmdsJson =
        stored.cmds === null
          ? null
          : utf8Strict.decode(
              applyDelta(stateBytes, fromBase64(stored.cmds), {
                verifyChecksum: true,
              }),
            );
      return {
        seq,
        bytes: evidenceBytes(utf8Strict.decode(stateBytes), cmdsJson),
        chain: 0,
      };
    } catch {
      return "checksum";
    }
  }
  if (basis === null || basis.seq !== seq - 1) return "basis";
  try {
    const bytes = applyDelta(basis.bytes, fromBase64(stored.delta), {
      verifyChecksum: true,
    });
    return { seq, bytes, chain: basis.chain + 1 };
  } catch {
    return "checksum";
  }
}

/** Read the State and Cmds out of rebuilt evidence bytes, or `null` when they are not JSON of that shape. */
export function readEvidence(bytes: Uint8Array): FrameEvidence | null {
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Strict.decode(bytes));
  } catch {
    return null;
  }
  if (!isObject(raw) || !("state" in raw)) return null;
  if (!("cmds" in raw)) return { state: raw.state, cmds: null };
  return Array.isArray(raw.cmds) ? { state: raw.state, cmds: raw.cmds } : null;
}
