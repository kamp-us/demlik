# demlik domain vocabulary (TERMS)

The repo-owned vocabulary spine. One row per term: the canonical definition, and where a name has
drifted, what the term is **not**. When the code and this file disagree, the code is authoritative
and this file is the doc to fix.

## The intent layer
| Term | Definition | Not |
|---|---|---|
| lid | An intent-altitude surface over the kernel — `defineAgent` — that defaults, generates and sequences the wiring between parts and never hides state: the Model it produces is the one a hand-wired machine produces, under the same keys, and every altitude beneath stays a reachable door (ADR 0015). | A wrapper that owns the state. A lid that stores Model in a private field, or whose output the raw `run` cannot take, is a framework, not a lid. |
| part | An internal battery module a lid composes — `toolRouter`, `driveToDone`, the plain model port — each independently testable and named in the lid's source so what it hides stays legible. Public only on a real external callsite, never because the lid uses it. | A public door. Parts are the lid's ceremony made visible; the export map lists doors. |
