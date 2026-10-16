---
"@demlik/tea": minor
---

The word "door" is gone from `@demlik/tea`: a published import path is a subpath, and the root is `@demlik/tea`. The docs, the generated reference, the TSDoc and the repo's own maintenance notes say subpath where they said door, and the three test files that pin the export map are now `public-subpaths.test.ts`, `battery-subpaths.test.ts` and `closed-subpath-specifiers.test.ts`. Other uses of the word take the plain word that fits. No export, subpath or runtime behavior changes.
