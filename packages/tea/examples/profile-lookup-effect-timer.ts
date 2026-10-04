import { run } from "@demlik/tea/effect";
import { Effect, Stream } from "effect";
import { profile } from "./profile-lookup";

/** The profile machine with every lookup a miss, and a `timer` that fires at once. */
export const runProfileInTest = run(profile, {
  interpret: {
    fetch_user: () => Effect.fail({ _tag: "not_found" as const }),
  },
  subscribe: { timer: (sub) => Stream.make(sub.deps.msg) },
});
