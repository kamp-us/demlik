export type ForReceiving = (pallet: string) => Promise<void>;
export type ForShelving = (pallet: string, bay: string) => Promise<void>;
export type ForPersisting = (pallet: string) => Promise<void>;

export type Receiving = { receive: ForReceiving };
export type Shelving = { shelve: ForShelving };
export type Warehousing = Receiving | Shelving;
export type WarehousingDriven = { persist: ForPersisting };
