import { db, WorkflowEntrypoint } from "./platform";

export function persistScan(): void {
  db.insert("t");
}

class ScanWorkflowImpl extends WorkflowEntrypoint {
  async run(): Promise<void> {
    persistScan();
  }
}

declare function withObservability<T>(workflow: T): T;

export const ScanWorkflow = withObservability(ScanWorkflowImpl);
