/**
 * A WELL-FORMED WORKFLOW WITH NOTHING OF FABRIKA'S IN IT.
 *
 * Same grammar, different world. Every NAME here is a checkout's: the events
 * (`SUBMITTED`, `AUTHORISED`, `DECLINED`, `HELD`, `RESUMED`, `PICKED`,
 * `DISPATCHED`, `LOST`), the namespaces (`PAYMENT.`, `PARCEL.`), the task ids,
 * the state names, the phase names, the two terminals, the guard label, and the
 * history state — which is called `back` rather than `hist`, because that name
 * was never ours either. The intersection with fabrika's vocabulary is empty,
 * and `workflow.test.ts` asserts that rather than asking you to eyeball it.
 *
 * What it keeps is the GRAMMAR, exactly: a machine of `parallel` phases chained
 * by `onDone` pairs onto two machine-level finals, regions whose states route
 * events to targets, one guarded two-arm array per retry loop, one `history`
 * target for the resume, and finals for the two endings.
 *
 * This is the fixture that says #5800 cannot break us. When phoenix reshapes
 * its epic lanes and a seventh event name appears, the importer that reads THIS
 * document reads that one too — because neither document's names were ever
 * something this package knew.
 */

/** The document. Shaped as `JSON.parse` would hand it over — no types claimed. */
export const CHECKOUT_WORKFLOW: unknown = {
  id: "checkout",
  version: 1,
  trigger: "cart.checkout-requested",
  machine: {
    id: "checkout",
    initial: "authorisation",
    context: {
      payment: { attempts: 0, maxRetries: 3, currency: "TRY" },
      parcel: { retries: 0, maxRetries: 2 },
    },
    states: {
      authorisation: {
        type: "parallel",
        states: {
          payment: {
            initial: "awaiting-card",
            states: {
              "awaiting-card": {
                on: {
                  "PAYMENT.SUBMITTED": "authorising",
                  "PAYMENT.HELD": "on-hold",
                },
              },
              authorising: {
                on: {
                  "PAYMENT.AUTHORISED": "captured",
                  "PAYMENT.HELD": "on-hold",
                  "PAYMENT.DECLINED": [
                    {
                      target: "awaiting-card",
                      guard: "attemptsRemaining",
                      actions: "countAttempt",
                    },
                    { target: "abandoned" },
                  ],
                },
              },
              "on-hold": { on: { "PAYMENT.RESUMED": "back" } },
              back: { type: "history" },
              captured: { type: "final" },
              abandoned: { type: "final" },
            },
          },
        },
        onDone: [
          { target: "fulfilment", guard: "noErrors" },
          { target: "cancelled" },
        ],
      },
      fulfilment: {
        type: "parallel",
        states: {
          parcel: {
            initial: "unpacked",
            states: {
              unpacked: { on: { "PARCEL.PICKED": "picking" } },
              picking: {
                on: {
                  "PARCEL.DISPATCHED": "handed-over",
                  "PARCEL.LOST": [
                    { target: "unpacked", guard: "attemptsRemaining" },
                    { target: "written-off" },
                  ],
                },
              },
              "handed-over": { type: "final" },
              "written-off": { type: "final" },
            },
          },
        },
        onDone: [
          { target: "settled", guard: "noErrors" },
          { target: "cancelled" },
        ],
      },
      settled: { type: "final" },
      cancelled: { type: "final" },
    },
  },
};

/**
 * A run that exercises all three edge forms: a plain edge, the guarded array
 * (declined once, inside budget), and the resume out of `on-hold` back to
 * `authorising` rather than to the region's initial.
 */
export const CHECKOUT_EVENTS_JSONL = [
  `{"task":"payment","event":"PAYMENT.SUBMITTED","at":"2026-08-17T09:00:00.000Z"}`,
  `{"task":"payment","event":"PAYMENT.DECLINED","at":"2026-08-17T09:00:31.000Z"}`,
  `{"task":"payment","event":"PAYMENT.SUBMITTED","at":"2026-08-17T09:02:10.000Z"}`,
  `{"task":"payment","event":"PAYMENT.HELD","at":"2026-08-17T09:02:44.000Z"}`,
  `{"task":"payment","event":"PAYMENT.RESUMED","at":"2026-08-17T10:15:02.000Z"}`,
  `{"task":"payment","event":"PAYMENT.AUTHORISED","at":"2026-08-17T10:15:39.000Z"}`,
  "",
].join("\n");

/** This consumer's cast — the same three origins, none of the same roles. */
export const CHECKOUT_ORIGINS = {
  from: {
    SUBMITTED: { world: "the shopper" },
    RESUMED: { world: "the on-call" },
    PICKED: { world: "the warehouse" },
    HELD: "sub",
    AUTHORISED: "cmd",
    DECLINED: "cmd",
    DISPATCHED: "cmd",
    LOST: "cmd",
  },
} as const;
