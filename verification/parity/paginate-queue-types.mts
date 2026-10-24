import {
  initPaginator,
  type PaginatorPolicy,
  recordPage,
} from "../../packages/tea/src/internal/paginate/paginator/index.ts";
import { queueAdapter } from "../../packages/tea/src/internal/work-queue/adapter.ts";
import {
  createQueue,
  type QueueItem,
} from "../../packages/tea/src/internal/work-queue/index.ts";
import { enqueueOp } from "../../packages/tea/src/internal/work-queue/ops.ts";
import { memoryStore } from "../../packages/tea/src/mem/index.ts";

const policy: PaginatorPolicy<string> = {
  firstCursor: "first",
  highWaterMark: 3,
};
recordPage(initPaginator<string>(), 2, "next", policy);
// @ts-expect-error Cursor type stays tied to the paginator and policy.
recordPage(initPaginator<string>(), 2, 17, policy);
const adapter = queueAdapter<{ url: string }>();
adapter.enqueue([], { url: "/page" }, 0, "id");
// @ts-expect-error A queue keeps its input payload type.
adapter.enqueue([], { wrong: true }, 0, "id");
const item = enqueueOp([], { url: "/page" }, 0, "id").item;
// @ts-expect-error A persisted item is readonly.
item.status = "failed";
const queue = createQueue(memoryStore<QueueItem<{ url: string }>[]>());
queue.bindOutput("id", "trace");
// @ts-expect-error Correlation output is text rather than a structured record.
queue.bindOutput("id", { trace: 1 });
