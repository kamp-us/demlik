/**
 * The recording format of a `doEventSourcedStore` log: a frame is written whole
 * or as a delta against the frame before it, and reads back to the same State
 * and Cmds. The codec is pure, so each case here is one frame or a short chain.
 */

import { describe, expect, it } from "vitest";
import {
  type Basis,
  type EncodedFrame,
  encodeFrame,
  encodeOversized,
  type FrameEvidence,
  type FrameHead,
  parseCellMsg,
  parseFrame,
  RECORDING_PREFIX,
  readEvidence,
  rebuildEvidence,
  type StoredEvidence,
} from "./recording-frames";

const init: FrameHead = {
  frame: "init",
  restored: false,
  provenance: { run: "r" },
};
const step = (msg: unknown): FrameHead => ({
  frame: "step",
  msgJson: JSON.stringify(msg),
});

/** A State large enough that a one-field change is a smaller delta than a whole frame. */
const stateAt = (n: number) => ({
  n,
  items: Array.from({ length: 40 }, (_, at) => `item-${at}`),
});

async function frameOf(json: string): Promise<EncodedFrame> {
  const frame = parseFrame(JSON.parse(json));
  if (frame === null) throw new Error(`not a frame: ${json}`);
  return frame;
}

async function rebuilt(
  seq: number,
  evidence: StoredEvidence,
  basis: Basis | null,
): Promise<Basis> {
  const result = await rebuildEvidence(seq, evidence, basis);
  if (typeof result === "string") throw new Error(result);
  return result;
}

/** Write each evidence in turn at seq 1, 2, … and return every cell and its basis. */
async function writeChain(evidence: readonly FrameEvidence[]) {
  const cells: { json: string; basis: Basis }[] = [];
  let basis: Basis | null = null;
  for (const [at, one] of evidence.entries()) {
    const written = await encodeFrame(
      at + 1,
      at === 0 ? init : step({ _tag: "inc", by: at }),
      one,
      basis,
    );
    cells.push(written);
    basis = written.basis;
  }
  return cells;
}

describe("a frame written whole", () => {
  it("reads back to its State and Cmds", async () => {
    const evidence = { state: stateAt(0), cmds: [{ _tag: "go" }] };
    const { json } = await encodeFrame(1, init, evidence, null);

    const frame = await frameOf(json);
    expect(json.startsWith(RECORDING_PREFIX)).toBe(true);
    expect(frame).toMatchObject({
      frame: "init",
      restored: false,
      provenance: { run: "r" },
      evidence: { encoding: "full" },
    });
    const basis = await rebuilt(1, frame.evidence, null);
    expect(readEvidence(basis.bytes)).toEqual(evidence);
  });

  it("writes provenance null for an init given none", async () => {
    const { json } = await encodeFrame(
      1,
      { frame: "init", restored: false, provenance: undefined },
      { state: { n: 0 }, cmds: null },
      null,
    );

    expect(JSON.parse(json)).toMatchObject({ provenance: null });
    expect(parseFrame(JSON.parse(json))).toMatchObject({ provenance: null });
  });

  it("reads back a State whose deflated bytes run past 32 KiB", async () => {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let seed = 7;
    const noise = Array.from({ length: 160_000 }, () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return alphabet[(seed >>> 16) % 64];
    }).join("");
    const evidence = { state: { noise }, cmds: [{ _tag: "go" }] };

    const { json } = await encodeFrame(1, init, evidence, null);

    const frame = await frameOf(json);
    if (frame.evidence.encoding !== "full") throw new Error("not whole");
    expect(frame.evidence.state.length).toBeGreaterThan(131_072);
    const basis = await rebuilt(1, frame.evidence, null);
    expect(readEvidence(basis.bytes)).toEqual(evidence);
  });

  it("keeps the Msg's own JSON, and says when the engine reported no Cmds", async () => {
    const { json } = await encodeFrame(
      1,
      step({ _tag: "inc", by: 1 }),
      { state: { n: 1 }, cmds: null },
      null,
    );

    expect(json).toContain('"msg":{"_tag":"inc","by":1}');
    const frame = await frameOf(json);
    expect(frame.evidence).toMatchObject({ encoding: "full", cmds: null });
    const basis = await rebuilt(1, frame.evidence, null);
    expect(readEvidence(basis.bytes)).toEqual({
      state: { n: 1 },
      cmds: null,
    });
  });

  it("keeps the bytes of a cell an earlier build of this format wrote", async () => {
    const cell =
      '{"tea":"recording/1","frame":"init","restored":false,"provenance":{"run":"r"},"evidence":{"full":"q1bKU7Iy0FHKLEnNLVayilZKVNJRSlKKrQUA","cmds":"RgpGOlt7Il90YWciOiJnbyJ9XWhWNHNsOw=="}}';
    const evidence = {
      state: { n: 0, items: ["a", "b"] },
      cmds: [{ _tag: "go" }],
    };

    const frame = await frameOf(cell);
    const basis = await rebuilt(1, frame.evidence, null);
    expect(readEvidence(basis.bytes)).toEqual(evidence);
    expect((await encodeFrame(1, init, evidence, null)).json).toBe(cell);
  });
});

