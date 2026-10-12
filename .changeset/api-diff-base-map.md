---
"@demlik/code-graph": minor
---

`diffPublishedApi` from `@demlik/code-graph/api` can now see an export subpath that was deleted. Pass
`baseMap` in its options: a function that gets the package root inside the base commit's tree and
returns the API map the package had then. The base is read through that map, so a subpath only the
base had is reported with the base's tier and every name it published as `removed`, and a moved
subpath shows as one removed and one added. `ApiDiffOptions` is the new options type. Without
`baseMap` the result is unchanged, and the CLI's `--api-base` output is unchanged.
