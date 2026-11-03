import { Effect, Exit, Scope } from "effect";

/** Runs React tests' Effect-engine handles in an owned scope. */
export async function reactTestScope() {
  const scope = await Effect.runPromise(Scope.make());
  return {
    run: <A, E>(task: Effect.Effect<A, E, Scope.Scope>) =>
      Effect.runPromise(task.pipe(Scope.provide(scope))),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}
