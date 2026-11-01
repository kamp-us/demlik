---
"@demlik/tea": minor
---

`propertyInvariant` and `propertyTrace` (`@demlik/tea/pbt`) take a check returning `boolean | string | null`, so a check holding several laws can say which one broke. `true` and `null` hold. `false` and any string fail, and an empty string fails. A string lands in the thrown error's message beside the shrunk list, on both fast-check majors. A check returning a plain boolean, or one that throws, behaves as before. `propertyTerminates` does not change.

**Additive (declaration only):** the check's return type is wider. No existing call needs editing and no existing seed draws anything new.
