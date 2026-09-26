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
  every rewording of the question. It reports accuracy, the flip rate, the expected calibration
  error (ECE), coverage and abstain rate, and the verdict is `shippable` only when ECE and flip rate
  are both under their thresholds. A bin count that is not a positive whole number, or a confidence
  outside [0, 1], is refused rather than skipped.
- **Per-stage floor.** `calibrate` bins a stage's answers by confidence and derives the lowest floor
  whose bands all meet a stated accuracy target, or reports it `unreachable`. `evaluate` returns it
  as `calibration`.
- **Confidence gate.** `gatePolicy({ calibration, maxRounds })` reads the floor from that
  calibration; there is no default floor. `gate` / `gateAll` promote an answer at or above the
  floor. Below the floor they enrich and re-ask for at most N rounds, then abstain the item to a
  `HumanQueue`, and it reads as `unknown` downstream.
