export declare class WorkerEntrypoint<E> { env: E }
export declare class WorkflowEntrypoint { }
export type Workflow = {
  create(options: { params: object }): Promise<{ id: string }>;
  get(id: string): Promise<unknown>;
};
export { db } from "drizzle-orm";
