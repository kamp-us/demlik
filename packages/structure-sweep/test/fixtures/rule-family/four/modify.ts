import { type Doc, isAdmin, isArchived, owns, type User } from "./edit.js";

/** The same rule as `canEditDocument`, written as one expression. */
export function mayModifyDoc(actor: User, document: Doc): boolean {
  return !isArchived(document) && (isAdmin(actor) || owns(actor, document));
}
