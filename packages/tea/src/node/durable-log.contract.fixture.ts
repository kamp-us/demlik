import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import type { Journal } from "../internal/journal";
import { cacheContract } from "../internal/persistence/cache-contract.fixture";
import {
  type CodecDriver,
  codecContract,
} from "../internal/persistence/durable-codec.fixture";
import {
  crashContract,
  type Driver,
} from "../internal/persistence/durable-host.fixture";
import {
  type ReceiptDriver,
  receiptContract,
} from "../internal/persistence/durable-receipts.fixture";
import {
  type FixtureJournal,
  journalStorage,
} from "../internal/persistence/durable-store.fixture";
import {
  liveEqualsWake,
  type WakeDriver,
} from "../internal/persistence/durable-wake.fixture";
import { fileJournal } from "./index";
import { sqliteJournal } from "./turn-journal.fixture";

export function durableLogContracts(
  engine: string,
  drivers: {
    crash: Driver;
    wake: WakeDriver;
    codec: CodecDriver;
    receipt: ReceiptDriver;
  },
  cacheChecks = false,
): void {
  for (const kind of ["file", "fileFenced", "sqlite"] as const) {
    const make = (): FixtureJournal => {
      const dir = mkdtempSync(join(tmpdir(), "tea-durable-contract-"));
      return {
        open: () =>
          kind === "sqlite"
            ? sqliteJournal(join(dir, "journal.db"), () => {})
            : kind === "fileFenced"
              ? fileJournal(dir, { fenced: true })
              : fileJournal(dir),
        dispose: () => rmSync(dir, { recursive: true, force: true }),
      };
    };
    const storage = journalStorage(make, { fenced: kind === "fileFenced" });
    describe(
      `${kind} ${engine} durable contracts`,
      { timeout: 480_000 },
      () => {
        crashContract(engine, drivers.crash, storage, {
          batches: 1,
          scripts: 10,
          messages: 200,
          sweepMessages: 12,
        });
        liveEqualsWake(engine, drivers.wake, storage, 20);
        codecContract(engine, drivers.codec, storage);
        receiptContract(engine, drivers.receipt, storage);
        if (cacheChecks)
          cacheContract(
            kind,
            () => {
              const resource = make();
              const handles: Journal[] = [];
              return {
                open() {
                  const j = resource.open();
                  handles.push(j);
                  return j;
                },
                async close() {
                  for (const j of handles) await j.close();
                  resource.dispose();
                },
              };
            },
            kind === "fileFenced",
          );
      },
    );
  }
}
