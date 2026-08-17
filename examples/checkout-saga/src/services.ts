/**
 * The Effect side of the demo: two services with typed failures, and a Layer
 * that provides them. The DO builds ONE `ManagedRuntime` from this Layer per
 * instance; `toInterpret` discharges it per Cmd.
 */

import { Context, Data, Effect, Layer } from "effect";
import { declinesFor, isRefundScenario } from "./machine";

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
  /** Lodge the refund. Returns once the processor has ACCEPTED it. */
  readonly submitRefund: (input: {
    readonly paymentRef: string;
  }) => Effect.Effect<void, RefundRejected>;
  /** Ask whether the lodged refund has cleared. Runs after the wait. */
  readonly confirmRefund: (input: {
    readonly paymentRef: string;
  }) => Effect.Effect<void, RefundRejected>;
}

export class Payments extends Context.Service<Payments, PaymentsApi>()(
  "checkout/Payments",
) {}

export interface InventoryApi {
  /** Lodge the reservation request. Returns once the warehouse has it. */
  readonly requestReservation: (input: {
    readonly orderId: string;
  }) => Effect.Effect<void, never>;
  /**
   * Ask the warehouse what it decided. Deliberately a SECOND round trip: the
   * answer arrives after a wait the saga has to survive, which is what makes
   * "killed while reserving" a real case rather than an instantaneous blip.
   */
  readonly reservationOutcome: (input: {
    readonly orderId: string;
  }) => Effect.Effect<void, OutOfStock>;
}

export class Inventory extends Context.Service<Inventory, InventoryApi>()(
  "checkout/Inventory",
) {}

// How many declines each scenario gets, and which scenario an order id names,
// both live in the machine module — so the pure saga, this layer and the naive
// lane cannot drift apart into an unfair race.

/**
 * The fake provider. Deterministic in `attempt`, which the reducer carries in
 * the Cmd — deliberately NOT a module-level counter. A counter would be reset
 * by `ctx.abort()`, and the resumed order would sail through on its first
 * post-restart charge, which would make the demo a lie.
 */
export const PaymentsFake = Layer.succeed(Payments)({
  charge: ({ orderId, amountCents, attempt }) =>
    attempt <= declinesFor(orderId)
      ? Effect.fail(
          new PaymentDeclined({
            orderId,
            attempt,
            reason: `issuer timeout (attempt ${attempt})`,
          }),
        )
      : Effect.succeed(`pay_${orderId}_${amountCents}_a${attempt}`),
  submitRefund: () => Effect.void,
  confirmRefund: () => Effect.void,
});

/**
 * The refund-scenario order id is the one the warehouse cannot fill.
 */
export const InventoryFake = Layer.succeed(Inventory)({
  requestReservation: () => Effect.void,
  reservationOutcome: ({ orderId }) =>
    isRefundScenario(orderId)
      ? Effect.fail(new OutOfStock({ orderId }))
      : Effect.void,
});

export const CheckoutLayer = Layer.merge(PaymentsFake, InventoryFake);
