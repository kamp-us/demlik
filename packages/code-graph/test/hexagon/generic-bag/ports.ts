type Base<T> = { read: (value: T) => T };
export type Warehouse = Base<string>;
