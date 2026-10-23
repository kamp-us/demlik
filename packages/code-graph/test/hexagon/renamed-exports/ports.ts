type ForRead = () => string;
type ForSave = (value: string) => void;
type In = { read: ForRead };
type Out = { save: ForSave };
export type { In as Warehouse, Out as WarehouseDriven };
