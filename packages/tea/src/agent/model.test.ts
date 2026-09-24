import { describe, expect, it } from "vitest";
import {
  createLlmCall,
  type LlmCall,
  type LlmRunCmd,
  type Schema,
} from "../internal/llm-call";
import {
  asModelFactory,
  brainHandler,
  isPlainModel,
  type ModelPort,
  PLAIN_MODEL_MISROUTE_REASON,
  plainModel,
} from "./model";

// ---------------------------------------------------------------------------
// The agent's model ports and the brain call's Promise handler. `brainHandler`
// invokes the model and RETURNS the outcome `llm.decode` builds — the engine
// mints the settle Msg from it (ADR 0021).
// ---------------------------------------------------------------------------

type Purpose = "plan" | "report";
interface PlanOut {
  readonly steps: readonly string[];
}
interface ReportOut {
  readonly score: number;
}
interface Outputs extends Record<Purpose, unknown> {
  readonly plan: PlanOut;
  readonly report: ReportOut;
}
type Message = { readonly role: string; readonly text: string };

const schemas = {
  plan: {
    parse: (v: unknown) => {
      const o = v as PlanOut;
      if (!Array.isArray(o?.steps)) throw new Error("plan: steps not an array");
      return o;
    },
  },
  report: {
    parse: (v: unknown) => {
      const o = v as ReportOut;
      if (typeof o?.score !== "number")
        throw new Error("report: score not a number");
      return o;
    },
  },
} as const;

const llm = createLlmCall<Purpose, Outputs>({ schemas });

function fakeModel(invoke: (messages: readonly Message[]) => Promise<unknown>) {
  return () => ({
    withStructuredOutput<T>(_s: Schema<T>) {
      return { invoke: invoke as (m: readonly Message[]) => Promise<T> };
    },
  });
}

function loaderOf(seen: LlmCall<Purpose>[]) {
  return async (call: LlmCall<Purpose>): Promise<readonly Message[]> => {
    seen.push(call);
    return [{ role: "user", text: `${call.purpose}:${String(call.payload)}` }];
  };
}

const cmdOf = (input: LlmCall<Purpose>): LlmRunCmd<Purpose> =>
  ({ type: "resilient_run", key: input.purpose, input }) as LlmRunCmd<Purpose>;

describe("brainHandler — structured-output parse + purpose branch", () => {
  it("assembles messages via the loader, binds the purpose schema, parses the output", async () => {
    const seen: LlmCall<Purpose>[] = [];
    const handle = brainHandler<Purpose, Outputs, Message>(llm, {
      model: fakeModel(async () => ({ steps: ["a", "b"] })),
      loadMessages: loaderOf(seen),
    });
    const call: LlmCall<Purpose> = {
      purpose: "plan",
      model: "gemini",
      payload: "go",
    };
    expect(await handle(cmdOf(call))).toEqual({
      _tag: "Ok",
      value: { key: "plan", purpose: "plan", output: { steps: ["a", "b"] } },
    });
    // The loader saw the full call (so it can branch on purpose, like the seed).
    expect(seen).toEqual([call]);
  });

  it("invokes with [] when no loadMessages port is configured", async () => {
    let sawMessages: readonly Message[] | null = null;
    const handle = brainHandler<Purpose, Outputs, Message>(llm, {
      model: fakeModel(async (messages) => {
        sawMessages = messages;
        return { score: 9 };
      }),
    });
    const out = await handle(
      cmdOf({ purpose: "report", model: null, payload: 1 }),
    );
    expect(out._tag === "Ok" && out.value.output).toEqual({ score: 9 });
    expect(sawMessages).toEqual([]);
  });

  it("a structured-output mismatch is a port_rejected Err, never a corrupt success", async () => {
    const handle = brainHandler<Purpose, Outputs, Message>(llm, {
      model: fakeModel(async () => ({ score: "high" })),
    });
    const out = await handle(
      cmdOf({ purpose: "report", model: null, payload: 0 }),
    );
    expect(out._tag).toBe("Err");
    if (out._tag === "Err") {
      expect(out.error._tag).toBe("port_rejected");
      expect((out.error.cause as Error).message).toBe(
        "report: score not a number",
      );
    }
  });

  it("a model throw is a port_rejected Err carrying the throw (so the loop can back off)", async () => {
    const boom = new Error("provider 503");
    const handle = brainHandler<Purpose, Outputs, Message>(llm, {
      model: fakeModel(async () => {
        throw boom;
      }),
    });
    expect(
      await handle(cmdOf({ purpose: "plan", model: null, payload: 0 })),
    ).toEqual({ _tag: "Err", error: { _tag: "port_rejected", cause: boom } });
  });
});

