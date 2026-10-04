/**
 * The drive how-to's Effect half, compiled and run (#550).
 *
 * `docs/how-to/test-a-machine-with-drive.md` shows each `#region` of this file
 * verbatim (`../../docs/page-mirrors.ts` holds the row). The Promise half is
 * `../../docs/how-to/test-a-machine-with-drive.test.ts`. This half is here
 * because only `src/effect/` and this directory may import `effect`.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin an import block the page reproduces verbatim; sorting the harness's
// imports into it would move a marker and break the row this file backs.

import { describe, expect, it } from "vitest";
import { newOrder, order } from "../../../examples/order";
import { orderHandlers, Shop } from "../../../examples/order-effect";

// #region drive
import { drive } from "@demlik/tea/testing/effect";
import { Effect, Layer } from "effect";

/** A shop that says yes to everything except, when asked, the card. */
const fakeShop = (card: "accepted" | "declined") =>
  Layer.succeed(Shop, {
    reserve: () => Effect.succeed({ hold: "hold-1" }),
    charge: (cents) =>
      card === "declined"
        ? Effect.fail({ _tag: "declined" as const })
        : Effect.succeed({ receipt: `paid-${cents}` }),
    ship: (sku) => Effect.succeed({ tracking: `track-${sku}` }),
  });

/** Drive one order to the end, on the real handlers over the fake shop. */
function driveOrder(card: "accepted" | "declined") {
  return Effect.runPromise(
    drive(
      order,
      newOrder,
      { type: "place", sku: "TEA-001", cents: 4200 },
      orderHandlers,
    ).pipe(Effect.provide(fakeShop(card))),
  );
}
// #endregion drive

describe("docs/how-to/test-a-machine-with-drive.md, on the Effect engine", () => {
  // #region success
  it("ships an order whose card is accepted", async () => {
    const { state, trace } = await driveOrder("accepted");

    expect(state).toEqual({
      status: "shipped",
      sku: "TEA-001",
      cents: 4200,
      tracking: "track-TEA-001",
      failure: null,
    });

    const ran = trace.flatMap((entry) =>
      entry.kind === "cmd" ? [entry.cmd.type] : [],
    );
    expect(ran).toEqual(["reserve_stock", "charge_card", "ship_parcel"]);
  });
  // #endregion success

  // #region failure
  it("stops an order whose card is declined, and ships nothing", async () => {
    const { state, trace } = await driveOrder("declined");

    expect(state.status).toBe("failed");
    expect(state.failure).toBe("declined");
    expect(state.tracking).toBeNull();

    const ran = trace.flatMap((entry) =>
      entry.kind === "cmd" ? [entry.cmd.type] : [],
    );
    expect(ran).toEqual(["reserve_stock", "charge_card"]);
  });
  // #endregion failure
});
