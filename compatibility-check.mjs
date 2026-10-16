import {spawnSync} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {findPiRoot} from './pi-root.mjs';
const here=path.dirname(new URL(import.meta.url).pathname);
const root=findPiRoot();
let count;
for(const [file,extra] of [['typecheck.mjs',{}],['run-tests.mjs',{}],['integration-test.mjs',{}],['integration-test.mjs',{HOOK_ORDER:'before'}],['budget-integration.mjs',{}],['budget-integration.mjs',{HOOK_ORDER:'before'}],['normal-recovery-integration.mjs',{}],['normal-recovery-integration.mjs',{HOOK_ORDER:'before'}],['headroom-integration.mjs',{}],['upgrade-test.mjs',{}],['screenshot-integration.mjs',{}]]) {
  const result=spawnSync(process.execPath,[path.join(here,file)],{env:{...process.env,PI_TEST_ROOT:root,...extra},encoding:'utf8',timeout:300000,maxBuffer:1024*1024});
  if(file==='run-tests.mjs') count=result.stdout.match(/tests\s+(\d+)/)?.[1];
  if(result.status!==0) {process.stderr.write(result.stderr??'');process.stdout.write(result.stdout??'');process.stderr.write(`Compatibility check failed: ${file}\n`);process.exit(1)}
}
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
console.log(`rcompact: PASS on Pi ${version}; ${count??"Unknown count of"} regression checks plus real SDK integration in both hook orders, final headroom, bounded summary and normal-turn recovery integration, a runtime-reinstall simulation, and screenshot-heavy SDK compaction/reload. No inference or production writes.`);
