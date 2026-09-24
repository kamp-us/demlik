/**
 * The Langfuse recipe's compile gate (#331).
 *
 * `docs/how-to/trace-an-agent-run-in-langfuse.md` hands the reader the wiring
 * to paste. It lives HERE as real TypeScript in the test program
 * (`tsconfig.test.json`, gated in CI as `typecheck:test`), and the test below
 * asserts each of the page's `ts` blocks is one of this file's regions
 * verbatim — so the page cannot drift from code that compiles against
 * `@langfuse/otel`'s real `LangfuseSpanProcessor`.
 *
 * `@langfuse/otel` is a devDependency and only this file imports it. tea's
 * `dependencies`, its peers and its export map name no Langfuse package: the
 * link to Langfuse is the attributes `@demlik/tea/otel` writes, and this page.
 */

// biome-ignore-all assist/source/organizeImports: the region markers below pin
// import blocks the page reproduces verbatim; sorting the harness's imports into
// them would move a marker and break the assertion this file is.
// biome-ignore-all lint/suspicious/noExportsInTest: the regions are the artifact
// under test, and they export because the reader pastes them as a module.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectPageMirrors, regionMirror } from "../page-mirrors";
import { defineAgent } from "@demlik/tea/agent";

// #region provider
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { maskBase64DataUris } from "@demlik/tea/otel";

/**
 * A tracer whose spans go to Langfuse. The processor reads
 * `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` from
 * the environment. Build it once per process and share it.
 */
export function langfuseTracing(name: string) {
  const processor = new LangfuseSpanProcessor({ mask: maskBase64DataUris });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  return {
    tracer: provider.getTracer(name),
    flush: () => processor.forceFlush(),
  };
}
// #endregion provider

// #region runtime
import { type AgentEventSource, traceAgent } from "@demlik/tea/otel";

/**
 * Trace every run a runtime drives. `runtime` is one built with
 * `events: agentEvents()`. Returns the cleanup that detaches the tracer.
 */
export function traced<R>(
  runtime: AgentEventSource<R>,
  langfuse: ReturnType<typeof langfuseTracing>,
): () => void {
  return traceAgent(runtime, { tracer: langfuse.tracer, name: "audit-agent" });
}
// #endregion runtime

// The tutorial's agent, cut down to what the `lid` region needs to compile.
const agent = defineAgent({
  model: async () => ({ content: "done", toolCalls: [] }),
  tools: [],
  instructions: "Put red, yellow and blue in the notebook, then finish.",
});

// #region lid
import { agentSpans } from "@demlik/tea/otel";

const langfuse = langfuseTracing("notebook-agent");

export async function runTraced(input: string) {
  const spans = agentSpans({ tracer: langfuse.tracer, name: "notebook-agent" });
  try {
    return await agent.run(input, { onEvent: spans.onEvent });
  } finally {
    // A run that threw leaves its spans open; end them so they export.
    spans.end();
    // The processor batches. Flush before a serverless handler returns.
    await langfuse.flush();
  }
}
// #endregion lid

const page = fileURLToPath(
  new URL(
    "../../../docs/how-to/trace-an-agent-run-in-langfuse.md",
    import.meta.url,
  ),
);
const self = fileURLToPath(import.meta.url);

/** A region of this file, which the page shows as one block. */
const region = (name: string) => regionMirror(self, name);

describe("docs/how-to/trace-an-agent-run-in-langfuse.md (#331)", () => {
  it("shows every compiled region verbatim, so the recipe cannot rot", async () => {
    await expectPageMirrors(page, ["provider", "runtime", "lid"].map(region));
  });

  it("says any OTel backend works", async () => {
    const markdown = await readFile(page, "utf8");
    expect(markdown).toContain("Any OpenTelemetry backend");
  });
});
