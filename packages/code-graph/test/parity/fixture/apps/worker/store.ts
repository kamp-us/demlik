import { type Workflow, WorkerEntrypoint } from "./platform";

type Env = { SCAN_WORKFLOW: Workflow; ORPHAN_WORKFLOW: Workflow };

export class Store extends WorkerEntrypoint<Env> {
  async startScan(): Promise<void> {
    await this.env.SCAN_WORKFLOW.create({ params: {} });
  }

  async inspectOrphan(): Promise<void> {
    await this.env.ORPHAN_WORKFLOW.get("instance");
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.url.endsWith("/scan")) await new Store().startScan();
    return new Response("ok");
  },
};
