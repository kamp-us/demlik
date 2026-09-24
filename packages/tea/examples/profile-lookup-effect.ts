import { run } from "@demlik/tea/effect";
import { Context, Effect } from "effect";
import { profile } from "./profile-lookup";

/** Where names come from, as an Effect service. Provide it with a Layer. */
export class Directory extends Context.Service<
  Directory,
  { readonly nameOf: (id: string) => Effect.Effect<string | undefined> }
>()("Directory") {}

/** Boot the profile machine on the Effect engine. Needs a Scope and a Directory. */
export const runProfile = run(profile, {
  interpret: {
    fetch_user: (cmd) =>
      Effect.gen(function* () {
        const directory = yield* Directory;
        const name = yield* directory.nameOf(cmd.id);
        if (name === undefined) {
          return yield* Effect.fail({ _tag: "not_found" as const });
        }
        return { name };
      }),
  },
});

/** Look one user up and read the state it settles in. Closing the scope stops the run. */
export const lookUp = (id: string) =>
  Effect.gen(function* () {
    const handle = yield* runProfile;
    const runtime = yield* handle.ready;
    yield* runtime.dispatch({ type: "look_up", id });
    return runtime.getState();
  }).pipe(Effect.scoped);
