type FieldBuilder = { field(config: object): unknown };
type Fields = (t: FieldBuilder) => object;
type TypeOptions = { authScopes?: object; fields: Fields };
export type Ref = { implement(options: TypeOptions): void };
export declare const builder: {
  objectRef(name: string): Ref;
  objectType(name: string, options: TypeOptions): Ref;
  objectField(ref: Ref, name: string, field: (t: FieldBuilder) => unknown): void;
  objectFields(ref: Ref, fields: Fields): void;
};

export const Project = builder.objectRef("Project");
export const Open = builder.objectRef("Open");
