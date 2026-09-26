import { type Doc, isAdmin, isArchived, owns, type User } from "./rules.js";

export function canEditDocument(user: User, doc: Doc): boolean {
  if (isArchived(doc)) return false;
  return owns(user, doc) || isAdmin(user);
}
