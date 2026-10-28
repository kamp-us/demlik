import { Effect } from "effect";
import type { EffectInterpretCell } from "../../packages/tea/src/effect/index.ts";
import { createJevAsk } from "../../packages/tea/src/internal/jev/ask/index.ts";

const ask = createJevAsk({
  questions: { invoice: { type: "noul", instructions: "Approved?" } },
});
type Command = ReturnType<typeof ask.run>;
type HostMessage = { type: "reviewed" };
const effectHandler: EffectInterpretCell<HostMessage, Command, never> = (
  cmd,
) => {
  const outcome = ask.decode(cmd.input, { status: 429, body: null });
  return outcome._tag === "Ok"
    ? Effect.succeed(outcome.value)
    : Effect.fail(outcome.error);
};
// Returning Effect<Outcome> bypasses the intended Effect success/error channel.
const wrongHandler: EffectInterpretCell<HostMessage, Command, never> = (cmd) =>
  // @ts-expect-error the defined command success is JevOk, not Outcome<JevOk,E>
  Effect.sync(() => ask.decode(cmd.input, { status: 429, body: null }));
void [effectHandler, wrongHandler];