describe("a frame written as a delta", () => {
  it("is smaller than the whole frame, and rebuilds against the frame before it", async () => {
    const evidence = [
      { state: stateAt(0), cmds: [] },
      { state: stateAt(1), cmds: [{ _tag: "go" }] },
      { state: stateAt(2), cmds: [] },
    ];
    const cells = await writeChain(evidence);

    const frames = await Promise.all(cells.map((cell) => frameOf(cell.json)));
    expect(frames.map((frame) => frame.evidence.encoding)).toEqual([
      "full",
      "delta",
      "delta",
    ]);
    expect(cells.map((cell) => cell.basis.chain)).toEqual([0, 1, 2]);
    let basis: Basis | null = null;
    for (const [at, frame] of frames.entries()) {
      basis = await rebuilt(at + 1, frame.evidence, basis);
      expect(readEvidence(basis.bytes)).toEqual(evidence[at]);
      expect([basis.seq, basis.chain]).toEqual([at + 1, at]);
    }
  });

  it("keeps the bytes of a cell an earlier build of this format wrote", async () => {
    const first = {
      state: { n: 0, items: ["a", "b"] },
      cmds: [{ _tag: "go" }],
    };
    const cell =
      '{"tea":"recording/1","frame":"step","msg":{"_tag":"inc","by":1},"evidence":{"delta":"aQpGOnsic3RhdGUiOnsibiI6MVNARiwyOl19MmxfYzg1Ow=="}}';
    const written = await encodeFrame(1, init, first, null);

    const next = await encodeFrame(
      2,
      step({ _tag: "inc", by: 1 }),
      { state: { n: 1, items: ["a", "b"] }, cmds: [] },
      written.basis,
    );

    expect(next.json).toBe(cell);
  });

  it("is a whole frame at the 33rd frame, after 31 deltas, so a chain stays bounded", async () => {
    const cells = await writeChain(
      Array.from({ length: 34 }, (_, at) => ({
        state: stateAt(at),
        cmds: [],
      })),
    );

    const frames = await Promise.all(cells.map((cell) => frameOf(cell.json)));
    expect(frames.map((frame) => frame.evidence.encoding)).toEqual([
      "full",
      ...Array.from({ length: 31 }, () => "delta"),
      "full",
      "delta",
    ]);
    const chains = [...Array(32).keys(), 0, 1];
    expect(cells.map((cell) => cell.basis.chain)).toEqual(chains);
    let basis: Basis | null = null;
    const rebuiltChains: number[] = [];
    for (const [at, frame] of frames.entries()) {
      basis = await rebuilt(at + 1, frame.evidence, basis);
      rebuiltChains.push(basis.chain);
    }
    expect(rebuiltChains).toEqual(chains);
  });

  it.each([
    ["a delta one character shorter than the whole frame is kept", 87, "delta"],
    ["a delta three characters longer than the whole frame is not", 90, "full"],
  ] as const)("%s", async (_name, pad, encoding) => {
    const unpadded = { state: { n: 0, items: stateAt(0).items }, cmds: null };
    const { basis } = await encodeFrame(1, init, unpadded, null);
    const padded = {
      state: { n: 1, items: stateAt(0).items, pad: "q".repeat(pad) },
      cmds: null,
    };

    const next = await encodeFrame(2, step({ _tag: "inc" }), padded, basis);

    expect((await frameOf(next.json)).evidence.encoding).toBe(encoding);
  });

  it("is a whole frame when the basis is not the frame just before it, or the delta is not smaller", async () => {
    const { basis } = await encodeFrame(
      1,
      init,
      { state: stateAt(0), cmds: [] },
      null,
    );
    const next = { state: stateAt(1), cmds: [] };
    const unrelated = { state: { other: "another shape of State" }, cmds: [] };

    const skipped = await encodeFrame(
      3,
      step({ _tag: "inc", by: 1 }),
      next,
      basis,
    );
    const larger = await encodeFrame(
      2,
      step({ _tag: "inc", by: 1 }),
      unrelated,
      basis,
    );

    expect((await frameOf(skipped.json)).evidence.encoding).toBe("full");
    expect((await frameOf(larger.json)).evidence.encoding).toBe("full");
  });
});

