import { Effect, Layer } from "effect";
import { Directory, lookUp } from "./profile-lookup-effect";

export const DirectoryLive = Layer.succeed(Directory, {
  nameOf: (id) => Effect.succeed(id === "u1" ? "Ada" : undefined),
});

export const state = await Effect.runPromise(
  lookUp("u1").pipe(Effect.provide(DirectoryLive)),
);
// { status: "loaded", name: "Ada" }
