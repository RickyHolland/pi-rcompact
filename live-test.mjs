import fs from 'node:fs';
import {ID} from './test-identifiers.mjs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const here=path.dirname(new URL(import.meta.url).pathname);
import {findPiRoot} from './pi-root.mjs';
const root=findPiRoot();
const production=path.join(os.homedir(),'.pi/agent');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rcompact-live-'));const agentDir=path.join(tmp,'agent');fs.mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR=agentDir;process.env.PI_MEMORY_DIR=path.join(tmp,'memory');process.env.PI_MEMORY_QMD_UPDATE='off';process.env.PI_MEMORY_EXIT_SUMMARY='0';process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS='0';process.env.PATH='/usr/bin:/bin:/usr/sbin:/sbin';
fs.mkdirSync(process.env.PI_MEMORY_DIR);fs.writeFileSync(path.join(process.env.PI_MEMORY_DIR,'MEMORY.md'),'# Synthetic fixture\nPreserve jump speed 17, checkpoint x=3460, boss HP=6, and five unresolved failures. Collision timing remains an unverified hypothesis. Do not commit or call tools.\n');
const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime}=await import(root+'/dist/index.js');
const cfg=JSON.parse(fs.readFileSync(path.join(production,'settings.json')));
fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...cfg,packages:[],extensions:[],betterCompaction:{...cfg.betterCompaction,verify:"blocking",cachePolicy:"keep"},compaction:{enabled:false,reserveTokens:8192,keepRecentTokens:1000},retry:{enabled:false,provider:{timeoutMs:900000,maxRetries:0}}}));
const guard=path.join(tmp,'live-guard.ts');fs.writeFileSync(guard,"export default function(pi){pi.on('tool_call',()=>({block:true,reason:'Isolated compaction validation; tools prohibited'}));}");
const settings=SettingsManager.create(tmp,agentDir);
const loader=new DefaultResourceLoader({cwd:tmp,agentDir,settingsManager:settings,additionalExtensionPaths:[guard,process.env.COMPACTION_SOURCE??path.join(here,'compaction.ts')],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
await loader.reload();assert.equal(loader.getExtensions().errors.length,0,JSON.stringify(loader.getExtensions().errors));
const runtime=await ModelRuntime.create({authPath:path.join(production,'auth.json'),modelsPath:path.join(production,'models.json'),modelsStorePath:path.join(tmp,'models-store.json'),refreshOnCreate:false});
const model=runtime.getModel(cfg.defaultProvider,cfg.defaultModel);assert.ok(model);
const manager=SessionManager.inMemory(tmp);let session;
const results={startedAt:new Date().toISOString(),model:model.id,extensionCount:loader.getExtensions().extensions.length,normalRequests:[],compactions:[],privateFixtureOnly:true};
const save=()=>fs.writeFileSync(process.env.COMPACTION_LIVE_RESULT??path.join(here,'live-results.json'),JSON.stringify(results,null,2)+'\n');
const normalMessage=(label)=>`Synthetic compaction fixture ${label}. Never call tools. Only answer ACK. Verified jump speed 17; checkpoint x=3460; boss HP=6; five smoke tests still fail. Exact error: rows.map is not a function. Collision timing is UNCONFIRMED. Next command: node dev/run-smokes.js. Do not commit.\n`+Array.from({length:35},(_,i)=>`Historical inspection ${label}-${i}: no new verified fix; preserve five unresolved failures; position sample ${1000+i}.`).join('\n');
try{
 const status=await fetch('http://127.0.0.1:8000/status').then(r=>r.json());assert.equal(status.idle_controller.active_requests,0,'Production is busy; defer live test');
 ({session}=await createAgentSession({cwd:tmp,agentDir,settingsManager:settings,resourceLoader:loader,sessionManager:manager,modelRuntime:runtime,model,thinkingLevel:'medium'}));
 const errors=[];results.toolsExecuted=0;session.subscribe(e=>{if(e.type==='extension_error')errors.push({event:e.event,error:e.error});if(e.type==='tool_execution_start')results.toolsExecuted++});
 for(const label of ['A','B','C']){
  const t=performance.now();console.log(JSON.stringify({phase:'normal-request',label}));await session.prompt(normalMessage(label));
  const answer=session.messages.filter(m=>m.role==='assistant').at(-1);assert.equal(answer.stopReason,'stop');assert.ok(!answer.content.some(b=>b.type==='toolCall'));
  results.latestNormalUsage=answer.usage;results.normalRequests.push({label,seconds:(performance.now()-t)/1000,usage:answer.usage});save();
 }
 for(let trial=1;trial<=2;trial++){
  console.log(JSON.stringify({phase:'compaction',trial}));const t=performance.now();
  const result=await session.compact('Keep the summary under 250 words. Preserve exact constants, five unresolved failures, the exact error and next command, and explicitly state collision timing is unverified. Do not report any fix as completed.');
  const summary=result.summary;
  assert.equal(result.details.cacheStrategy,'captured-request');assert.equal(result.details.verification.status,'passed');
  for(const token of ['17','3460','6','rows.map is not a function','node dev/run-smokes.js'])assert.ok(summary.includes(token),'Missing '+token);
  assert.match(summary,/unconfirmed|unverified|hypothes/i);assert.match(summary,/\b5\b|five/i);
  const rate=100*result.usage.cacheRead/(result.usage.input+result.usage.cacheRead);
  const precedingUsage=session.messages.filter(m=>m.role==='assistant').at(-1)?.usage;
  const normalPromptTokens=results.latestNormalUsage.input+results.latestNormalUsage.cacheRead;
  results.pendingCompaction={usage:result.usage,normalPromptTokens,cachePercent:rate};save();
  assert.ok(result.usage.cacheRead>=normalPromptTokens-64,'Captured normal prefix not fully reused: '+result.usage.cacheRead+' of '+normalPromptTokens);
  results.compactions.push({trial,seconds:(performance.now()-t)/1000,cachePercent:rate,usage:result.usage,summary,details:result.details});save();
  console.log(JSON.stringify({phase:'compaction-completed',trial,seconds:results.compactions.at(-1).seconds,cachePercent:rate}));
  if(trial===1){console.log(JSON.stringify({phase:'continue-after-checkpoint'}));await session.prompt(normalMessage('D').replace('Only answer ACK.','Report the checkpoint facts requested below.')+'\nFrom the checkpoint, state the jump speed, checkpoint x, boss HP and number of unresolved failures in one sentence. No tools.');const answer=session.messages.filter(m=>m.role==='assistant').at(-1);const text=answer.content.filter(b=>b.type==='text').map(b=>b.text).join('');for(const token of ['17','3460','6'])assert.ok(text.includes(token),text);assert.match(text,/\b5\b|five/i);results.contextRecovery=text;results.latestNormalUsage=answer.usage;save();}
 }
 assert.equal(errors.length,0,JSON.stringify(errors));assert.equal(results.toolsExecuted,0);const telemetryDir=path.join(agentDir,ID.TELEMETRY_DIRECTORY);results.telemetry=fs.readdirSync(telemetryDir).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(telemetryDir,n))));assert.equal(results.telemetry.filter(r=>r.status==='completed').length,2);const version=JSON.parse(fs.readFileSync(path.join(here,'package.json'))).version;assert.ok(results.telemetry.every(r=>r.extensionVersion===version));assert.ok(results.telemetry.every(r=>r.providerTtftMs>=0&&r.providerGenerationMs>=0),'Local engine native request metrics must be reported for each compaction');results.passed=true;results.completedAt=new Date().toISOString();save();console.log(JSON.stringify({phase:'passed',extensionCount:results.extensionCount}));
}catch(e){results.error=String(e);save();throw e}finally{session?.dispose();fs.rmSync(tmp,{recursive:true,force:true});}
