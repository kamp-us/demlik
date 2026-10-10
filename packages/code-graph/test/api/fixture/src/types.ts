export type Alias = { readonly id: string };

interface Corner {
  readonly x: number;
  readonly y: number;
}

/** A shape. */
export interface Shape {
  readonly side: number;
  readonly corner: Corner; // private, so its text rides on Shape
}
