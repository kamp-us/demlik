import { type Doc, isArchived, owns, type User } from "./rules.js";

export function canViewDocument(user: User, doc: Doc): boolean {
  if (isArchived(doc)) return false;
  return owns(user, doc) || doc.shared;
}
