/**
 * `Cmd.define` takes any Standard Schema (ADR 0021 §5): zod passes straight
 * in, and Effect Schema passes through `Schema.toStandardSchemaV1`. Both are
 * exercised here on one machine shape — the type half with `expectTypeOf`
 * (compiled by `pnpm typecheck:test`), the runtime half through `run`.
 *
 * This file lives under `src/effect/` because it imports `effect`, and only
 * this entry point may (`src/entry-points.import-graph.test.ts`).
 */

import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { Cmd, defineMachine, type OkOf, type Settled } from "../index";
import { run } from "../promise";

const viaZod = Cmd.define("load_zod", {
  input: z.object({ id: z.string() }),
  ok: z.object({ name: z.string() }),
  err: ["not_found"],
});

const viaEffect = Cmd.define("load_effect", {
  input: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })),
  ok: Schema.toStandardSchemaV1(Schema.Struct({ name: Schema.String })),
  err: ["not_found"],
});

describe("Cmd.define infers its channels from any Standard Schema (types)", () => {
  it("zod: the input and Ok types are the schemas' outputs", () => {
    expectTypeOf(viaZod).parameter(0).toEqualTypeOf<{ id: string }>();
    expectTypeOf<OkOf<typeof viaZod>>().toEqualTypeOf<{ name: string }>();
  });

  it("Effect Schema: the input and Ok types are the schemas' decoded types", () => {
    expectTypeOf(viaEffect)
      .parameter(0)
      .toEqualTypeOf<{ readonly id: string }>();
    expectTypeOf<OkOf<typeof viaEffect>>().toEqualTypeOf<{
      readonly name: string;
    }>();
  });

  it("the settled `_ok` Msg carries the schema's type as `value`", () => {
    type EffectOk = Extract<
      Settled<typeof viaEffect>,
      { type: "load_effect_ok" }
    >;
    expectTypeOf<EffectOk["value"]>().toEqualTypeOf<{
      readonly name: string;
    }>();
  });
});

describe("Cmd.define parses `Ok` through any Standard Schema (runtime)", () => {
  type Model = {
    readonly zod: string | null;
    readonly effect: string | null;
    readonly malformed: readonly string[];
  };

  const machine = (answer: (id: string) => unknown) =>
    defineMachine({
      types: {
        model: {} as Model,
        msg: {} as { readonly type: "go"; readonly id: string },
      },
      cmds: [viaZod, viaEffect],
      init: () => [{ zod: null, effect: null, malformed: [] }, []],
      update: {
        go: (m, msg) => [
          m,
          [viaZod({ id: msg.id }), viaEffect({ id: msg.id })],
        ],
        load_zod_ok: (m, msg) => [{ ...m, zod: msg.value.name }, []],
        load_zod_err: (m, msg) => [
          { ...m, malformed: [...m.malformed, `zod:${msg.error._tag}`] },
          [],
        ],
        load_effect_ok: (m, msg) => [{ ...m, effect: msg.value.name }, []],
        load_effect_err: (m, msg) => [
          { ...m, malformed: [...m.malformed, `effect:${msg.error._tag}`] },
          [],
        ],
      },
      interpret: {
        load_zod: async (cmd, { ok }) => ok(answer(cmd.id) as { name: string }),
        load_effect: async (cmd, { ok }) =>
          ok(answer(cmd.id) as { readonly name: string }),
      },
    });

  it("a value both schemas accept lands on both `_ok` cells", async () => {
    const rt = await run(
      machine((id) => ({ name: `user ${id}` })),
      {},
    ).ready;
    await rt.dispatch({ type: "go", id: "7" });
    expect(rt.getState()).toEqual({
      zod: "user 7",
      effect: "user 7",
      malformed: [],
    });
  });

  it("a value both schemas reject becomes `malformed_result` on both `_err` cells", async () => {
    const rt = await run(
      machine(() => ({ name: 42 })),
      {},
    ).ready;
    await rt.dispatch({ type: "go", id: "7" });
    expect(rt.getState()).toEqual({
      zod: null,
      effect: null,
      malformed: ["zod:malformed_result", "effect:malformed_result"],
    });
  });
});
