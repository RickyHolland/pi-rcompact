import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {VERSION} from './version';

test('the version in package.json and the version the code reports cannot drift apart',()=>{
 const pkg=JSON.parse(fs.readFileSync(new URL('./package.json',import.meta.url),'utf8'));
 assert.equal(pkg.version,VERSION);
});

test('compaction-telemetry has no private version literal of its own',()=>{
 const source=fs.readFileSync(new URL('./compaction-telemetry.ts',import.meta.url),'utf8');
 assert.match(source,/from ['"]\.\/version['"]/);
 assert.doesNotMatch(source,/VERSION\s*=\s*['"]\d/,'a second hardcoded version is how 1.2.8 kept reporting itself');
});

test('every runtime module is packaged, not just the ones that existed when files was written',()=>{
 const pkg=JSON.parse(fs.readFileSync(new URL('./package.json',import.meta.url),'utf8'));
 const listed=new Set(pkg.files||[]);
 const missing=fs.readdirSync(new URL('.',import.meta.url).pathname)
  .filter(f=>f.endsWith('.ts')&&!f.endsWith('.test.ts')&&!listed.has(f));
 assert.deepEqual(missing,[],'an unlisted module is absent from the published tarball, so installs break on import');
});
