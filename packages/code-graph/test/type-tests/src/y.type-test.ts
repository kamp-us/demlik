// A compile-time check that nothing runs. Its exports are here to keep `noUnusedLocals` quiet.
import { onlyTypeTestFileTested } from "./shape.js";

export const pinned: number = onlyTypeTestFileTested("x");

export type Pinned = typeof pinned;

export function assertPinned(value: Pinned): Pinned {
  return value;
}
