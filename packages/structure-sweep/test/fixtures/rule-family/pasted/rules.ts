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
