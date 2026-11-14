export * from "../shared";

/**
 * Someone who signs in.
 *
 * @stability stable
 * @category models
 */
export interface User {
  readonly name: string;
}

/**
 * What a user may do.
 *
 * @stability stable
 * @category models
 */
export type Role = "admin" | "member";

/**
 * A user's account.
 *
 * @stability stable
 * @category models
 */
export interface Account {
  readonly user: User;
  readonly role: Role;
}

/**
 * An account's id.
 *
 * @stability stable
 * @category models
 */
export type Id = string;

/**
 * One signed-in stretch.
 *
 * @stability unstable
 * @category models
 */
export class Session {
  readonly started = 0;
}

/**
 * Where an account stands.
 *
 * @stability stable
 * @category models
 */
export enum Status {
  Active,
  Closed,
}

export interface Guest {
  readonly visits: number;
}

export type Token = string;

/** What a token may reach. */
export type Scope = "read" | "write";

/**
 * A record of who did what.
 *
 * @see User
 * @see Account
 * @remarks kept for a year
 * @stability stable
 * @category models
 */
export interface Audit {
  readonly who: Id;
}
