import fs from 'node:fs';
import {ID} from './test-identifiers.mjs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {findPiRoot} from './pi-root.mjs';
const here=path.dirname(new URL(import.meta.url).pathname),root=findPiRoot(),production=path.join(os.homedir(),'.pi/agent');
const status=await fetch('http://127.0.0.1:8000/status').then(r=>r.json());
if(status.idle_controller.active_requests!==0){console.log('DEFER: production Pi is currently using Splash.');process.exit(75);}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rcompact-headroom-live-')),agentDir=path.join(tmp,'agent');fs.mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR=agentDir;
const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime}=await import(root+'/dist/index.js');
const cfg=JSON.parse(fs.readFileSync(path.join(production,'settings.json')));
fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...cfg,packages:[],compaction:{enabled:false,reserveTokens:32768,keepRecentTokens:256},betterCompaction:{...cfg.betterCompaction,enabled:true,verify:false},retry:{enabled:false,provider:{timeoutMs:180000,maxRetries:0}}}));
const guard=path.join(tmp,'no-tools.ts');fs.writeFileSync(guard,`export default function(pi){pi.on('tool_call',()=>({block:true,reason:'Isolated compaction test; no tools'}));}`);
const settings=SettingsManager.create(tmp,agentDir),loader=new DefaultResourceLoader({cwd:tmp,agentDir,settingsManager:settings,additionalExtensionPaths:[path.join(here,'compaction.ts'),guard],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
const runtime=await ModelRuntime.create({authPath:path.join(production,'auth.json'),modelsPath:path.join(production,'models.json'),modelsStorePath:path.join(tmp,'models-store.json'),refreshOnCreate:false});
const model=runtime.getModel('splash',cfg.defaultModel),manager=SessionManager.inMemory(tmp);
const facts='Verified jump speed 17, checkpoint x=3460, boss HP=6, five unresolved failures. Exact error: rows.map is not a function. Next command: node dev/run-smokes.js. Collision timing is UNVERIFIED. No commits.';
for(let i=0;i<4;i++){
 manager.appendMessage({role:'user',content:'Historical observation '+i+'. '+facts+' No new verified changes. '.repeat(30),timestamp:Date.now()-10000+i});
 manager.appendMessage({role:'assistant',content:[{type:'text',text:'Five failures remain; no verified fix.'}],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()-9000+i});
}
const {session}=await createAgentSession({cwd:tmp,agentDir,settingsManager:settings,resourceLoader:loader,sessionManager:manager,modelRuntime:runtime,model,thinkingLevel:'medium'});
const errors=[];let tools=0;session.subscribe(e=>{if(e.type==='extension_error')errors.push(e);if(e.type==='tool_execution_start')tools++;});
const report={startedAt:new Date().toISOString(),model:model.id,extensionVersion:JSON.parse(fs.readFileSync(path.join(here,'package.json'))).version,isolatedSession:true,review:false};
const timed=async(fn)=>{const t=performance.now();const value=await fn();return {seconds:(performance.now()-t)/1000,value};};
try{
 console.log('Normal request');const normal=await timed(()=>session.prompt('Synthetic validation only. '+facts+' Do not call tools. Reply only ACK.'));
 const answer=session.messages.filter(m=>m.role==='assistant').at(-1);assert.equal(answer.stopReason,'stop');report.normalSeconds=normal.seconds;report.normalUsage=answer.usage;
 console.log('Compaction');const compact=await timed(()=>session.compact('Keep the summary under 150 words. Preserve exact constants, five unresolved failures, error, next command, and unverified collision timing. Do not claim a fix.'));
 assert.equal(compact.value.details.cacheStrategy,'captured-request','Native tokenizer measurement must agree with ordinary provider usage for confirmation');
 assert.equal(compact.value.details.verification.status,'disabled');
 for(const value of ['17','3460','6','rows.map is not a function','node dev/run-smokes.js'])assert.ok(compact.value.summary.includes(value),'Lost '+value);
 assert.match(compact.value.summary,/unverified|unconfirmed|hypothes/i);assert.match(compact.value.summary,/\b5\b|five/i);
 report.compactionSeconds=compact.seconds;report.compactionUsage=compact.value.usage;report.cachePercent=100*compact.value.usage.cacheRead/(compact.value.usage.input+compact.value.usage.cacheRead);
 console.log('Follow-up request');const follow=await timed(()=>session.prompt('From the checkpoint, state jump speed, checkpoint x, boss HP and number of unresolved failures in one sentence. No tools.'));
 const followAnswer=session.messages.filter(m=>m.role==='assistant').at(-1);assert.equal(followAnswer.stopReason,'stop');const text=followAnswer.content.filter(b=>b.type==='text').map(b=>b.text).join('');
 for(const value of ['17','3460','6'])assert.ok(text.includes(value),text);assert.match(text,/\b5\b|five/i);
 report.followupSeconds=follow.seconds;report.followupUsage=followAnswer.usage;assert.equal(tools,0);assert.deepEqual(errors,[]);
 const records=fs.readdirSync(path.join(agentDir,ID.TELEMETRY_DIRECTORY)).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(agentDir,ID.TELEMETRY_DIRECTORY,n))));
 assert.equal(records.filter(r=>r.status==='completed').length,1);assert.ok(records.every(r=>r.extensionVersion===report.extensionVersion));assert.equal(records.at(-1).verificationStatus,'disabled');
 report.passed=true;report.completedAt=new Date().toISOString();
}catch(error){report.error=String(error);throw error;}
finally{fs.writeFileSync(path.join(here,'headroom-live-results.json'),JSON.stringify(report,null,2)+'\n');session.dispose();fs.rmSync(tmp,{recursive:true,force:true});}
console.log(JSON.stringify(report));
