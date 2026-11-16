import { Effect, Exit } from "effect";
import { expect, test } from "vitest";
import { deliveryIdOf } from "../index";
import {
  type Msg,
  machine,
  options,
  type State,
  type Upload,
} from "../internal/persistence/durable-host.fixture";
import { memoryEventSourcedStore } from "../mem";
import type { LoggedStore } from "../runtime-types";
import { StoreRefusedError } from "../runtime-types";
import { run, StoreFailed } from "./index";

function failure<A, E>(exit: Exit.Exit<A, E>): E {
  if (!Exit.isFailure(exit)) throw new Error("Expected typed failure");
  const reasons = exit.cause.reasons;
  const first = reasons[0];
  if (first?._tag !== "Fail") throw new Error("Expected failure, not defect");
  return first.error;
}

test("Effect dispatchOnce preserves caller IDs and the handler receives its invocation delivery ID", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const disk = new Map<string, string>();
        const store = memoryEventSourcedStore(disk, options);
        const ids: (number | undefined)[] = [];
        const booting = yield* run(machine(), {
          store,
          interpret: {
            upload: (_, ctx) =>
              Effect.sync(() => {
                ids.push(deliveryIdOf(ctx));
              }),
          },
        });
        const live = yield* booting.ready;
        yield* live.dispatchOnce(
          { _tag: "picked", file: "one" },
          { id: "pick" },
        );
        yield* live.idle();
        yield* live.dispatchOnce(
          { _tag: "picked", file: "duplicate" },
          { id: "pick" },
        );
        expect(live.getState().files).toEqual(["one"]);
        expect(ids).toEqual([1]);
        expect(
          (yield* Effect.promise(() => store.readLog())).records.filter(
            ({ record }) => record._tag === "message",
          ),
        ).toHaveLength(1);
        yield* live.stop();
      }),
    ),
  );
});

test("Effect logged read and write failures keep their operation and cause, and only failed writes poison", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const inner = memoryEventSourcedStore(
          new Map<string, string>(),
          options,
        );
        const readCause = new Error("read");
        const unreadable: LoggedStore<State, Msg, Upload> = {
          ...inner,
          readLog: async () => {
            throw readCause;
          },
        };
        const refused = yield* run(machine(), {
          store: unreadable,
          onError: () => {},
          interpret: { upload: () => Effect.void },
        });
        const readFailure = failure(yield* Effect.exit(refused.ready));
        expect(readFailure).toBeInstanceOf(StoreFailed);
        expect(readFailure.operation).toBe("load");
        expect(readFailure.cause).toBeInstanceOf(StoreRefusedError);
        expect((readFailure.cause as StoreRefusedError).cause).toBe(readCause);
        const writeCause = new Error("write");
        let fail = false;
        const store: LoggedStore<State, Msg, Upload> = {
          ...inner,
          commitStep: async (step) => {
            if (fail) throw writeCause;
            return inner.commitStep(step);
          },
        };
        let handled = 0;
        const booting = yield* run(machine(), {
          store,
          onError: () => {},
          interpret: {
            upload: () =>
              Effect.sync(() => {
                handled += 1;
              }),
          },
        });
        const live = yield* booting.ready;
        yield* live.dispatch({ _tag: "picked", file: "one" });
        fail = true;
        const writeFailure = failure(
          yield* Effect.exit(
            live.dispatch({ _tag: "picked", file: "unsaved" }),
          ),
        );
        expect(writeFailure).toBeInstanceOf(StoreFailed);
        expect(writeFailure).toMatchObject({
          operation: "save",
          cause: writeCause,
        });
        fail = false;
        const poisoned = failure(
          yield* Effect.exit(live.dispatch({ _tag: "picked", file: "after" })),
        );
        expect(poisoned).toMatchObject({
          operation: "save",
          cause: writeCause,
        });
        expect(handled).toBe(1);
        expect(live.getState().files).toEqual(["one"]);
        yield* live.stop();
      }),
    ),
  );
});
