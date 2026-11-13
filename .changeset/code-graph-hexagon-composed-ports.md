---
"@demlik/code-graph": minor
---

`code-graph <featureDir> --hexagon` and `--owners` now read a feature's port list when it is written with `&`, with `extends` or as an alias, and say so when a list is still not read.

Before, a `Commands` list written as `OrderIntents & { placeOrder }`, as `interface Billing extends BillingIntents { refund }` or as `Shipment = ShipmentBase` came back empty and printed `none`, so the report read as "this feature has no commands" and still exited 0. On 61 real feature folders that hid the main list of 26. A bag is now the members of every part it names: a type literal, an operand of `&`, an interface it extends, the declaration an alias points at. A name has to be declared exactly once in `ports.ts` itself, exported or not, so no module resolution or type checker is involved. A bag is still read whole or not at all: a part from another file, a generic part, a qualified name, a cycle of aliases, a union, or a member name written in two parts leaves the whole bag under Not read, and the reason names the operand that failed.

A feature with no `create…` function is named too: when `ports.ts` holds exactly one readable pair `X` and `XDriven`, `X` is the feature, never a name made from the folder. With no pair, or two, `feature` stays `null`.

**What changes for a reader of the output:** a list whose bag is not read is no longer an empty one. Text prints `not read: ports.ts:5 Orders: union type` where it printed `none`, and `commands` and `externalSystems` in `--json`, in `--hexagon` and per feature in `--owners`, hold `{ "notRead": { file, line, name, reason } }` where they held `[]`. A reader that iterates those two fields must test for the object first. Bags that were under Not read as `intersection type`, `bag alias` or `interface extends` are now bags, `feature` is non-null where it was `null` for a folder with one `X` and `XDriven` pair, and `--owners` shows the same lists `--hexagon` does. The rules are in SPEC §14.
