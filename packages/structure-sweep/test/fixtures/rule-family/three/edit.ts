export interface User {
  readonly id: string;
  readonly role: "admin" | "member";
}

export interface Doc {
  readonly ownerId: string;
  readonly archived: boolean;
  readonly shared: boolean;
}

export const isArchived = (doc: Doc) => doc.archived;
export const isAdmin = (user: User) => user.role === "admin";
export const owns = (user: User, doc: Doc) => user.id === doc.ownerId;

/** The rule: an archived document is frozen; otherwise its owner or an admin may edit it. */
export function canEditDocument(user: User, doc: Doc): boolean {
  if (isArchived(doc)) return false;
  return owns(user, doc) || isAdmin(user);
}
