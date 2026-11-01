// ---------------------------------------------------------------------------
// Property runners, published on the `@demlik/tea/pbt` subpath (`propertyTerminates`,
// `propertyInvariant`, `propertyTrace`) plus the internal `foldEvents`
// helper they all share.
// ---------------------------------------------------------------------------

export type { MsgCount } from "./msg-tally";
export {
  PropertyFailure,
  type PropertyOpts,
  type PropertyRun,
  propertyInvariant,
  propertyTerminates,
  propertyTrace,
} from "./property";
export { type Fold, foldEvents, type Step } from "./replay-fold";