// ---------------------------------------------------------------------------
// The plain-function model port (#58): `model: async (messages) => answer`
// beside the factory. Same handler, same schema validation, same failure path.
// ---------------------------------------------------------------------------

describe("model ports — plain-function model", () => {
  it("a bare async function receives the loaded messages and its answer is parsed by the purpose schema", async () => {
    const seen: LlmCall<Purpose>[] = [];
    let sawMessages: readonly Message[] | null = null;
    const handle = brainHandler<Purpose, Outputs, Message>(llm, {
      model: async (messages: readonly Message[]) => {
        sawMessages = messages;
        return { steps: ["a"] };
      },
      loadMessages: loaderOf(seen),
    });
    const out = await handle(
      cmdOf({ purpose: "plan", model: null, payload: 1 }),
    );
    expect(out).toEqual({
      _tag: "Ok",
      value: { key: "plan", purpose: "plan", output: { steps: ["a"] } },
    });
    expect(sawMessages).toEqual([{ role: "user", text: "plan:1" }]);
  });

  it("an answer the purpose schema rejects is an Err outcome, not a corrupt success", async () => {
    const handle = brainHandler<Purpose, Outputs, Message>(llm, {
      model: async () => ({ score: "high" }) as unknown as ReportOut,
    });
    const out = await handle(
      cmdOf({ purpose: "report", model: null, payload: 0 }),
    );
    expect(out._tag).toBe("Err");
  });

  it("plainModel lifts a sync promise-returning function that carries no async tag", async () => {
    const answer = (_m: readonly Message[]) => Promise.resolve({ score: 3 });
    expect(isPlainModel<Message, Outputs[Purpose]>(answer)).toBe(false);
    const handle = brainHandler<Purpose, Outputs, Message>(llm, {
      model: plainModel(answer),
    });
    const out = await handle(
      cmdOf({ purpose: "report", model: null, payload: 0 }),
    );
    expect(out._tag === "Ok" && out.value.output).toEqual({ score: 3 });
  });

  it("a sync promise-returning function passed bare fails with the LlmErr reason naming plainModel, not a withStructuredOutput TypeError", async () => {
    let calledWith: unknown = "never";
    const bare = (m: unknown) => {
      calledWith = m;
      return Promise.resolve({ score: 3 });
    };
    const handle = brainHandler<Purpose, Outputs, Message>(llm, {
      model: bare as ModelPort<Message, Outputs[Purpose]>,
    });
    const input: LlmCall<Purpose> = {
      purpose: "report",
      model: "gpt",
      payload: 0,
    };
    const out = await handle(cmdOf(input));
    expect(out._tag).toBe("Err");
    if (out._tag === "Err") {
      const err = llm.errOf({
        type: "resilient_run_err",
        cmd: cmdOf(input),
        error: out.error,
        at: 0,
      });
      expect(err.reason).toBe(PLAIN_MODEL_MISROUTE_REASON);
      expect(err.reason).toContain("plainModel(fn)");
    }
    // The misroute is what the reason describes: the function was called as a
    // factory, with the modelId where its messages would be.
    expect(calledWith).toBe("gpt");
  });

  it("isPlainModel tells a bare async function from a factory", () => {
    expect(isPlainModel<Message, unknown>(async () => ({}))).toBe(true);
    expect(isPlainModel<Message, unknown>(fakeModel(async () => ({})))).toBe(
      false,
    );
  });

  it("asModelFactory refuses a thenable Llm with the misroute reason", () => {
    const factory = asModelFactory<Message, unknown>(((_id: string | null) =>
      Promise.resolve({})) as never);
    expect(() => factory(null)).toThrow(PLAIN_MODEL_MISROUTE_REASON);
  });

  it("the structured-output factory path binds the purpose schema", async () => {
    let bound: Schema<unknown> | null = null;
    const handle = brainHandler<Purpose, Outputs, Message>(llm, {
      model: () => ({
        withStructuredOutput<T>(s: Schema<T>) {
          bound = s as Schema<unknown>;
          return { invoke: async () => ({ steps: [] }) as unknown as T };
        },
      }),
    });
    const out = await handle(
      cmdOf({ purpose: "plan", model: null, payload: 0 }),
    );
    expect(out._tag === "Ok" && out.value.output).toEqual({ steps: [] });
    expect(bound).toBe(schemas.plan);
  });
});
