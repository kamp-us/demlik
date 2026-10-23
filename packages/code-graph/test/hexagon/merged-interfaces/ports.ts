type ForRead = () => string;
type ForSave = (value: string) => void;
type Base = { count: number };
export interface Storage { read: ForRead }
export interface Storage extends Base { save: ForSave }
export type Warehouse = Storage & { fresh: boolean };
