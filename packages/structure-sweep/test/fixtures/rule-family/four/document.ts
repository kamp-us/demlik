import type { Doc, User } from "./edit.js";

/** The same rule as `canEditDocument` a fourth time, written inline with no helper. */
export function mayModifyDocument(actor: User, doc: Doc): boolean {
  if (doc.archived) return false;
  if (actor.role === "admin") return true;
  return doc.ownerId === actor.id;
}
