/**
 * Single source of truth for the version this extension reports — in the
 * request-source label, `/rcompact` status, the doctor output, and every
 * telemetry record. Kept in its own module so no subsystem has to import
 * another to agree on it; `version.test.ts` fails the suite if package.json
 * drifts away from it.
 */
export const VERSION = "1.0.4";
