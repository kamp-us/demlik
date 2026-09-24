/**
 * The two engine how-tos' compile-and-run gate (#284).
 *
 * `docs/how-to/run-on-the-promise-engine.md` and
 * `docs/how-to/run-on-the-effect-engine.md` claim one machine file runs on
 * both engines unchanged. That file is `examples/profile-lookup.ts`, and each
 * engine's run code is its own example beside it. `pnpm typecheck:consumers`
 * compiles all three against the published specifiers; this file drives both
 * engines through them to the same State, and asserts each page shows the
 * files verbatim — so the pages cannot drift from what runs.
 *
 * It lives under `src/effect/` beside the conformance suite because it imports
 * `effect`, which only this entry may do.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { profile } from "../../examples/profile-lookup";
import {
  Directory,
  lookUp as lookUpOnEffect,
} from "../../examples/profile-lookup-effect";
import { lookUp as lookUpOnPromise } from "../../examples/profile-lookup-promise";
import { run as runPromise } from "../promise";
import { run as runEffect } from "./index";

const names: Readonly<Record<string, string>> = { u1: "Ada" };

function onPromise(id: string) {
  return lookUpOnPromise({ nameOf: async (key) => names[key] }, id);
}

function onEffect(id: string) {
  const directory = Layer.succeed(Directory, {
    nameOf: (key) => Effect.succeed(names[key]),
  });
  return Effect.runPromise(lookUpOnEffect(id).pipe(Effect.provide(directory)));
}

describe("one machine file, both engines — it runs", () => {
  it("a known id settles `loaded` on both engines", async () => {
    const promise = await onPromise("u1");
    expect(promise).toEqual({ status: "loaded", name: "Ada" });
    expect(await onEffect("u1")).toEqual(promise);
  });

  it("an unknown id settles `missing` through the declared err on both engines", async () => {
    const promise = await onPromise("u2");
    expect(promise).toEqual({ status: "missing", name: null });
    expect(await onEffect("u2")).toEqual(promise);
  });

  it("a miss arms the built-in timer, and nothing else does", () => {
    const [timer] = profile.subs ?? [];
    expect(timer?.type).toBe("timer");
    expect(timer?.deps({ status: "missing", name: null })).toEqual({
      ms: 2_000,
      msg: { type: "clear" },
    });
    expect(timer?.deps({ status: "loaded", name: "Ada" })).toBeNull();
  });
});

describe("a `timer` entry in `subscribe` replaces the built-in — both pages' step 3", () => {
  it("on the Promise engine, a miss clears at once", async () => {
    const runtime = await runPromise(profile, {
      interpret: {
        fetch_user: async (_cmd, { err }) => err({ _tag: "not_found" }),
      },
      subscribe: {
        timer: (sub, _ctx, dispatch) => {
          dispatch(sub.deps.msg);
          return () => {};
        },
      },
    }).ready;
    try {
      await runtime.dispatch({ type: "look_up", id: "u2" });
      await vi.waitFor(() => expect(runtime.getState().status).toBe("idle"));
    } finally {
      await runtime.stop();
    }
  });

  it("on the Effect engine, a miss clears at once", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* runEffect(profile, {
          interpret: {
            fetch_user: () => Effect.fail({ _tag: "not_found" as const }),
          },
          subscribe: { timer: (sub) => Stream.make(sub.deps.msg) },
        });
        const runtime = yield* handle.ready;
        yield* runtime.dispatch({ type: "look_up", id: "u2" });
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(runtime.getState().status).toBe("idle")),
        );
        return runtime.getState().status;
      }).pipe(Effect.scoped),
    );
    expect(status).toBe("idle");
  });
});

const read = (path: string) =>
  readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/** Every fenced ```ts block on a page, in page order. */
async function tsBlocks(page: string): Promise<string[]> {
  const markdown = await read(`../../docs/how-to/${page}`);
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) =>
    (m[1] ?? "").trimEnd(),
  );
}

const example = async (file: string) =>
  (await read(`../../examples/${file}`)).trimEnd();

describe("the engine how-tos — they cannot rot", () => {
  it.each([
    ["run-on-the-promise-engine.md", "profile-lookup-promise.ts"],
    ["run-on-the-effect-engine.md", "profile-lookup-effect.ts"],
  ])("%s shows the shared machine file and %s verbatim", async (page, runner) => {
    const blocks = await tsBlocks(page);
    expect(blocks).toContain(await example("profile-lookup.ts"));
    expect(blocks).toContain(await example(runner));
  });
});
