import { type Doc, isAdmin, isArchived, owns, type User } from "./edit.js";

/** The same rule as `canEditDocument`, written as early returns. */
export function isEditAllowed(u: User, d: Doc): boolean {
  if (isArchived(d)) return false;
  if (isAdmin(u)) return true;
  return owns(u, d);
}
