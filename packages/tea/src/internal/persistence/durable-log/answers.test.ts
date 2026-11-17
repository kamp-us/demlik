import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deepFreeze } from "../../../pure/core";
import type { LogMessage } from "../../../runtime-types";
import { durableLog, storageOf, storedLog } from "../durable-store.fixture";
import { decodeFrame, encodeFrame } from "./codec";
import legacy from "./fixtures/protocol-2.json";
import { logLedger, messageId, pendingMessages } from "./format";
import { decide, decideAnswer } from "./operations";
import { emptyProjection, fold } from "./projection";

const options = {
  state: z.object({ n: z.number() }),
  message: z.object({ _tag: z.literal("go"), n: z.number() }),
  command: z.object({ _tag: z.literal("work"), n: z.number() }),
};
type Msg = z.infer<typeof options.message>;
const delivery = { id: 1, effect: { _tag: "work" as const, n: 3 } };
const answer: LogMessage<Msg> = {
  _tag: "message",
  id: messageId("answer", 1, 0),
  at: 2,
  msg: { _tag: "go", n: 7 },
  answerTo: 1,
};
const ordinary: LogMessage<Msg> = {
  _tag: "message",
  id: answer.id,
  at: 1,
  msg: { _tag: "go", n: 5 },
};

describe("answer log rules and protocol", () => {
  it.each([
    ["owed", [delivery], 1, null, { _tag: "owed", delivery }],
    ["repeat", [], 1, answer, { _tag: "repeat" }],
    [
      "unknown",
      [delivery],
      2,
      null,
      { _tag: "refused", refusal: { _tag: "unknown_answer" } },
    ],
    [
      "F2 ordinary reply still owed",
      [delivery],
      1,
      ordinary,
      { _tag: "confirm", id: 1 },
    ],
    [
      "F2 ordinary reply already confirmed",
      [],
      1,
      ordinary,
      { _tag: "repeat" },
    ],
    ["F2 atomic reply", [delivery], 1, answer, { _tag: "repeat" }],
  ] as const)("pure correlation: %s", (_name, owed, id, admitted, expected) => {
    deepFreeze(owed);
    expect(decideAnswer(owed, id, admitted)).toEqual(expected);
    expect(decideAnswer(owed, id, admitted)).toEqual(expected);
  });

  it("F2: append confirms an ordinary canonical reply with one existing record", async () => {
    const disk = storageOf(legacy);
    const live = durableLog(disk, options);
    await live.store.appendMessage(ordinary);
    await live.store.commitStep({
      _tag: "applied",
      sourceId: ordinary.id,
      state: { n: 5 },
      cmds: [],
      timers: [],
    });
    const before = storedLog(disk).frames.length;
    const result = await live.store.appendMessage(answer);
    expect(storedLog(disk).frames).toHaveLength(before + 1);
    expect(JSON.parse(storedLog(disk).frames.at(-1) ?? "null").record).toEqual({
      _tag: "confirmed",
      event: { _tag: "effect_confirmed", id: 1 },
    });
    expect(result.appended).toBe(false);
    expect(result.entry.record).toEqual(ordinary);
    expect(result.version).toBe(live.inspect().projection.version);
    expect(live.inspect().projection.state).toEqual({ n: 5 });
    expect(live.inspect().projection.owed).toEqual([]);
    expect(live.inspect().projection).toEqual(
      durableLog(storageOf(storedLog(disk)), options).inspect().projection,
    );
    const confirmed = storedLog(disk).frames.length;
    await live.store.appendMessage(answer);
    expect(storedLog(disk).frames).toHaveLength(confirmed);
  });

  it("the append row produces one answer record or no writes, with the same owner refusing unknown ids", async () => {
    const disk = storageOf(legacy);
    const live = durableLog(disk, options);
    await live.store.readLog();
    const before = deepFreeze(live.inspect().projection);
    const op = deepFreeze({
      _tag: "append_message" as const,
      message: answer,
      stored: null,
    });
    expect(decide(before, op, { snapshotEvery: 1 })).toEqual([
      before,
      [{ _tag: "append_record", record: answer, checkpointThrough: null }],
    ]);
    expect(
      decide(
        before,
        { ...op, message: { ...answer, answerTo: 2 } },
        { snapshotEvery: 1 },
      ),
    ).toEqual({ _tag: "unknown_answer" });
    const size = storedLog(disk).frames.length;
    await expect(
      live.store.appendMessage({ ...answer, answerTo: 2 }),
    ).rejects.toThrow("Answer id is not owed");
    expect(storedLog(disk).frames).toHaveLength(size);
    const first = await live.store.appendMessage(answer);
    expect(first.appended).toBe(true);
    expect(storedLog(disk).frames).toHaveLength(size + 1);
    expect(live.inspect().projection.owed).toEqual([]);
    expect(pendingMessages(await live.store.readLog())).toEqual([answer]);
    expect(logLedger(await live.store.readLog()).surviving()).toEqual([]);
    const duplicate = await live.store.appendMessage({
      ...answer,
      msg: { _tag: "go", n: 99 },
    });
    expect(duplicate.appended).toBe(false);
    expect(duplicate.entry).toEqual(first.entry);
    expect(storedLog(disk).frames).toHaveLength(size + 1);
    expect(live.inspect().projection).toEqual(
      durableLog(storageOf(storedLog(disk)), options).inspect().projection,
    );
  });

  it("the message fold refuses an impossible receipt and leaves its input untouched", () => {
    const p = deepFreeze({
      ...emptyProjection<
        z.infer<typeof options.state>,
        Msg,
        typeof delivery.effect
      >(),
      version: 1,
      birth: true,
    });
    expect(
      fold(
        p,
        [
          {
            row: { seq: 2, record: answer },
            storedState: undefined,
            stored: null,
            snapshot: null,
          },
        ],
        { decodeCheckpointState: () => ({ _tag: "state_rejected" }) },
      ),
    ).toEqual({ _tag: "invalid_delivery_receipt" });
    expect(p.pending).toEqual([]);
    expect(p.owed).toEqual([]);
  });

  it("reads actual protocol-2 frames encoded at d87f2d8f unchanged", async () => {
    const disk = storageOf(legacy);
    const live = durableLog(disk, options);
    expect(await live.store.load()).toEqual({ n: 3 });
    expect(logLedger(await live.store.readLog()).surviving()).toEqual([
      delivery,
    ]);
    expect(storedLog(disk).frames).toEqual(legacy.frames);
    for (const bytes of legacy.frames) {
      const frame = decodeFrame(bytes, options);
      expect(frame._tag).toBe("ok");
      if (frame._tag !== "ok") throw new Error("legacy frame refused");
      expect(frame.value.row.record).toEqual(JSON.parse(bytes).record);
      expect(
        encodeFrame(frame.value.row.record, frame.value.row.seq, null, options),
      ).toMatchObject({ _tag: "ok", value: { bytes } });
    }
  });

  it.each([
    null,
    5,
    "ignored",
    false,
    { id: 5 },
    [5],
  ])("F3: protocol 2 ignores extra answerTo %j and leaves delivery 5 owed", async (answerTo) => {
    const oldFrames = legacy.frames.map((bytes) => {
      const frame = JSON.parse(bytes);
      if (frame.record._tag === "applied") frame.record.owed[0].id = 5;
      return JSON.stringify(frame);
    });
    const record = {
      _tag: "message" as const,
      id: "old-extra",
      at: 2,
      msg: { _tag: "go" as const, n: 7 },
    };
    const bytes = JSON.stringify({
      protocol: 2,
      seq: 4,
      record: { ...record, answerTo },
      snapshot: null,
    });
    const decoded = decodeFrame(bytes, options);
    expect(decoded).toMatchObject({ _tag: "ok", value: { row: { record } } });
    if (decoded._tag !== "ok") throw new Error("old frame refused");
    expect(Object.hasOwn(decoded.value.row.record, "answerTo")).toBe(false);
    const before = durableLog(storageOf({ frames: oldFrames }), options);
    const after = durableLog(
      storageOf({ frames: [...oldFrames, bytes] }),
      options,
    );
    expect(logLedger(await before.store.readLog()).surviving()).toEqual([
      { id: 5, effect: delivery.effect },
    ]);
    expect(logLedger(await after.store.readLog()).surviving()).toEqual(
      logLedger(await before.store.readLog()).surviving(),
    );
    expect(after.inspect().projection.owed).toEqual(
      before.inspect().projection.owed,
    );
    expect(pendingMessages(await after.store.readLog())).toEqual([record]);
    expect(await after.store.load()).toEqual(await before.store.load());
  });

  it.each([
    {},
    { answerTo: null },
    { answerTo: 0 },
    { answerTo: 1.5 },
    { answerTo: Number.MAX_SAFE_INTEGER + 1 },
  ])("F3: protocol 3 requires a valid receipt %j", (metadata) => {
    const record = {
      _tag: "message",
      id: "new-answer",
      at: 2,
      msg: answer.msg,
      ...metadata,
    };
    expect(
      decodeFrame(
        JSON.stringify({ protocol: 3, seq: 4, record, snapshot: null }),
        options,
      ),
    ).toEqual({ _tag: "invalid_integer" });
  });

  it("F3: protocol 3 refuses records that cannot carry a message receipt", () => {
    const birth = JSON.parse(legacy.frames[0] ?? "null");
    expect(
      decodeFrame(JSON.stringify({ ...birth, protocol: 3 }), options)._tag,
    ).not.toBe("ok");
  });

  it("writes protocol 3 only for answer metadata, and reads both protocols", () => {
    const ordinary = {
      _tag: "message" as const,
      id: "ordinary",
      at: 1,
      msg: answer.msg,
    };
    for (const [record, protocol] of [
      [ordinary, 2],
      [answer, 3],
    ] as const) {
      const encoded = encodeFrame(record, 4, null, options);
      if (encoded._tag !== "ok") throw new Error("frame rejected");
      expect(JSON.parse(encoded.value.bytes).protocol).toBe(protocol);
      expect(decodeFrame(encoded.value.bytes, options)).toMatchObject({
        _tag: "ok",
        value: { row: { record } },
      });
    }
    expect(
      decodeFrame(
        JSON.stringify({ protocol: 4, seq: 4, record: answer }),
        options,
      ),
    ).toEqual({ _tag: "unsupported_log_protocol" });
    expect(
      decodeFrame(
        JSON.stringify({ protocol: "2", seq: 4, record: ordinary }),
        options,
      ),
    ).toEqual({ _tag: "unsupported_log_protocol" });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    null,
  ])("refuses malformed answerTo %s at the codec boundary", (answerTo) => {
    const bytes = JSON.stringify({
      protocol: 3,
      seq: 4,
      record: { ...answer, answerTo },
      snapshot: null,
    });
    expect(decodeFrame(bytes, options)).toEqual({ _tag: "invalid_integer" });
  });

  it("ordinary append does not clear a delivery, and confirmEffect keeps its first/repeat contract", async () => {
    const live = durableLog(storageOf(legacy), options);
    await live.store.appendMessage({
      _tag: "message",
      id: "1",
      at: 2,
      msg: answer.msg,
    });
    expect(logLedger(await live.store.readLog()).surviving()).toEqual([
      delivery,
    ]);
    expect((await live.store.confirmEffect(1)).confirmed).toBe(true);
    expect((await live.store.confirmEffect(1)).confirmed).toBe(false);
    expect(logLedger(await live.store.readLog()).surviving()).toEqual([]);
  });
});
