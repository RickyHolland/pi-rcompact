/**
 * Shared marker for the integration suites.
 *
 * The review sentinel lives in summary-verification.ts and is deliberately asserted
 * exactly rather than by a looser substring: the revision ask also mentions an
 * "EVIDENCE REVIEW", so a prefix-free match would classify it as a review request.
 * Reading it from the source keeps the suites honest if the wording changes again.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./summary-verification.ts", import.meta.url)), "utf8");
const match = source.match(/VERIFICATION_MARKER\s*=\s*"([^"]+)"/);
if (!match) throw new Error("Could not read VERIFICATION_MARKER from summary-verification.ts");
export const MARKER = match[1];
