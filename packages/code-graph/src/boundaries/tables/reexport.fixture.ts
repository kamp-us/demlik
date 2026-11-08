import { shopManifests } from "../../test-helpers/shop-workspace.js";

// The synthetic repo that tables reach their users through re-exports in: one scope, `services/api`,
// four features that each own tables, and the barrels between them. Every name is made up.
//
// `FORMS` is the table of every way a table is re-exported before a file uses it: one row each, with
// the barrel files it adds and the table, and the feature that owns it, where it ends. A feature that
// does not own the table reaches it three ways (a named import, a renamed import and a namespace
// member), writing it and reading it, and `shipping`'s tables file refers to it in a foreign key. The
// files and the rows the tests expect both come from these rows, so a form added is a form in every
// check. What no re-export can be followed through is `unfollowed.fixture.ts`, one file for each way.

export const API = "services/api";
export const at = (rel: string): string => `${API}/${rel}`;

export const lines = (...source: string[]): string => `${source.join("\n")}\n`;

export type Feature = "orders" | "billing" | "shipping" | "audit";
export const FEATURES: readonly Feature[] = ["orders", "billing", "shipping", "audit"];

// The tables each feature's `adapters/driven/tables.ts` declares. `orders` also exports an enum,
// which is no table.
export const OWNED: Readonly<Record<Feature, readonly string[]>> = {
  orders: ["orderLines", "orderNotes", "orders"],
  billing: ["credits", "invoices", "payments"],
  shipping: ["shipments"],
  audit: ["archived", "entries"],
};

// Where a file under `src/<feature>/adapters/driven/` finds the barrels, and a barrel finds a tables
// file.
export const BARRELS = "../../../drizzle";
export const tablesOf = (feature: Feature): string => `../${feature}/adapters/driven/tables`;

const declaration = (name: string): string =>
  `export const ${name} = pgTable("${name}", { id: text("id").primaryKey() });`;

const tablesFile = (feature: Feature): string =>
  lines(
    'import { pgEnum, pgTable, text } from "drizzle-orm/pg-core";',
    ...(feature === "orders"
      ? ['export const orderStatus = pgEnum("order_status", ["open"]);']
      : []),
    ...OWNED[feature].map(declaration),
  );

export type Style = "named" | "renamed" | "member";
export const STYLES: readonly Style[] = ["named", "renamed", "member"];

// One way a table is re-exported. `selected` is what a user selects from the barrel to reach the
// table: the name the barrel gives it, behind a namespace when the barrel re-exports one. `table` is
// the name its owner's tables file exports it under, which no hop changes.
export type Form = {
  readonly id: string;
  readonly barrels: Readonly<Record<string, string>>;
  readonly specifier: string;
  readonly selected: readonly string[];
  readonly table: string;
  readonly owner: Feature;
  readonly user: Feature;
};

