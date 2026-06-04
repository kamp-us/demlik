// ---------------------------------------------------------------------------
// platform.ts — minimal structural declarations for the host globals the
// factories need.
//
// `@demlik/tea`'s tsconfig pins `lib: ["ES2020"]` on purpose: the substrate
// must build in any host (Node, Cloudflare Workers, browser, service
// worker) without dragging in DOM or WebWorker lib types that are
// host-specific. The factories in this subpath DO need a handful of host
// types (`EventTarget`, `Event`, `MessageEvent`, `BroadcastChannel`,
// `EventSource`), but redeclaring them structurally — only the surface
// each factory actually touches — keeps the substrate's "no host lib
// commitment" contract intact.
//
// These declarations are structural minima. The real platform types
// extend them; assignments from real-platform-typed values flow because
// excess-property width is allowed at function boundaries.
// ---------------------------------------------------------------------------

export interface MinimalEvent {
  readonly type: string;
}

export interface MinimalMessageEvent extends MinimalEvent {
  readonly data: unknown;
}

export interface MinimalEventTarget {
  addEventListener(type: string, listener: (event: MinimalEvent) => void): void;
  removeEventListener(
    type: string,
    listener: (event: MinimalEvent) => void,
  ): void;
}

export interface MinimalBroadcastChannel {
  addEventListener(
    type: "message",
    listener: (event: MinimalMessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MinimalMessageEvent) => void,
  ): void;
  close(): void;
}

export interface MinimalBroadcastChannelCtor {
  new (name: string): MinimalBroadcastChannel;
}

export interface MinimalEventSource {
  addEventListener(
    type: "message",
    listener: (event: MinimalMessageEvent) => void,
  ): void;
  addEventListener(type: string, listener: (event: MinimalEvent) => void): void;
  removeEventListener(
    type: "message",
    listener: (event: MinimalMessageEvent) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: MinimalEvent) => void,
  ): void;
  close(): void;
}

export interface MinimalEventSourceCtor {
  new (url: string): MinimalEventSource;
}

// WebSocket's `close` event carries `code` + `reason` + `wasClean`; the
// factory surfaces `code` and `reason` to the caller's `onClose` callback,
// so the structural shape exposes only those two fields the substrate
// touches.
export interface MinimalCloseEvent extends MinimalEvent {
  readonly code: number;
  readonly reason: string;
}

// WebSocket is the symmetric streaming protocol — client-initiated open,
// bidirectional message frames until either side closes. The factory only
// uses the four lifecycle handlers (`onopen` / `onmessage` / `onerror` /
// `onclose`) and `close(code, reason)` for cleanup, so the structural
// shape exposes only that surface.
export interface MinimalWebSocket {
  close(code?: number, reason?: string): void;
  onopen: ((event: MinimalEvent) => void) | null;
  onmessage: ((event: MinimalMessageEvent) => void) | null;
  onerror: ((event: MinimalEvent) => void) | null;
  onclose: ((event: MinimalCloseEvent) => void) | null;
}

export interface MinimalWebSocketCtor {
  new (url: string): MinimalWebSocket;
}

// `setInterval` / `clearInterval` are typed by ES2020 lib; we declare the
// MV3 / Node return-shape opaquely so this module doesn't depend on
// `number` (browser) vs `NodeJS.Timeout` (node) discrimination.
export type TimerHandle = ReturnType<typeof setInterval>;
