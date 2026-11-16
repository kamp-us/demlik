import { expect, test } from "vitest";
import { z } from "zod";
import {
  Cmd,
  defineMachine,
  deliveryIdOf,
  type LoggedStore,
  type Settled,
} from "../../index";
import { memoryEventSourcedStore } from "../../mem";
import { run } from "../../promise";
import { detachWorkOf, OutcomeContractError } from "../../pure/core";
import {
  type Driver,
  execute,
  type Msg,
  machine,
  type State,
  type Upload,
} from "./durable-host.fixture";

test("detached invalid own-outcome callback stays owed without an admitted answer", async () => {
  const upload = Cmd.define("upload", {
    input: z.object({ file: z.string() }),
    ok: z.number(),
    err: [],
  });
  type M = Settled<typeof upload>;
  const program = defineMachine({
    types: { model: {} as { n: number }, msg: {} as M },
    cmds: [upload],
    init: () => [{ n: 0 }, [upload({ file: "one" })]],
    update: {
      upload_ok: (s) => [{ n: s.n + 1 }, []],
      upload_err: (s) => [s, []],
    },
  });
  const disk = new Map<string, string>();
  const options = {
    state: z.object({ n: z.number() }),
    message: {
      safeParse: (raw: unknown) => ({ success: true as const, data: raw as M }),
    },
    command: z.object({ _tag: z.literal("upload"), file: z.string() }),
  };
  const store = memoryEventSourcedStore(disk, options);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const errors: unknown[] = [];
  const live = await run(program, {
    store,
    onError: (error) => {
      errors.push(error);
    },
    interpret: {
      upload: async (cmd, ctx, dispatch) => {
        detachWorkOf(ctx)(blocked.then(() => dispatch?.(upload.ok(cmd, 1))));
      },
    },
  }).ready;
  release();
  await live.idle();
  expect(errors.some((error) => error instanceof OutcomeContractError)).toBe(
    true,
  );
  const records = (await store.readLog()).records;
  expect(
    records.filter(({ record }) => record._tag === "message"),
  ).toHaveLength(0);
  expect(
    records.filter(({ record }) => record._tag === "confirmed"),
  ).toHaveLength(0);
  let retried: number | undefined;
  const lost = new Error("drop activation");
  const wake = await run(program, {
    store: memoryEventSourcedStore(new Map(disk), options),
    onError: () => {},
    interpret: {
      upload: async (_, ctx) => {
        retried = deliveryIdOf(ctx);
        throw lost;
      },
    },
  }).ready;
  expect(retried).toBe(1);
  await wake.stop();
  await live.stop();
});

const droppingAnswers: Driver = async (store, upload) =>
  run(machine(), {
    store,
    onError: () => {},
    interpret: {
      upload: async (cmd) => {
        await upload(cmd);
      },
    },
  }).ready;

test("crash harness rejects a driver dropping every answer", async () => {
  await expect(execute(droppingAnswers, undefined, 3)).rejects.toThrow();
});

test("crash harness rejects a driver dropping a committed completion step", async () => {
  const droppingStep: Driver = async (store, upload) => {
    let durable: State = { files: [], uploaded: [] };
    const dropping: LoggedStore<State, Msg, Upload> = {
      ...store,
      commitStep: async (step) => {
        const dropped =
          step._tag === "message" &&
          step.state.uploaded.length > durable.uploaded.length;
        const accepted = dropped
          ? { ...step, state: durable, disposition: "ignored" as const }
          : step;
        const result = await store.commitStep(accepted);
        durable = accepted.state;
        return result;
      },
    };
    const live = await run(machine(), {
      store: dropping,
      onError: () => {},
      interpret: { upload },
    }).ready;
    return {
      dispatch: (msg, opts) => live.dispatch(msg, opts),
      stop: () => live.stop(),
      getState: () => durable,
    };
  };
  await expect(execute(droppingStep, undefined, 3)).rejects.toThrow();
});
