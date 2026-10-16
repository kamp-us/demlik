// ---------------------------------------------------------------------------
// Property runners, published on the `@demlik/tea/pbt` subpath (`propertyTerminates`,
// `propertyInvariant`, `propertyTrace`) plus the internal `foldEvents`
// helper they all share.
// ---------------------------------------------------------------------------

export {
  propertyInvariant,
  propertyTerminates,
  propertyTrace,
} from "./property";
export { foldEvents, type Step } from "./replay-fold";
