---
"@demlik/structure-sweep": minor
---

Add the lowering foundation: stage artifacts, an evaluation harness and a confidence gate
(#430, #427).

- **Stage artifacts.** `runStage` caches a stage's typed facts under a key built from the input's
  content hash, the stage version and the input artifacts' digests, so an unchanged key is a hit
  that never runs the stage. Every fact carries a source span, and a value the stage isn't sure of
  is an explicit `unknown`.
- **Evaluation harness.** `evaluate` reads a gold set (`loadGoldSet`) and asks each item under
  every rewording of the question. It reports the flip rate and the expected calibration error
  (ECE), and the verdict is `shippable` only when both are under their thresholds.
- **Confidence gate.** `gate` / `gateAll` promote an answer at or above the floor. Below the floor
  they enrich and re-ask for at most N rounds, then abstain the item to a `HumanQueue`, and it
  reads as `unknown` downstream.
