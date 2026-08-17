/**
 * The Effect side of the demo: two services with typed failures, and a Layer
 * that provides them. The DO builds ONE `ManagedRuntime` from this Layer per
 * instance; `toInterpret` discharges it per Cmd.
 */

import { Context, Data, Effect, Layer } from "effect";

export class PaymentDeclined extends Data.TaggedError("PaymentDeclined")<{
  readonly orderId: string;
  readonly attempt: number;
  readonly reason: string;
}> {}

export class OutOfStock extends Data.TaggedError("OutOfStock")<{
  readonly orderId: string;
}> {}

export class RefundRejected extends Data.TaggedError("RefundRejected")<{
  readonly paymentRef: string;
  readonly reason: string;
}> {}

export interface PaymentsApi {
  readonly charge: (input: {
    readonly orderId: string;
    readonly amountCents: number;
    readonly attempt: number;
  }) => Effect.Effect<string, PaymentDeclined>;
  readonly refund: (input: {
    readonly paymentRef: string;
  }) => Effect.Effect<void, RefundRejected>;
}

export class Payments extends Context.Service<Payments, PaymentsApi>()(
  "checkout/Payments",
) {}

export interface InventoryApi {
  readonly reserve: (input: {
    readonly orderId: string;
  }) => Effect.Effect<void, OutOfStock>;
}

export class Inventory extends Context.Service<Inventory, InventoryApi>()(
  "checkout/Inventory",
) {}

/** Attempts at or below this are declined by the fake provider. */
export const FLAKY_ATTEMPTS = 2;

/**
 * The fake provider. Deterministic in `attempt`, which the reducer carries in
 * the Cmd — deliberately NOT a module-level counter. A counter would be reset
 * by `ctx.abort()`, and the resumed order would sail through on its first
 * post-restart charge, which would make the demo a lie.
 */
export const PaymentsFake = Layer.succeed(Payments)({
  charge: ({ orderId, amountCents, attempt }) =>
    attempt <= FLAKY_ATTEMPTS
      ? Effect.fail(
          new PaymentDeclined({
            orderId,
            attempt,
            reason: `issuer timeout (attempt ${attempt})`,
          }),
        )
      : Effect.succeed(`pay_${orderId}_${amountCents}_a${attempt}`),
  refund: () => Effect.void,
});

/**
 * An order id containing `oos` is out of stock — the compensation path.
 */
export const InventoryFake = Layer.succeed(Inventory)({
  reserve: ({ orderId }) =>
    orderId.includes("oos")
      ? Effect.fail(new OutOfStock({ orderId }))
      : Effect.void,
});

export const CheckoutLayer = Layer.merge(PaymentsFake, InventoryFake);
