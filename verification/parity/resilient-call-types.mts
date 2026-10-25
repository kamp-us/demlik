import {
  createResilientCall,
  type SucceedMsg,
} from "../../packages/tea/src/internal/resilience/resilient-call/index.ts";

function consumer() {
  const text = createResilientCall<
    { prompt: string },
    { body: string },
    "text"
  >({ name: "text" });
  const count = createResilientCall<number, number, "count">({ name: "count" });
  const command = text.run({ key: "work", input: { prompt: "hello" } });
  const success: SucceedMsg<{ body: string }, "text", { prompt: string }> = {
    type: "text_run_ok",
    cmd: command,
    value: { body: "answer" },
    at: 3,
  };
  text.settle(text.init(), success);
  // @ts-expect-error the handler's result belongs to its declared family
  count.settle(count.init(), success);
  // @ts-expect-error names and their declared family must agree
  createResilientCall<string, string, "text">({ name: "count" });
  // @ts-expect-error the command input remains precise
  text.run({ key: "work", input: 42 });
}
void consumer;
