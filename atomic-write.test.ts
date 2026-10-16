import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeFileAtomic} from './atomic-write';

test('atomic write stages a temp file and renames it, leaving no debris',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rcompact-atomic-'));
 try{
  const file=path.join(dir,'settings.json');
  writeFileAtomic(file,'{"a":1}\n');
  assert.equal(fs.readFileSync(file,'utf8'),'{"a":1}\n');
  assert.deepEqual(fs.readdirSync(dir).filter(n=>n.includes('.tmp')),[]);
  assert.equal(fs.existsSync(`${file}.bak`),false,'creating a new file has nothing to back up');
  // Mode 0600 for a file we created.
  assert.equal(fs.statSync(file).mode&0o777,0o600);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('atomic write keeps one recoverable backup of the previous bytes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rcompact-atomic-'));
 try{
  const file=path.join(dir,'settings.json');
  writeFileAtomic(file,'first\n');
  writeFileAtomic(file,'second\n');
  writeFileAtomic(file,'third\n');
  assert.equal(fs.readFileSync(file,'utf8'),'third\n');
  assert.equal(fs.readFileSync(`${file}.bak`,'utf8'),'second\n','only the newest previous contents are kept');
  assert.deepEqual(fs.readdirSync(dir).filter(n=>n.endsWith('.bak')).sort(),['settings.json.bak']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('atomic write preserves the mode of an existing file',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rcompact-atomic-'));
 try{
  const file=path.join(dir,'settings.json');
  fs.writeFileSync(file,'old\n',{mode:0o644});
  writeFileAtomic(file,'new\n');
  assert.equal(fs.statSync(file).mode&0o777,0o644,'must not silently tighten a file the user owns');
  assert.equal(fs.readFileSync(file,'utf8'),'new\n');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a failed rename leaves the previous file intact and cleans up staging',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rcompact-atomic-'));
 try{
  // A directory occupying the target path makes rename() fail (ENOTDIR/EISDIR)
  // AFTER the staged write succeeded: exactly the interrupted-write shape.
  const target=path.join(dir,'settings.json');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target,'keep-me.json'),'original\n');
  assert.throws(()=>writeFileAtomic(target,'replacement\n'));
  assert.equal(fs.readFileSync(path.join(target,'keep-me.json'),'utf8'),'original\n','nothing near the target was clobbered');
  assert.equal(fs.existsSync(`${target}.bak`),false);
  assert.deepEqual(fs.readdirSync(dir).filter(n=>n.includes('.tmp')),[],'staged file removed on failure');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('backup can be disabled for files whose contents are disposable',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rcompact-atomic-'));
 try{
  const file=path.join(dir,'record.json');
  writeFileAtomic(file,'one\n');
  writeFileAtomic(file,'two\n',{backup:false,mode:0o600});
  assert.equal(fs.existsSync(`${file}.bak`),false);
  assert.equal(fs.readFileSync(file,'utf8'),'two\n');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