export const FORMS: readonly Form[] = [
  {
    // A feature's own index.ts.
    id: "index",
    barrels: {
      "src/orders/index.ts": lines('export { orders } from "./adapters/driven/tables";'),
    },
    specifier: "../../../orders",
    selected: ["orders"],
    table: "orders",
    owner: "orders",
    user: "billing",
  },
  {
    // A barrel at the shape of Binclusive's `drizzle/schema_pg.ts`: blocks of `export { … } from`.
    id: "schema",
    barrels: {
      "src/drizzle/schema.ts": lines(
        `export { orderStatus } from "${tablesOf("orders")}";`,
        `export { invoices } from "${tablesOf("billing")}";`,
        `export { shipments } from "${tablesOf("shipping")}";`,
        `export { entries } from "${tablesOf("audit")}";`,
      ),
    },
    specifier: `${BARRELS}/schema`,
    selected: ["invoices"],
    table: "invoices",
    owner: "billing",
    user: "audit",
  },
  {
    // `export { t as u } from`: the entry and the row name `payments`, not `settlements`.
    id: "renamed",
    barrels: {
      "src/drizzle/renamed.ts": lines(
        `export { payments as settlements } from "${tablesOf("billing")}";`,
      ),
    },
    specifier: `${BARRELS}/renamed`,
    selected: ["settlements"],
    table: "payments",
    owner: "billing",
    user: "shipping",
  },
  {
    // `export * from`.
    id: "star",
    barrels: { "src/drizzle/star.ts": lines(`export * from "${tablesOf("audit")}";`) },
    specifier: `${BARRELS}/star`,
    selected: ["entries"],
    table: "entries",
    owner: "audit",
    user: "orders",
  },
  {
    // `export * as ns from`, used as `import { stock }; stock.orderNotes` and `b.stock.orderNotes`.
    id: "namespace",
    barrels: {
      "src/drizzle/namespace.ts": lines(`export * as stock from "${tablesOf("orders")}";`),
    },
    specifier: `${BARRELS}/namespace`,
    selected: ["stock", "orderNotes"],
    table: "orderNotes",
    owner: "orders",
    user: "billing",
  },
  {
    // `import { t } from …; export { t }`, which is `export { t } from …`.
    id: "imported",
    barrels: {
      "src/drizzle/imported.ts": lines(
        `import { orderLines } from "${tablesOf("orders")}";`,
        "export { orderLines };",
      ),
    },
    specifier: `${BARRELS}/imported`,
    selected: ["orderLines"],
    table: "orderLines",
    owner: "orders",
    user: "audit",
  },
  {
    // `import * as t from …; export { t }`, which is `export * as t from …`.
    id: "imported-namespace",
    barrels: {
      "src/drizzle/imported-namespace.ts": lines(
        `import * as archive from "${tablesOf("audit")}";`,
        "export { archive };",
      ),
    },
    specifier: `${BARRELS}/imported-namespace`,
    selected: ["archive", "archived"],
    table: "archived",
    owner: "audit",
    user: "shipping",
  },
  {
    // Four hops that mix the forms: a namespace re-export, a star, an imported binding re-exported
    // under another name, and the tables file. `ledger.bonuses` is `credits`.
    id: "chain",
    barrels: {
      "src/drizzle/chain-a.ts": lines('export * as ledger from "./chain-b";'),
      "src/drizzle/chain-b.ts": lines('export * from "./chain-c";'),
      "src/drizzle/chain-c.ts": lines(
        `import { credits } from "${tablesOf("billing")}";`,
        "export { credits as bonuses };",
      ),
    },
    specifier: `${BARRELS}/chain-a`,
    selected: ["ledger", "bonuses"],
    table: "credits",
    owner: "billing",
    user: "orders",
  },
];

// What a user writes to reach the table in each style: the import, and the expression that names the
// table. `alias` is the local name of a renamed import or a namespace.
const IMPORTS: Readonly<
  Record<Style, (specifier: string, selected: readonly string[], alias: string) => [string, string]>
> = {
  named: (specifier, [head = "", ...rest]) => [
    `import { ${head} } from "${specifier}";`,
    [head, ...rest].join("."),
  ],
  renamed: (specifier, [head = "", ...rest], alias) => [
    `import { ${head} as ${alias} } from "${specifier}";`,
    [alias, ...rest].join("."),
  ],
  member: (specifier, selected, alias) => [
    `import * as ${alias} from "${specifier}";`,
    [alias, ...selected].join("."),
  ],
};

const reach = (form: Form, style: Style, alias: string): [string, string] =>
  IMPORTS[style](form.specifier, form.selected, alias);

export type Way = "write" | "read";

const WAYS: Readonly<Record<Way, (table: string) => string>> = {
  write: (table) => `export const go = (db: Db) => db.insert(${table}).values({});`,
  read: (table) => `export const go = (db: Db) => db.select().from(${table});`,
};

// Where the file that reaches the table of a form in a style, writing or reading it, sits.
export const userFile = (form: Form, style: Style, way: Way): string =>
  at(`src/${form.user}/adapters/driven/${form.id}-${style}-${way}.ts`);

function usersOf(form: Form): Record<string, string> {
  const files: Record<string, string> = {};
  for (const style of STYLES) {
    for (const way of Object.keys(WAYS) as Way[]) {
      const [statement, table] = reach(form, style, style === "member" ? "barrel" : "renamed");
      files[userFile(form, style, way)] = lines(statement, WAYS[way](table));
    }
  }
  return files;
}

// The forms whose table `shipping` does not own, each as a foreign key of `shipments`, in the style
// its position picks and under a name of its own, so one file holds every form and every style.
export const FOREIGN_KEYS: readonly Form[] = FORMS.filter((form) => form.owner !== "shipping");

