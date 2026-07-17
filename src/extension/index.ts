/**
 * @packageDocumentation
 * @demlik/tea/extension — Chrome service-worker host adapter for @demlik/tea.
 *
 * Substrate-level companion to @demlik/tea/do (Durable Objects) and
 * @demlik/tea/react (React). Lets a chrome service worker run a @demlik/tea
 * machine with persistence backed by chrome.storage.
 *
 * Single export: chromeStorageStore<S>(key, area?). Apps register chrome.*
 * listeners themselves and call runtime.dispatch from inside the handler —
 * those wiring patterns are app-specific (different extensions register
 * different listener sets, with different Msg adapters), so we don't
 * abstract them here until the shape stabilizes across consumers.
 */

import type { Store } from "../index";

export type {
  BridgeClient,
  BridgeClientOpts,
  BridgeRuntimeOpts,
  BridgeTabClientOpts,
} from "./bridge";
// Re-export the wire-envelope types — surfaces that test against the
// bridge can pin the shapes without round-tripping through the runtime.
// Re-export the runtime bridge primitives. The React adapter lives at
// `@demlik/tea/extension/react` so the main entry stays react-free for the
// background service-worker side.
export {
  bridgeClient,
  bridgeRuntime,
  bridgeTabClient,
  passThroughMsg,
} from "./bridge";

const MALFORMED = "chromeStorageStore: stored value is not a string";

/**
 * `Store<S>` backed by `chrome.storage.local` (or any compatible
 * `StorageArea`). JSON.stringify on save, JSON.parse on load. Returns `null`
 * (typed as `unknown` per `Store<S>.load` contract) when the key is absent.
 *
 * Throws on the structural layer if the stored value is malformed (non-string
 * at the key, or unparseable JSON) — matches @demlik/tea/do's "throw at boot via
 * store.load" contract so tea's `run()` surfaces it predictably. The
 * `parse` callback handles the semantic layer (shape mismatch → return
 * `null`); it must NOT throw, per the `Store<S>.migrate` contract.
 *
 * `parse` is REQUIRED because chrome.storage is a real serialization boundary
 * — JSON to disk, then back — and the structural type of what comes back is
 * `unknown`. The caller (extension code that knows `S`) is the only party
 * with enough information to write the parse. There is no honest default.
 *
 * `area` defaults to `chrome.storage.local` for production. Tests pass a
 * `fakeChrome().storage.local` in.
 */
export function chromeStorageStore<S>(
  key: string,
  parse: (raw: unknown) => S | null,
  area: chrome.storage.StorageArea = chrome.storage.local,
): Store<S> {
  return {
    async load(): Promise<unknown> {
      const result = await area.get(key);
      const raw = (result as Record<string, unknown>)[key];
      if (raw === undefined || raw === null) return null;
      if (typeof raw !== "string")
        throw new Error(`${MALFORMED} at key "${key}"`);
      // JSON.parse throws on malformed — propagate per @demlik/tea/do parity.
      // The decoded value is intentionally returned as `unknown`; the
      // substrate's `migrate` callback (forwarded from `parse`) is the
      // boundary parse that turns it into `S | null`.
      return JSON.parse(raw);
    },
    async save(state: S): Promise<void> {
      await area.set({ [key]: JSON.stringify(state) });
    },
    migrate(raw: unknown): S | null {
      return parse(raw);
    },
  };
}
