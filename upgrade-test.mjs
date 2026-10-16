import fs from 'node:fs';
import {ID} from './test-identifiers.mjs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {findPiRoot} from './pi-root.mjs';
const here=path.dirname(new URL(import.meta.url).pathname);
const root=findPiRoot();
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rcompact-pi-update-'));
const agent=path.join(tmp,'agent');
const packageDir=path.join(agent,'local-extensions/rcompact');
const loader=path.join(agent,'extensions/rcompact.ts');
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// Every runtime file the auto-discovery loader pulls in. One list, used both to
// stage the temp agent dir and to hash it, so the two cannot drift.
// Derived, not hardcoded: a new runtime module must never be able to make a
// Pi-reinstall run die with "Cannot find module".
const extFiles=fs.readdirSync(here).filter(name=>name.endsWith('.ts')&&!name.endsWith('.test.ts')).sort();
try {
 fs.mkdirSync(packageDir,{recursive:true});fs.mkdirSync(path.dirname(loader));
 for(const file of extFiles)fs.copyFileSync(path.join(here,file),path.join(packageDir,file));
 fs.writeFileSync(loader,'export { default } from "../local-extensions/rcompact/compaction";\n');
 const files=[loader,...extFiles.map(name=>path.join(packageDir,name))];
 const before=files.map(hash);
 const run=runtime=>{
// The integration suite spawns real inference against the loopback fixture and
// grew when the cache-miss loop was added; the old 45s budget clipped it.
  const result=spawnSync(process.execPath,[path.join(here,'integration-test.mjs')],{env:{...process.env,PI_TEST_ROOT:runtime,COMPACTION_SOURCE:loader},encoding:'utf8',timeout:300000,maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 };
 run(root);
 // Simulate removing the npm runtime and reinstalling it at a new Node path.
 // This tests location independence using today's actual Pi version, not a
 // claim that an unpublished future API has already been tested.
 const replaced=path.join(tmp,'node-reinstalled/lib/node_modules/@earendil-works/pi-coding-agent');
 fs.mkdirSync(replaced,{recursive:true});
 fs.copyFileSync(path.join(root,'package.json'),path.join(replaced,'package.json'));
 fs.cpSync(path.join(root,'dist'),path.join(replaced,'dist'),{recursive:true});
 fs.symlinkSync(path.join(root,'node_modules'),path.join(replaced,'node_modules'),'dir');
 run(replaced);
 assert.deepEqual(files.map(hash),before,'Runtime replacement must preserve external extension files');
 console.log('PASS: external auto-discovery loader works before/after Pi runtime reinstall at a different path; full SDK integration succeeds; extension files unchanged. Same released Pi version; no production writes.');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