describe("a frame that cannot be rebuilt", () => {
  async function deltaFrame() {
    const [first, second] = await writeChain([
      { state: stateAt(0), cmds: [] },
      { state: stateAt(1), cmds: [] },
    ]);
    const frame = await frameOf(second?.json ?? "");
    if (first === undefined || frame.evidence.encoding !== "delta")
      throw new Error("no delta");
    return { basis: first.basis, evidence: frame.evidence };
  }

  it("refuses a delta with no basis, or a basis that is not the frame just before it", async () => {
    const { basis, evidence } = await deltaFrame();

    expect(await rebuildEvidence(2, evidence, null)).toBe("basis");
    expect(await rebuildEvidence(3, evidence, basis)).toBe("basis");
  });

  it("refuses a delta that fails its checksum, and a whole frame that does not inflate", async () => {
    const { basis, evidence } = await deltaFrame();
    const whole = { encoding: "full", state: btoa("not deflated"), cmds: null };

    expect(
      await rebuildEvidence(
        2,
        { ...evidence, delta: btoa("not a delta") },
        basis,
      ),
    ).toBe("checksum");
    expect(await rebuildEvidence(1, whole as StoredEvidence, null)).toBe(
      "checksum",
    );
  });

  /** One byte of a delta's literal text changed: it still parses, and only its checksum is wrong. */
  const altered = (delta: string, literal: string) => {
    const text = atob(delta);
    const at = text.indexOf(literal);
    if (at < 0) throw new Error(`no ${literal} in the delta`);
    return btoa(`${text.slice(0, at)}9${text.slice(at + 1)}`);
  };

  it("refuses a delta that changed one byte of a frame against the frame before it", async () => {
    const { basis, evidence } = await deltaFrame();

    expect(
      await rebuildEvidence(
        2,
        { ...evidence, delta: altered(evidence.delta, '"n":1') },
        basis,
      ),
    ).toBe("checksum");
  });

  it("refuses a whole frame whose Cmds delta changed one byte", async () => {
    const { json } = await encodeFrame(
      1,
      init,
      { state: stateAt(0), cmds: [{ _tag: "go" }] },
      null,
    );
    const { evidence } = await frameOf(json);
    if (evidence.encoding !== "full" || evidence.cmds === null)
      throw new Error("no Cmds");

    expect(
      await rebuildEvidence(
        1,
        { ...evidence, cmds: altered(evidence.cmds, '"go"') },
        null,
      ),
    ).toBe("checksum");
  });
});

