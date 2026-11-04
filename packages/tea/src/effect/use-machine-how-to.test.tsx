// @vitest-environment happy-dom
/**
 * The React how-to's Effect section: compile-and-run gate (#852).
 *
 * `docs/how-to/drive-from-react.md` step 8 shows `useMachine` on the Effect
 * engine. The component is a `#region` of this file, verbatim
 * (`../docs/page-mirrors.ts` holds the row), and it renders here on a real
 * `react-dom/client` root. It lives under `src/effect/` because it imports
 * `effect`, which only this entry may do.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` marker below
// pins an import block the page reproduces verbatim; sorting the harness's
// imports into it would move the marker and break the row this file backs.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { profile } from "../../examples/profile-lookup";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// #region on-effect
import { runIn } from "@demlik/tea/effect";
import { useMachine } from "@demlik/tea/react";
import { Context, Effect, Layer, ManagedRuntime } from "effect";

/** Where names come from, as an Effect service. */
class Directory extends Context.Service<
  Directory,
  { readonly nameOf: (id: string) => Effect.Effect<string | undefined> }
>()("Directory") {}

// Build the runtime once, outside any component. It is yours: you dispose it.
const runtime = ManagedRuntime.make(
  Layer.succeed(Directory, {
    nameOf: (id) => Effect.succeed(id === "u1" ? "Ada" : undefined),
  }),
);

function Lookup() {
  const [state, send] = useMachine(profile, {
    run: runIn(runtime),
    ctx: undefined,
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

  return (
    <button type="button" onClick={() => send({ type: "look_up", id: "u1" })}>
      {state.status}: {state.name}
    </button>
  );
}
// #endregion on-effect

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => runtime.dispose());

it("step 8: the hook runs the machine's Cmd as an Effect that reads the runtime's service", async () => {
  await act(async () => root.render(<Lookup />));
  expect(container.textContent).toBe("idle: ");

  await act(async () => container.querySelector("button")?.click());
  await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  expect(container.textContent).toBe("loaded: Ada");
});
