type ForRead = () => string;
export type Warehouse = {
  [key: string]: ForRead;
};
