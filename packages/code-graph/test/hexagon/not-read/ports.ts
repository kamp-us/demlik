import type * as Remote from "outside";

export type ForReading = () => string;
export type ForUnused = () => void;
export type ForGeneric<T> = (value: T) => T;
export type ForDefaulted<T = string> = (value: T) => T;
export type ForImplicit<T> = (value: T) => T;
export type ForScoped = Remote.ForReading;
export type Warehouse = {
  read?: ForReading;
  generic: ForGeneric<string>;
  implicit: ForImplicit;
  scoped: Remote.ForUnused;
  shadowed: <ForUnused>(value: ForUnused) => void;
  nested: Promise<ForUnused>;
};
export interface WarehouseDriven { read: ForReading }
type Local = { read: ForUnused };
export type { Local as Renamed };
export type { ForExternal } from "outside";
export * as RemotePorts from "outside";
export * from "outside";
export type GenericBag<T> = { value: T };
export type GenericInstance = GenericBag<string>;
export type Parenthesized = (({ read: ForUnused }));
export interface Merged { read: ForUnused }
export interface Merged { count: number }
export interface ForCallable { (): string }
export type Calling = { (): void; read: ForUnused };
export type Constructing = { new(): Warehouse; read: ForUnused };
export type Indexed = { [key: string]: ForUnused };
export type Mapped = { [K in "read"]: ForUnused };
export type Conditional = string extends number ? Warehouse : WarehouseDriven;
export type Intersection = Local & { count: number };
export type Union = Local | Warehouse;
export type Alias = Local;
export default interface DefaultBag { read: ForUnused }
export interface Overridden extends Warehouse { read: () => number }
export type Duplicate = { read: ForReading; read: ForUnused };
export type Scoped = <ForReading>(value: ForReading) => void;
export type OptionalMethod = { read?(): string };
export type Getter = { get read(): string };
export type Setter = { set read(value: string) };
export type CyclicA = CyclicB;
export type CyclicB = CyclicA;
export type MissingType = { value };
export type Computed = { [Symbol.iterator]: ForUnused };
export namespace Scope { export type Bag = { read: ForUnused } }
export const createValue = () => ({});
export function createFunction() {}
export import Imported = Scope.Bag;
export as namespace GlobalPorts;
export = Scope;
export interface Escaped { read: ForUnused }
export interface \u0045scaped { count: number }
declare module "./ports" {
  interface Warehouse { count: number }
}
