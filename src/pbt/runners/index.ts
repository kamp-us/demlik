// ---------------------------------------------------------------------------
// @demlik/tea/pbt/runners — property runners (`propertyTerminates`,
// `propertyInvariant`, `propertyTrace`) plus the internal `foldEvents`
// helper they all share.
// ---------------------------------------------------------------------------

export { propertyInvariant, propertyTerminates, propertyTrace } from "./property";
export { foldEvents, type Step } from "./replay-fold";
