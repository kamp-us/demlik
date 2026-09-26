import { type Doc, isArchived, owns, type User } from "./edit.js";

/** A look-alike: the same shape, but who may view is a different rule from who may edit. */
export function canViewDocument(user: User, doc: Doc): boolean {
  if (isArchived(doc)) return false;
  return owns(user, doc) || doc.shared;
}
