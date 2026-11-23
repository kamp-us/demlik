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
  type FrameEvidence,
  type FrameHead,
  FULL_FRAME_EVERY,
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

  it("is a whole frame again after FULL_FRAME_EVERY frames, so a chain stays bounded", async () => {
    const cells = await writeChain(
      Array.from({ length: FULL_FRAME_EVERY + 1 }, (_, at) => ({
        state: stateAt(at),
        cmds: [],
      })),
    );

    const chains = cells.map((cell) => cell.basis.chain);
    expect(chains.slice(0, FULL_FRAME_EVERY)).toEqual(
      Array.from({ length: FULL_FRAME_EVERY }, (_, at) => at),
    );
    expect(chains[FULL_FRAME_EVERY]).toBe(0);
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
