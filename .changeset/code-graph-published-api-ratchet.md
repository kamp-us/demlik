---
"@demlik/code-graph": minor
---

New: gate a PR on its published-API diff. `code-graph <package> --api <map> --api-base <rev>
--api-policy <file>` checks every added, removed and changed name against the changesets added
since `<rev>`. The policy is a JSON file the caller writes: per tier and change kind, the least
bump (`none`, `patch`, `minor`, `major`) and whether a callout is owed, plus the callout's marker
text. code-graph ships no policy of its own, and a changed name whose tier the policy gives no row
and no `default` exits 2 instead of passing. The changesets that count are the `.changeset/*.md`
files the base commit lacks whose frontmatter names the package; the highest of their bumps is the
bump found. It exits 0 on a pass and 1 on a miss, printing one block per name that misses with its
subpath, tier, change kind, the bump needed and found, and the before/after text; `--json` prints
the verdict. `readChangesetsSince`, `ratchetApiDiff` and `BumpPolicySchema` from
`@demlik/code-graph/api` are the library side. Without `--api-policy`, nothing changes.
