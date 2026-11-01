export type ForWatching = (id: string) => AsyncIterable<string>;
export type ForAliased = () => void;
export type ForNested = () => void;
export type ForScoped = () => void;
export type ForShadowed = () => void;
export type ForGeneric<T> = (value: T) => T;
type Alias = ForAliased;
export type Watcher = {
  aliased: Alias;
  nested: Promise<ForNested>;
  scoped: Remote.ForScoped;
  shadowed: <ForShadowed>(value: ForShadowed) => void;
  generic: ForGeneric<string>;
};
