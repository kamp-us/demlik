/**
 * The Effect side of the agent recipe: one service with one typed failure, and
 * a Layer that provides a deterministic fake.
 *
 * The fake is a pure function of `(step, attempt)` — both of which the reducer
 * carries in the Cmd. A module-level counter would be reset by a restart, and
 * the resumed run would sail through on its first post-restart call, which
 * would make the resume test a lie.
 */

import { Context, Data, Effect, Layer } from "effect";

export class ProviderUnavailable extends Data.TaggedError(
  "ProviderUnavailable",
)<{
  readonly step: number;
  readonly attempt: number;
  readonly reason: string;
}> {}

export interface StepResult {
  readonly output: string;
  readonly costUsd: number;
  /** The action the model wants blessed, or null when it may just proceed. */
  readonly needsApproval: string | null;
}

export interface ProviderApi {
  readonly call: (input: {
    readonly runId: string;
    readonly goal: string;
    readonly step: number;
    readonly attempt: number;
  }) => Effect.Effect<StepResult, ProviderUnavailable>;
}

export class Provider extends Context.Service<Provider, ProviderApi>()(
  "agent-run/Provider",
) {}

/** One scripted step of the fake run. */
export interface ScriptedStep {
  readonly output: string;
  readonly costUsd: number;
  readonly needsApproval?: string | null;
  /** How many attempts are refused before this step goes through. */
  readonly failuresBeforeSuccess?: number;
}

export function ProviderFake(
  script: readonly ScriptedStep[],
): Layer.Layer<Provider> {
  return Layer.succeed(Provider)({
    call: ({ step, attempt }) => {
      const scripted = script[step - 1];
      if (scripted === undefined) {
        return Effect.succeed({
          output: `step ${step}: nothing to do`,
          costUsd: 0,
          needsApproval: null,
        });
      }
      if (attempt <= (scripted.failuresBeforeSuccess ?? 0)) {
        return Effect.fail(
          new ProviderUnavailable({
            step,
            attempt,
            reason: `529 overloaded (attempt ${attempt})`,
          }),
        );
      }
      return Effect.succeed({
        output: scripted.output,
        costUsd: scripted.costUsd,
        needsApproval: scripted.needsApproval ?? null,
      });
    },
  });
}
