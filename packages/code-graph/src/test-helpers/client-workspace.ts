import { shopManifests } from "./shop-workspace.js";

// A generated workspace of three client apps that import one service contract directly, for the
// allowance test. `packages/orders-contract` holds a wire format a client produces (`OrderDraft`,
// `encodeOrderDraft`) and a vocabulary the API also publishes (`OrderStatus`, `ORDER_STATUSES`)
// behind one entry point. Each app holds 100 files that import it and 100 that import
// `packages/billing-contract`, and the three apps write the same imports: the mobile and console apps
// are licensed the wire format, and the assistant app nothing.

const ORDERS = "packages/orders-contract";
const BILLING = "packages/billing-contract";
const SPECIFIER = "@shop/orders-contract";
const APPS = ["apps/mobile", "apps/console", "apps/assistant"];
const LICENSED = ["OrderDraft", "encodeOrderDraft"];
const FILES = 100;
// The first sixty files of an app take only the wire format, and the last forty take `OrderStatus`.
const WIRE_FILES = 60;

const TYPES = {
  "api-contract": { imports: [], pure: true },
  contract: { imports: ["contract"], pure: true },
  client: { imports: ["contract"], pure: false },
};

const LIBRARIES = {
  [ORDERS]: "api-contract",
  [BILLING]: "contract",
  "apps/mobile": "client",
  "apps/console": "client",
  "apps/assistant": "client",
};

const lines = (...source: string[]): string => `${source.join("\n")}\n`;
const pad = (n: number): string => String(n).padStart(3, "0");

const WIRE_FORMS: readonly ((n: number) => string)[] = [
  () => `import { OrderDraft } from "${SPECIFIER}";`,
  () => `import { encodeOrderDraft } from "${SPECIFIER}";`,
  () => `import { OrderDraft, encodeOrderDraft } from "${SPECIFIER}";`,
  (n) => `import { OrderDraft as Draft${n} } from "${SPECIFIER}";`,
  () => `import type { OrderDraft } from "${SPECIFIER}";`,
  () => `export { OrderDraft } from "${SPECIFIER}";`,
];

export type StatusKind = "value" | "type-only" | "namespace" | "re-export";

// The forty files that take `OrderStatus`: thirty as a value (a third of them beside a licensed
// name), five as `import type`, three as a namespace and two as a re-export.
function statusForm(n: number): { readonly kind: StatusKind; readonly source: string } {
  if (n < 30) {
    const names = n % 3 === 0 ? "OrderStatus, encodeOrderDraft" : "OrderStatus";
    return { kind: "value", source: `import { ${names} } from "${SPECIFIER}";` };
  }
  if (n < 35) {
    return { kind: "type-only", source: `import type { OrderStatus } from "${SPECIFIER}";` };
  }
  if (n < 38) {
    return { kind: "namespace", source: `import * as orders from "${SPECIFIER}";` };
  }
  return { kind: "re-export", source: `export { OrderStatus } from "${SPECIFIER}";` };
}

export type ClientWorkspace = {
  readonly files: Readonly<Record<string, string>>;
  readonly rules: Readonly<Record<string, unknown>>;
  // The same rules with `OrderStatus` licensed to the mobile app as well.
  readonly rulesLicensingStatus: Readonly<Record<string, unknown>>;
  // Every file the rules cross, repo-relative: the last forty of the mobile and console apps and all
  // of the assistant app's hundred.
  readonly crossing: readonly string[];
  // The mobile app's forty files that take `OrderStatus`, by how.
  readonly mobileStatus: Readonly<Record<StatusKind, readonly string[]>>;
};

function rulesLicensing(mobile: readonly string[]): Record<string, unknown> {
  return {
    libraryTypes: TYPES,
    libraries: LIBRARIES,
    allowImportNames: {
      "apps/mobile": { [ORDERS]: mobile },
      "apps/console": { [ORDERS]: LICENSED },
    },
  };
}

export function clientWorkspace(): ClientWorkspace {
  const sources: Record<string, string> = {
    [`${ORDERS}/src/index.ts`]: lines(
      "export type OrderDraft = { readonly sku: string };",
      "export const encodeOrderDraft = (draft: OrderDraft): string => JSON.stringify(draft);",
      'export const OrderStatus = { Open: "open", Shipped: "shipped" } as const;',
      "export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];",
      "export const ORDER_STATUSES: readonly OrderStatus[] = [OrderStatus.Open, OrderStatus.Shipped];",
    ),
    [`${BILLING}/src/index.ts`]: 'export const BILLING_CURRENCY = "usd";\n',
  };
  const crossing: string[] = [];
  const mobileStatus: Record<StatusKind, string[]> = {
    value: [],
    "type-only": [],
    namespace: [],
    "re-export": [],
  };
  for (const app of APPS) {
    for (let n = 0; n < FILES; n++) {
      const file = `${app}/src/orders/o${pad(n)}.ts`;
      const status = n < WIRE_FILES ? null : statusForm(n - WIRE_FILES);
      const source = status?.source ?? WIRE_FORMS[n % WIRE_FORMS.length]?.(n) ?? "";
      sources[file] = lines(source, `export const o${n} = ${n};`);
      sources[`${app}/src/billing/b${pad(n)}.ts`] = lines(
        'import { BILLING_CURRENCY } from "@shop/billing-contract";',
        `export const b${n} = BILLING_CURRENCY;`,
      );
      if (app === "apps/assistant" || status !== null) crossing.push(file);
      if (app === "apps/mobile" && status !== null) mobileStatus[status.kind].push(file);
    }
  }
  return {
    files: { ...shopManifests([ORDERS, BILLING, ...APPS]), ...sources },
    rules: rulesLicensing(LICENSED),
    rulesLicensingStatus: rulesLicensing([...LICENSED, "OrderStatus"]),
    crossing,
    mobileStatus,
  };
}
