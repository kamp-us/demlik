import { fileJournal } from "@demlik/tea/node";
import { committedView, fixturePorts, verifyCase } from "./fixture";
import { type CaseHost, type CaseJournal, openCase } from "./host";

const [directory, mode] = process.argv.slice(2);
if (!directory || (mode !== "crash" && mode !== "resume"))
  throw new Error("expected directory and crash|resume");
const backing = fileJournal(directory);
let host: CaseHost | undefined;
const journal: CaseJournal = {
  ...backing,
  async append(stream, records) {
    const result = await backing.append(stream, records);
    if (mode === "crash" && result._tag === "appended" && result.head === 2) {
      if (!host) throw new Error("host not booted");
      process.send?.({
        kind: "committed",
        seq: result.head,
        published: committedView(host).revision,
      });
      await new Promise<void>(() => {});
    }
    return result;
  },
};
host = await openCase(journal, "investigation-593", fixturePorts());
if (mode === "crash") await host.start();
else {
  await host.resume();
  const view = verifyCase(host);
  await host.stop();
  process.send?.({ kind: "recovered", view });
  process.disconnect?.();
}
