/**
 * Cmd handlers authored as Effect programs, lowered into tea's `Interpret` by
 * `toInterpret`.
 *
 * The typed `ProviderUnavailable` is discharged INSIDE the effect: `catchTag`
 * folds it into a `step_failed` Msg the reducer already knows how to retry.
 * `E = never` is the bridge's load-bearing rule — and it is also the right
 * model, because an overloaded provider is not an exception, it is a
 * transition.
 */

import { Effect } from "effect";
import type { EffectRunner } from "../../../src/effect/index";
import { teaServices, toInterpret } from "../../../src/effect/index";
import type { Interpret } from "../../../src/index";
import type { Cmd, Ctx, Msg } from "./machine";
import { Provider } from "./services";

export const services = teaServices<Msg, Ctx>("agent-run");

export type AgentR = Provider;

/** The clock is read at the effect boundary and travels in the Msg. */
const now = (): number => Date.now();

export function agentInterpret(
  runtime: EffectRunner<AgentR>,
): Interpret<Msg, Cmd, Ctx> {
  return toInterpret<Msg, Cmd, Ctx, AgentR>(
    {
      call_provider: (cmd) =>
        Effect.gen(function* () {
          const provider = yield* Provider;
          const result = yield* provider.call({
            runId: cmd.runId,
            goal: cmd.goal,
            step: cmd.step,
            attempt: cmd.attempt,
          });
          return {
            type: "step_ok",
            output: result.output,
            costUsd: result.costUsd,
            needsApproval: result.needsApproval,
            at: now(),
          } as const;
        }).pipe(
          Effect.catchTag("ProviderUnavailable", (error) =>
            Effect.succeed({
              type: "step_failed",
              reason: error.reason,
              at: now(),
            } as const),
          ),
        ),
    },
    { runtime, services },
  );
}
