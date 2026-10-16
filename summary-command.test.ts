import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import extension from './compaction';
test('summary budget command edits the effective project config without changing normal reasoning or review',async()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'rcompact-budget-command-'));
 try{
  fs.mkdirSync(path.join(cwd,'.pi'));const file=path.join(cwd,'.pi/settings.json');
  const config={defaultThinkingLevel:'medium',betterCompaction:{thinking:'inherit',verify:false,sushiBriefReasoning:true},unrelated:{keep:true}};
  fs.writeFileSync(file,JSON.stringify(config));const commands=new Map<string,any>(),notifications:any[]=[];
  extension({on:()=>()=>{},registerCommand:(name:string,c:any)=>commands.set(name,c),registerEntryRenderer:()=>{}} as any);
  const command=commands.get('rcompact');assert.ok(command);
  const ctx={cwd,thinkingLevel:'medium',ui:{notify:(...args:any[])=>notifications.push(args)}};
  const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));
  for(const value of ['2048','0','inherit']){
   await command.handler('sushibudget '+value,ctx);
   assert.deepEqual(read(),{...config,betterCompaction:{...config.betterCompaction,sushiThinkingBudget:value==='inherit'?null:Number(value)}});
   assert.equal(ctx.thinkingLevel,'medium');assert.equal(read().betterCompaction.verify,false);
  }
  const unchanged=fs.readFileSync(file,'utf8');
  for(const args of ['sushibudget','sushibudget -1','sushibudget 1.2','sushibudget NaN','sushibudget 2048 extra','sushibudget 9007199254740992']){
   await command.handler(args,ctx);assert.equal(fs.readFileSync(file,'utf8'),unchanged);assert.equal(notifications.at(-1)[1],'error');
  }
 }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});

test('config writes stage then rename, so an interrupted save cannot truncate settings.json',async()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'rcompact-settings-write-'));
 try{
  fs.mkdirSync(path.join(cwd,'.pi'));const file=path.join(cwd,'.pi/settings.json');
  const config={defaultThinkingLevel:'medium',betterCompaction:{thinking:'inherit'},unrelated:{keep:true}};
  fs.writeFileSync(file,JSON.stringify(config),{mode:0o644});
  const commands=new Map<string,any>(),notifications:any[]=[];
  extension({on:()=>()=>{},registerCommand:(name:string,c:any)=>commands.set(name,c),registerEntryRenderer:()=>{}} as any);
  const ctx={cwd,thinkingLevel:'medium',ui:{notify:(...args:any[])=>notifications.push(args)}};
  const command=commands.get('rcompact');assert.ok(command);
  await command.handler('sushibudget 4096',ctx);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).betterCompaction.sushiThinkingBudget,4096);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).unrelated,{keep:true},'unrelated settings survive');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`,'utf8')),config,'the previous bytes stay recoverable');
  assert.deepEqual(fs.readdirSync(path.join(cwd,'.pi')).sort(),['settings.json','settings.json.bak'],'no staging debris is left behind');
  assert.equal(fs.statSync(file).mode&0o777,0o644,'must not silently retighten a file the user owns');
  // A second write replaces the single backup rather than accumulating generations.
  await command.handler('sushibudget 2048',ctx);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`,'utf8')).betterCompaction.sushiThinkingBudget,4096);
  assert.deepEqual(fs.readdirSync(path.join(cwd,'.pi')).filter(n=>n.endsWith('.bak')),['settings.json.bak']);
 }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
