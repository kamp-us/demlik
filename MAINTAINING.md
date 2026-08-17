# MAINTAINING — `@demlik/tea`

Maintainer policy for the published contract surface. The npm export map **is** the
contract: every subpath in `package.json` `exports` carries a semver promise and a
servicing cost. This file states that promise per tier and stamps every subpath.

Vocabulary (**tier stamp**, **battery**, **showcase**) is defined below.

## Tiers

Every published subpath carries exactly one **tier stamp**:

- **`stable`** — the kernel: the core loop, the pure/testing surface, and the host
  adapters. The package's one-sentence identity ("durable event-sourced TEA for
  TypeScript") lives here. Strongest promise, slowest movement.
- **`battery`** — a published named pattern built over the kernel (resilience, flow,
  observability/persistence ops). Batteries are the differentiator and stay published,
  but they are allowed to move faster than the kernel — see the semver policy below.
- **`experimental`** — published with no stability promise. Highest strategic weight
  and least dogfooded (the agent layer); exactly the combination that must not carry a
  stability promise yet. Graduation to `battery`/`stable` is a deliberate re-stamp.

Not a tier: a **showcase** — an integration proof (the Raft showcase) that consumes the
published package like any customer. Showcases are **not published**; they live in the
a separate consumer repo, off the export map.

### Tier table — every published subpath

Canonical stamp per subpath. One row per entry in `package.json` `exports`; a new
export is not done until it has a row here.

| Subpath | Tier stamp | Notes |
|---|---|---|
| `.` | stable | the sentence: run / defineMachine / replay / supervision / ports |
| `./pure` | stable | runtime-free umbrella; most stable surface |
| `./subs` | stable | |
| `./testing` | stable | testing infra is kernel |
| `./pbt` | stable | |
| `./pbt/arbitraries` | stable | |
| `./pbt/runners` | stable | |
| `./do` | stable | durable/host seam |
| `./react` | stable | |
| `./node` | stable | |
| `./mem` | stable | |
| `./extension` | stable | |
| `./extension/react` | stable | |
| `./extension/subs` | stable | |
| `./extension/test-utils` | stable | |
| `./parity` | stable | grandfathered by production usage (audit-core) |
| `./devtools` | stable | dev-tooling edge of the kernel |
| `./devtools/styles.css` | stable | asset of `./devtools` |
| `./machine-viz` | stable | |
| `./package.json` | stable | metadata passthrough, not an API subpath |
| `./authed-call` | battery | call-hardening |
| `./cache` | battery | call-hardening |
| `./circuit-breaker` | battery | call-hardening |
| `./deadline` | battery | call-hardening |
| `./rate-limit` | battery | call-hardening |
| `./resilient-call` | battery | **deprecated** → use `./with-resilience` (migration notes in the module's `@deprecated` JSDoc) |
| `./retry-backoff` | battery | call-hardening |
| `./retry-to-success` | battery | call-hardening |
| `./token-refresh` | battery | call-hardening |
| `./with-deadline` | battery | call-hardening |
| `./with-resilience` | battery | call-hardening; successor of `./resilient-call` |
| `./with-telemetry` | battery | call-hardening |
| `./await-terminal` | battery | flow |
| `./batch-window` | battery | flow |
| `./debounce` | battery | flow; layering vs `./throttle`/`./throttled-input` documented in their JSDoc |
| `./fan-out` | battery | flow |
| `./idempotency` | battery | flow |
| `./idempotency/adapter` | battery | flow |
| `./idempotent-intake` | battery | flow |
| `./monitored-run` | battery | flow |
| `./paginated-walk` | battery | flow |
| `./paginator` | battery | flow |
| `./poller` | battery | flow |
| `./reconciler` | battery | flow |
| `./saga` | battery | flow; boundary vs `./workflow` documented in their JSDoc |
| `./throttle` | battery | flow |
| `./throttled-input` | battery | flow |
| `./work-queue` | battery | flow |
| `./work-queue/adapter` | battery | flow |
| `./work-queue/ops` | battery | flow |
| `./workflow` | battery | flow |
| `./recorder` | battery | observability/persistence ops |
| `./snapshot` | battery | ops add-on over the core `Store`, not core Store mechanics |
| `./trace-replay` | battery | observability/persistence ops |
| `./agent` | experimental | agent layer; the brain migration graduates it |
| `./llm-call` | experimental | agent layer |
| `./prediction` | experimental | client prediction |
| `./chart` | experimental | machines authored as config; the type machinery IS the surface |
| `./chart/inspect` | experimental | the chart read as data — headless; the debugger UI's substrate |
| `./chart/inspect/react` | experimental | `<ChartInspector>`; React binding of `./chart/inspect` |
| `./chart/inspect/styles.css` | experimental | asset of `./chart/inspect/react` |
| `./chart/report` | experimental | imports a fabrika `workflow.json` into charts and renders a lane as markdown; tracks an external tool's document format |
| `./chart/lane` | experimental | N chart instances in parallel, grouped into phases that sequence — describe, fold and draw a lane; tracks an external tool's document format |

## Store factory per host

Each host adapter ships one factory that builds a `Store<S>` over that host's
persistence primitive. The names carry a **deliberate split**: three are
*mechanism*-named (they name the backing store) and one is *host*-named (it
names the DO host). Renaming any of them is a breaking change to a `stable`
subpath, so the split is documented here rather than flattened.

| Host adapter (subpath) | Store factory | Backing primitive | Signature | Naming |
|---|---|---|---|---|
| `./node` | `fileStore` | JSON file on disk | `fileStore<S>(path, parse)` | mechanism |
| `./mem` | `memoryStore` | in-process cell | `memoryStore<S>(initial?, parse?)` | mechanism |
| `./extension` | `chromeStorageStore` | `chrome.storage` area | `chromeStorageStore<S>(key, area?)` | mechanism |
| `./do` | `doStore` | `DurableObjectStorage` | `doStore<S>(storage, parse, key?)` | host |

`./react` is a host adapter but binds the runtime to a view; it owns no `Store`
factory and so has no row. If a future factory is added, prefer the
mechanism-named form for consistency with the majority — but do **not** rename
the existing four to converge; that break is not worth the churn (this table is
the cheaper fix).

## Semver policy

The package is at 0.x. Semver's 0.x escape hatch is not the policy — the tier stamp is:

- **`stable`** — breaking changes are deliberate and rare. At 0.x a break in a stable
  subpath lands in a **minor** with an explicit breaking-change callout in the
  changelog; from 1.0 on it forces a **major**. This is the promise the kernel
  consumers (the `./do`/`./react`/`./extension` seam) are buying.
- **`battery`** — **may break in a minor**, before and after 1.0, provided the break is
  flagged in the changelog for that minor. A battery break never forces a major on
  kernel users who never imported it — that is the point of the tier split.
- **`experimental`** — may change or disappear in **any** release; no changelog
  obligation beyond noting the change. Do not build a stability-sensitive consumer on
  an experimental subpath.

### Deprecate, don't delete

A published subpath is never removed outright. Removal is staged:

1. Stamp the module `@deprecated` in JSDoc with a concrete migration note naming the
   successor, and mark the row **deprecated** in the tier table above.
2. Keep the subpath published for **at least one minor** so consumers migrate
   deliberately instead of hitting a surprise break.
3. Remove per the tier's semver rule (post-1.0, removal of a `stable` subpath is a
   major).

Live example: `./resilient-call` → `./with-resilience` (deprecated at step 1–2 now).