function shippingTables(): string {
  const keys = FOREIGN_KEYS.map((form, position) => {
    const style = STYLES[position % STYLES.length] ?? "named";
    const [statement, table] = reach(form, style, `via${position}`);
    return {
      statement,
      field: `  key${position}: text("key${position}").references(() => ${table}.id),`,
    };
  });
  return lines(
    'import { pgTable, text } from "drizzle-orm/pg-core";',
    ...keys.map((key) => key.statement),
    'export const shipments = pgTable("shipments", {',
    ...keys.map((key) => key.field),
    "});",
  );
}

export const SHIPPING_TABLES = at("src/shipping/adapters/driven/tables.ts");

// Beside the forms: one file reaching a table in three spellings, which is one entry; a circle of
// barrels with a real path beside it, and a name no chain defines; type-only re-exports; an enum; a
// feature using its own table through a barrel; and a test file.
export const TWO_SPELLINGS = at("src/billing/adapters/driven/two-spellings.ts");
export const CYCLE_WRITE = at("src/audit/adapters/driven/cycle-write.ts");
export const DIAMOND_WRITE = at("src/orders/adapters/driven/diamond-write.ts");

const BESIDE: Record<string, string> = {
  [TWO_SPELLINGS]: lines(
    'import { orders } from "../../../orders";',
    'import { orders as direct } from "../../../orders/adapters/driven/tables";',
    `import * as barrel from "${BARRELS}/namespace";`,
    "export const go = (db: Db) => [db.insert(orders), db.update(direct), db.delete(barrel.stock.orders)];",
  ),
  [at("src/drizzle/cycle-a.ts")]: lines(
    'export * from "./cycle-b";',
    `export { shipments } from "${tablesOf("shipping")}";`,
  ),
  [at("src/drizzle/cycle-b.ts")]: lines('export * from "./cycle-a";'),
  // Two stars that reach `entries` by different roads are not ambiguous: they end at one binding.
  [at("src/drizzle/diamond.ts")]: lines(
    `export * from "${tablesOf("audit")}";`,
    'export * from "./star";',
  ),
  [DIAMOND_WRITE]: lines(
    `import { entries } from "${BARRELS}/diamond";`,
    "export const go = (db: Db) => db.insert(entries);",
  ),
  [CYCLE_WRITE]: lines(
    `import { shipments } from "${BARRELS}/cycle-b";`,
    "export const go = (db: Db) => db.insert(shipments);",
  ),
  [at("src/audit/adapters/driven/cycle-ghost.ts")]: lines(
    `import { ghost } from "${BARRELS}/cycle-b";`,
    "export const go = (db: Db) => [db.insert(ghost), db.select().from(ghost)];",
  ),
  [at("src/drizzle/types.ts")]: lines(
    `export type { orders } from "${tablesOf("orders")}";`,
    `export { type orderLines } from "${tablesOf("orders")}";`,
    `export type * from "${tablesOf("billing")}";`,
  ),
  [at("src/audit/adapters/driven/type-only.ts")]: lines(
    `import { orders, orderLines, invoices } from "${BARRELS}/types";`,
    "export const go = (db: Db) => [db.insert(orders), db.insert(orderLines), db.insert(invoices)];",
  ),
  [at("src/audit/adapters/driven/enum-read.ts")]: lines(
    `import { orderStatus } from "${BARRELS}/schema";`,
    "export const open = orderStatus.enumValues;",
  ),
  [at("src/billing/adapters/driven/own.ts")]: lines(
    `import * as barrel from "${BARRELS}/schema";`,
    "export const go = (db: Db) => db.insert(barrel.invoices);",
  ),
  [at("src/billing/adapters/driven/schema-write.test.ts")]: lines(
    `import * as barrel from "${BARRELS}/schema";`,
    "export const go = (db: Db) => db.insert(barrel.shipments);",
  ),
};

export const REEXPORT_FILES: Record<string, string> = {
  ...shopManifests([API]),
  [at("src/orders/adapters/driven/tables.ts")]: tablesFile("orders"),
  [at("src/billing/adapters/driven/tables.ts")]: tablesFile("billing"),
  [at("src/audit/adapters/driven/tables.ts")]: tablesFile("audit"),
  [SHIPPING_TABLES]: shippingTables(),
  ...BESIDE,
  ...Object.assign(
    {},
    ...FORMS.map((form) => ({
      ...Object.fromEntries(Object.entries(form.barrels).map(([rel, body]) => [at(rel), body])),
      ...usersOf(form),
    })),
  ),
};

export const RULES = {
  features: { [API]: FEATURES },
  tableOwnership: ["table-declared-outside-tables", "table-written-outside-owner"],
  testFiles: ["**/*.test.ts"],
};
