import { expect, test } from "vitest";
import { z } from "zod";
import { defineMachine, deliveryIdOf } from "../../index";
import { memoryEventSourcedStore } from "../../mem";
import { run } from "../../promise";

const state = z.object({ files: z.array(z.string()) });
const message = z.object({ _tag: z.literal("picked"), file: z.string() });
const command = z.object({ _tag: z.literal("upload"), file: z.string() });
const options = { state, message, command };
const uploader = () => defineMachine({
  types: { model: {} as z.infer<typeof state>, msg: {} as z.infer<typeof message>, cmd: {} as z.infer<typeof command> },
  init: (loaded) => [loaded ?? { files: [] }, []],
  update: { picked: (s, m) => [{ files: [...s.files, m.file] }, [{ _tag: "upload", file: m.file }]] },
});

test("T1: picked is durable before upload starts and a crash there preserves State and redelivers", async () => {
  const disk = new Map<string, string>();
  let atWork = new Map<string, string>();
  let firstId: number | undefined;
  const rt = await run(uploader(), { store: memoryEventSourcedStore(disk, options), interpret: {
    upload: async (_, ctx) => { atWork = new Map(disk); firstId = deliveryIdOf(ctx); },
  } }).ready;
  await rt.dispatch({ _tag: "picked", file: "a.png" });
  const recoveredStore = memoryEventSourcedStore(new Map(atWork), options);
  const messages = (await recoveredStore.readLog()).records.filter(({ record }) => record._tag === "message");
  expect(messages).toHaveLength(1);
  expect(messages[0]?.record).toMatchObject({ msg: { _tag: "picked", file: "a.png" } });
  const handouts: (number | undefined)[] = [];
  const rt2 = await run(uploader(), { store: recoveredStore, interpret: { upload: async (_, ctx) => { handouts.push(deliveryIdOf(ctx)); } } }).ready;
  expect(rt2.getState().files).toEqual(["a.png"]);
  expect(handouts).toEqual([firstId]);
  await rt2.idle();
  await rt2.stop();
  await rt.stop();
});
