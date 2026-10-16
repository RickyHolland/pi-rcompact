/**
 * Identifier mirror for the .mjs integration suites.
 *
 * The suites assert on persisted identifier values, so they must read the same
 * strings the extension writes. Parsing identifiers.ts keeps a single source of
 * truth without making the suites depend on a TypeScript import path.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./identifiers.ts", import.meta.url)), "utf8");

function declared(name) {
  const match = source.match(new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`));
  if (!match) throw new Error(`Could not read ${name} from identifiers.ts`);
  return match[1];
}

export const ID = {
  STRATEGY: declared("STRATEGY"),
  REPORT_ENTRY: declared("REPORT_ENTRY"),
  REVIEW_ENTRY: declared("REVIEW_ENTRY"),
  TELEMETRY_DIRECTORY: declared("TELEMETRY_DIRECTORY"),
};
