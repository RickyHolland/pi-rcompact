import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {findPiRoot} from './pi-root.mjs';
const here=path.dirname(new URL(import.meta.url).pathname);
const root=findPiRoot();
const compiler=path.join(here,'node_modules/typescript/lib/tsc.js');
if(!fs.existsSync(compiler)) throw new Error('Install the pinned development dependencies before typechecking: npm install --ignore-scripts --legacy-peer-deps');
const config=JSON.parse(fs.readFileSync(path.join(here,'tsconfig.json')));
config.compilerOptions.paths={
 '@earendil-works/pi-coding-agent':[path.join(root,'dist/index.d.ts')],
 '@earendil-works/pi-ai':[path.join(root,'node_modules/@earendil-works/pi-ai/dist/compat.d.ts')],
 '@earendil-works/pi-ai/compat':[path.join(root,'node_modules/@earendil-works/pi-ai/dist/compat.d.ts')],
 '@earendil-works/pi-tui':[path.join(root,'node_modules/@earendil-works/pi-tui/dist/index.d.ts')],
};
const target=path.join(here,`.typecheck-${process.pid}.json`);
try {
 fs.writeFileSync(target,JSON.stringify(config));
 const result=spawnSync(process.execPath,[compiler,'-p',target],{stdio:'inherit'});
 process.exitCode=result.status??1;
} finally {fs.unlinkSync(target)}