describe("a cell that is not a frame", () => {
  const cell = (over: Record<string, unknown>) => ({
    tea: "recording/1",
    frame: "step",
    msg: {},
    evidence: { full: "" },
    ...over,
  });

  it.each([
    ["a bare Msg", { _tag: "inc", by: 1 }],
    ["another format", cell({ tea: "recording/2" })],
    ["no evidence", cell({ evidence: undefined })],
    ["evidence of neither kind", cell({ evidence: {} })],
    ["an init that does not say if it restored", cell({ frame: "init" })],
    ["a step with no Msg", cell({ msg: undefined, frame: "step" })],
    ["a frame of another kind", cell({ frame: "stop" })],
    ["a list", []],
    [
      "whole evidence whose Cmds are not text",
      cell({ evidence: { full: "", cmds: 5 } }),
    ],
    [
      "whole evidence whose Cmds are null",
      cell({ evidence: { full: "", cmds: null } }),
    ],
    ["a delta that is not text", cell({ evidence: { delta: 5 } })],
    [
      "whole evidence beside a delta that is not text",
      cell({ evidence: { full: "", delta: 5 } }),
    ],
    [
      "a delta beside Cmds that are not text",
      cell({ evidence: { delta: "", cmds: 5 } }),
    ],
  ])("is not parsed: %s", (_name, raw) => {
    expect(parseFrame(JSON.parse(JSON.stringify(raw)))).toBeNull();
  });

  it("reads no evidence from bytes that are not an evidence object", () => {
    const text = (value: string) => new TextEncoder().encode(value);

    expect(readEvidence(text("not json"))).toBeNull();
    expect(readEvidence(text('{"cmds":[]}'))).toBeNull();
    expect(readEvidence(text('{"state":1,"cmds":"go"}'))).toBeNull();
  });
});

describe("an init frame at a moved anchor", () => {
  const evidence: FrameEvidence = { state: stateAt(1), cmds: [] };

  it("carries its skipped count through the cell and back", async () => {
    const written = await encodeFrame(
      991,
      { ...init, skipped: 990 },
      evidence,
      null,
    );

    expect(JSON.parse(written.json).skipped).toBe(990);
    expect(await frameOf(written.json)).toMatchObject({
      frame: "init",
      restored: false,
      skipped: 990,
    });
  });

  it("writes no skipped field for a boot, and reads it back as 0", async () => {
    const boot = await encodeFrame(1, init, evidence, null);
    const zero = await encodeFrame(1, { ...init, skipped: 0 }, evidence, null);

    expect(zero.json).toBe(boot.json);
    expect(boot.json).not.toContain("skipped");
    expect(await frameOf(boot.json)).toMatchObject({ skipped: 0 });
  });

  it.each([
    -1,
    1.5,
    "3",
  ])("is not parsed with a skipped count of %s", async (skipped) => {
    const raw = JSON.parse((await encodeFrame(1, init, evidence, null)).json);

    expect(parseFrame({ ...raw, skipped })).toBeNull();
  });
});

describe("the marker in place of an oversized frame", () => {
  it("names the frame, its seq and the bytes measured, and is a recording cell", () => {
    const json = encodeOversized({ of: "step", seq: 7, bytes: 9_000_123 });

    expect(json.startsWith(RECORDING_PREFIX)).toBe(true);
    expect(parseCellMsg(JSON.parse(json))).toEqual({
      frame: "oversized",
      of: "step",
      seq: 7,
      bytes: 9_000_123,
    });
    expect(json.length).toBeLessThan(120);
  });

  it("is not parsed as a frame with evidence", () => {
    const json = encodeOversized({ of: "init", seq: 1, bytes: 10 });

    expect(parseFrame(JSON.parse(json))).toBeNull();
  });

  it.each([
    ["another reason", { reason: "checksum" }],
    ["no frame it replaces", { of: "snapshot" }],
    ["a seq below 1", { seq: 0 }],
    ["a fractional seq", { seq: 1.5 }],
    ["negative bytes", { bytes: -1 }],
    ["bytes that are not a number", { bytes: "10" }],
  ])("is not parsed with %s", (_name, change) => {
    const raw = JSON.parse(encodeOversized({ of: "step", seq: 2, bytes: 10 }));

    expect(parseCellMsg({ ...raw, ...change })).toBeNull();
  });
});
