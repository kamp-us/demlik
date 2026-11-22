---
"@demlik/tea": patch
---

`driveToDone` now rejects with the first error a Cmd handler throws, the same object, on any hop. Before, a handler that threw on the first hop rejected the drive with its own error, but one that threw on a later hop went to `onError` as a `"follow-up"` and the drive found nothing left to run and rejected with `DriveStalledError`, so the cause was lost. The drive now claims that first failure, so `onError` does not also hear it; a second failure, and one that arrives after the drive has seen a settling State, still reach `onError`. `DriveStalledError` now means only that nothing is left to run. A run you dispatch to yourself, with `run` and `dispatch`, is unchanged, and no export or signature changes.
