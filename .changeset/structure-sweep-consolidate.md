---
"@demlik/structure-sweep": minor
---

`structure-sweep consolidate` proposes consolidations from the sweep and pairs
outputs already on disk (#387): clusters of tiny files sharing scope, feature
and role to merge, and connected `shared_helper` pairs to extract into one
helper. It writes a JSON plan and a markdown summary and calls no model. The
library exports `mergeProposals`, `extractProposals` and `renderConsolidation`.
