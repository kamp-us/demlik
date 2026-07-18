// ---------------------------------------------------------------------------
// describeError — the one way this package renders an UNKNOWN throw as a
// human-readable reason string.
//
// Every "errors are data" boundary that catches a `catch (e: unknown)` (or a
// settled `{ error: unknown }`) and needs a display/`reason` string faces the
// same fork: an `Error` carries a `.message`; anything else (a thrown string,
// a rejected non-Error, `undefined`) must be coerced. `String(e)` alone loses
// the message for real `Error`s (it stringifies to `"Error: …"` at best, or a
// bare `"[object Object]"`); `.message` alone throws on non-objects. The
// `e instanceof Error ? e.message : String(e)` idiom threads both — hoisted
// here so the rendering rule lives once instead of re-inlined at every
// settled-error surface.
// ---------------------------------------------------------------------------

export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
