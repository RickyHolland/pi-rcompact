import {createRequire} from 'node:module';
import {findPiRoot} from './pi-root.mjs';
const root=findPiRoot();
const require=createRequire(root+'/package.json');
const {createJiti}=require('jiti');
const jiti=createJiti(import.meta.url,{moduleCache:false,alias:{
  'bun:test':new URL('./node-test-shim.mjs',import.meta.url).pathname,
  '@earendil-works/pi-ai/compat':root+'/node_modules/@earendil-works/pi-ai/dist/compat.js',
  '@earendil-works/pi-ai':root+'/node_modules/@earendil-works/pi-ai/dist/compat.js',
  '@earendil-works/pi-coding-agent':root+'/dist/index.js',
  '@earendil-works/pi-tui':root+'/node_modules/@earendil-works/pi-tui/dist/index.js',
}});
await jiti.import(new URL('./candidate.test.ts',import.meta.url).pathname);

await jiti.import(new URL('./snapshot.test.ts',import.meta.url).pathname);
await jiti.import(new URL('./capture.test.ts',import.meta.url).pathname);
await jiti.import(new URL('./dispatcher.test.ts',import.meta.url).pathname);
await jiti.import(new URL('./telemetry.test.ts',import.meta.url).pathname);

await jiti.import(new URL('./verification.test.ts',import.meta.url).pathname);
await jiti.import(new URL('./report.test.ts',import.meta.url).pathname);

await jiti.import(new URL('./headroom.test.ts',import.meta.url).pathname);
await jiti.import(new URL('./provider-errors.test.ts',import.meta.url).pathname);

await jiti.import(new URL('./summary-thinking.test.ts',import.meta.url).pathname);

await jiti.import(new URL('./summary-recovery.test.ts',import.meta.url).pathname);

await jiti.import(new URL('./summary-command.test.ts',import.meta.url).pathname);

await jiti.import(new URL('./cache-outcome.test.ts',import.meta.url).pathname);
await jiti.import(new URL('./recall-archive.test.ts',import.meta.url).pathname);

// Auto-discovery: a new *.test.ts must never be able to sit unrun again (this
// exact omission was a known trap in this harness). Already-imported files are
// skipped so ordering stays deterministic.
{
	const fs = await import('node:fs');
	const path = await import('node:path');
	const here = path.dirname(new URL(import.meta.url).pathname);
	const seen = new Set(['candidate.test.ts','snapshot.test.ts','capture.test.ts','dispatcher.test.ts','telemetry.test.ts','verification.test.ts','report.test.ts','headroom.test.ts','provider-errors.test.ts','summary-thinking.test.ts','summary-recovery.test.ts','summary-command.test.ts','cache-outcome.test.ts','recall-archive.test.ts']);
	for (const file of fs.readdirSync(here).filter((n)=>n.endsWith('.test.ts')).sort()) {
		if (seen.has(file)) continue;
		seen.add(file);
		await jiti.import(path.join(here, file));
	}
}
