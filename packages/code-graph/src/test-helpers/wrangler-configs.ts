// Wrangler configs as text, so a test can write one the way a hand edit leaves it. Every name is
// made up: `auth` and `api` call each other, `search` and `mailer` call each other.

const lines = (...source: string[]): string => `${source.join("\n")}\n`;

export const BOM = String.fromCharCode(0xfeff);

export type ConfigCase = { readonly name: string; readonly text: string };

export const API_CONFIG = lines(
  "{",
  '  "name": "api",',
  '  "d1_databases": [{ "binding": "DB" }],',
  '  "services": [{ "binding": "AUTH", "service": "auth" }]',
  "}",
);

export const MAILER_CONFIG = lines(
  "{",
  '  "name": "mailer",',
  '  "services": [{ "binding": "SEARCH", "service": "search" }]',
  "}",
);

// What wrangler accepts and a strict JSON reader would not: a leading BOM, a line comment, a block
// comment, and a trailing comma after the last property of the object and of the `services` array.
export const SEARCH_CONFIG = `${BOM}${lines(
  "// the search worker",
  "{",
  "  /* its name is its directory */",
  '  "name": "search",',
  '  "services": [{ "binding": "MAILER", "service": "mailer" },],',
  "}",
)}`;

const authOf = (...properties: string[]): string =>
  lines("{", ...properties.map((property) => `  ${property}`), "}");

const d1Of = (entry: string): string => `"d1_databases": [ ${entry} ],`;
const SERVICES = '"services": [{ "binding": "API", "service": "api" }]';

export const AUTH_CONFIG = authOf('"name": "auth",', d1Of('{ "binding": "DB" }'), SERVICES);
export const AUTH_UNCLOSED = authOf('"name": "auth",', d1Of('{ "binding": "DB"'), SERVICES);

// The five ways a hand edit leaves a syntax error in the middle of `auth`'s config. The reader used
// to repair each one into an object and call it parsed.
export const MID_FILE_ERRORS: readonly ConfigCase[] = [
  {
    name: "an object left unclosed before later keys",
    text: AUTH_UNCLOSED,
  },
  {
    name: "a stray token between two properties",
    text: authOf('"name": "auth",', "stray", d1Of('{ "binding": "DB" }'), SERVICES),
  },
  {
    name: "a missing comma between two properties",
    text: authOf('"name": "auth"', d1Of('{ "binding": "DB" }'), SERVICES),
  },
  {
    name: "a file cut off mid-array",
    text: '{\n  "name": "auth",\n  "services": [{ "binding": "API", "service": "api" },\n',
  },
  {
    name: "an unquoted value",
    text: authOf('"name": "auth",', '"main": src/index.ts,', d1Of('{ "binding": "DB" }'), SERVICES),
  },
];
