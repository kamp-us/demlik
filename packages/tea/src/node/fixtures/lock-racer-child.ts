import { open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock } from "../file-lock";

const [lockPath, holderPath] = process.argv.slice(2) as [string, string];

// One writer racing its siblings for a lock: the parent says go once all of them
// are up, so they reach the leftover lock together. Creating `holderPath` with
// `wx` inside the lock makes a second holder a thrown EEXIST, so a broken lock
// exits non-zero.
process.once("message", () => {
  void withFileLock(dirname(lockPath), lockPath, async () => {
    const proof = await open(holderPath, "wx");
    await proof.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await unlink(holderPath);
  }).then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
});
process.send?.("up");
