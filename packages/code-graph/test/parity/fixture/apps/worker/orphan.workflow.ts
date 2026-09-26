import { db, WorkflowEntrypoint } from "./platform";

export function persistOrphan(): void {
  db.insert("t");
}

export class OrphanWorkflow extends WorkflowEntrypoint {
  async run(): Promise<void> {
    persistOrphan();
  }
}
