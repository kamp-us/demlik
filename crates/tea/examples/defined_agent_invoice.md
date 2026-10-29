# Run the invoice Agent

From the Rust workspace root, use Rust 1.99 or newer:

```sh
mkdir -p target
cargo run -p demlik-tea --example defined_agent_invoice > target/invoice-trace.jsonl
cat target/defined-agent-invoice/complete/report.txt
```

The report contains `invoice-17: 17`. The program uses a controlled model and real file handlers. It also runs the raw machine route, two retained-state restarts, a completed-store restart and a declared validation failure. Each JSONL row contains that job's actual prompts, events, hooks and saved states.

To choose a separate output directory, pass it after `--`:

```sh
cargo run -p demlik-tea --example defined_agent_invoice -- target/my-invoice-run
```

To compare against the frozen TypeScript implementation, install the workspace JavaScript dependencies and use Node 22.21.1:

```sh
node --input-type=module <<'JS'
import { definedAgentCheckpointParity } from './verification/parity/defined-agent-parity.mjs';
const report = definedAgentCheckpointParity('cargo');
console.log({ cases: report.cases, qualified: report.qualifiedPassed, failures: report.failures });
JS
```

Expect six jobs, nine phases and no comparison failures. The report records one explicit interface qualification: TypeScript wraps the supplied host context; Rust exposes the original application host as `ToolContext.host`. All saved JSON strings, prompts, events, hooks, final states and report files are compared independently of that qualification.

These jobs use serial tools and retained in-process state. Decoded cold restart, streaming, provider failures and the remaining Agent configuration profiles still require their own verification.
