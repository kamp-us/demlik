/**
 * Direction 1 of the bridge: Cmd handlers authored as Effect programs, lowered
 * into tea's `Interpret` by `toInterpret`.
 *
 * Every handler's error channel is discharged INSIDE the effect — `catchTag`
 * folds the typed failure into a Msg the reducer already knows. `E = never` is
 * the bridge's load-bearing rule, and it is also just good saga hygiene: a
 * declined card is not an exception, it is a transition.
 */

import { Effect } from "effect";
import type { EffectRunner } from "../../../src/effect/index";
import { teaServices, toInterpret } from "../../../src/effect/index";
import type { Interpret } from "../../../src/index";
import type { Cmd, Ctx, Msg } from "./machine";
import { Inventory, Payments } from "./services";

/** Built once per app, shared — the string ids are the runtime identity. */
export const services = teaServices<Msg, Ctx>("checkout-saga");

export type CheckoutR = Payments | Inventory;

/**
 * `at` is read at the effect boundary, never in the reducer, and travels in
 * the Msg — so the reducer stays a pure function of `(state, msg)`.
 */
const now = (): number => Date.now();

export function checkoutInterpret(
  runtime: EffectRunner<CheckoutR>,
): Interpret<Msg, Cmd, Ctx> {
  return toInterpret<Msg, Cmd, Ctx, CheckoutR>(
    {
      charge: (cmd) =>
        Effect.gen(function* () {
          const payments = yield* Payments;
          const ref = yield* payments.charge({
            orderId: cmd.orderId,
            amountCents: cmd.amountCents,
            attempt: cmd.attempt,
          });
          return { type: "payment_ok", ref, at: now() } as const;
        }).pipe(
          Effect.catchTag("PaymentDeclined", (error) =>
            Effect.succeed({
              type: "payment_failed",
              reason: error.reason,
              at: now(),
            } as const),
          ),
        ),

      reserve: (cmd) =>
        Effect.gen(function* () {
          const inventory = yield* Inventory;
          yield* inventory.reserve({ orderId: cmd.orderId });
          return { type: "reserve_ok", at: now() } as const;
        }).pipe(
          Effect.catchTag("OutOfStock", (error) =>
            Effect.succeed({
              type: "reserve_failed",
              reason: `out of stock: ${error.orderId}`,
              at: now(),
            } as const),
          ),
        ),

      refund: (cmd) =>
        Effect.gen(function* () {
          const payments = yield* Payments;
          yield* payments.refund({ paymentRef: cmd.paymentRef });
          return { type: "refund_ok", at: now() } as const;
        }).pipe(
          Effect.catchTag("RefundRejected", (error) =>
            Effect.succeed({
              type: "refund_failed",
              reason: error.reason,
              at: now(),
            } as const),
          ),
        ),
    },
    { runtime, services },
  );
}
