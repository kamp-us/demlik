# @demlik/tea

## 0.2.0

### Minor Changes

- a703b7b: feat(tea/do): stepHost gains a working/pending arm + an opt-in defer-resume hook

  `stepHost` was a 2-arm `/step` contract (`{done:false, step}` / `{done:true, output}`)
  that resumed the engine INLINE inside the held request. A non-blocking host cannot
  adopt that — it must answer a pull with an explicit "computing, poll again" instead of
  holding the request across a multi-second step.

  Additive, backward-compatible:

  - New `StepWorking` not-ready arm (`{done:false, working:true, retryAfterMs?}`) — a
    first-class discriminated member, not a hollow `done:false`. Reachable only through
    the opt-in `DeferResumeHook`, so inline adopters keep the byte-identical 2-arm
    `StepResponse`.
  - New `DeferResumeHook<R>` (`enqueue` + `settled`) drives `engine.resume` OUT of the
    held request: the pull settles-and-enqueues and returns `working` promptly; a
    returning activation lands the compute in the durable checkpoint; a later pull reads
    the next step. Selected by an overload — passing `deferResume` widens the response to
    the 3-arm `DeferredStepResponse`; omitting it leaves the inline path unchanged.
  - `runStepLoop` re-polls the working arm (honoring `retryAfterMs`) until a real step
    arrives; an inline host never returns the arm, so its drive is unchanged.

### Patch Changes

- f3d1278: Deprecate `@demlik/tea/resilient-call` in favor of `@demlik/tea/with-resilience`
  (export-consolidation verdict: the two collapse, survivor `with-resilience`). The
  subpath still ships and its API is unchanged, but the module doc and its primary
  entries (`createResilientCall`, `liftResilience`) now carry `@deprecated` JSDoc
  with a migration map — the APIs are not drop-in, so there is no re-export shim.
  Per the "deprecate, don't delete" window, the `./resilient-call` export survives
  one minor release after this deprecation and is then removed.

## 0.1.1

### Patch Changes

- c470364: Ship the `./parity` subpath export to the registry. The export map already declares
  `@demlik/tea/parity` (built to `dist/parity`), but the published `0.1.0` predates it —
  so a cross-repo consumer installing the tarball hard-fails on `import "@demlik/tea/parity"`.
  This changeset bumps the package so trusted publishing republishes a version that actually
  carries the export.
