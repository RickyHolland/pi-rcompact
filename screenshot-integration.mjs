/** Fake loopback provider only. Optional real history stays in memory. */
import fs from 'node:fs';
import {ID} from './test-identifiers.mjs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {findPiRoot} from './pi-root.mjs';
const root=findPiRoot(),here=path.dirname(new URL(import.meta.url).pathname);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rcompact-screenshot-sdk-'));
const agentDir=path.join(tmp,'agent');fs.mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR=agentDir;
process.env.PI_MEMORY_DIR=path.join(tmp,'memory');
process.env.PI_MEMORY_EXIT_SUMMARY='0';process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS='0';process.env.PI_MEMORY_QMD_UPDATE='off';
const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime,buildSessionProjection,convertToLlm}=await import(root+'/dist/index.js');
const calls=[];
const checkpoint='## Goal\nContinue the verified task.\n## Constraints & Preferences\nNo tools or external actions.\n## Progress\nThe screenshot history was inspected; work remains.\n## Key Decisions\nPreserve exact captured input.\n## Next Steps\nContinue verification.\n## Critical Context\nUnverified hypotheses remain unverified.';
const server=http.createServer(async(req,res)=>{
 if(req.method==='GET'&&req.url==='/status'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"schema_version":0}');return;}
 let text='';for await(const part of req)text+=part;
 const payload=JSON.parse(text);calls.push(payload);
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 res.write('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:checkpoint},finish_reason:null}]})+'\n\n');
 res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:12000,completion_tokens:100,total_tokens:12100,prompt_tokens_details:{cached_tokens:11000}}})+'\n\n');
 res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const config={compaction:{enabled:false,reserveTokens:8192,keepRecentTokens:256},betterCompaction:{enabled:true,report:true,thinking:'inherit',verify:false},retry:{enabled:false,provider:{maxRetries:0}}};
fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(config));
const modelId='SiliconSpecies/Swift-1.5-Qwen3.8-27B-Splash';
fs.writeFileSync(path.join(agentDir,'models.json'),JSON.stringify({providers:{splash:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture',models:[{id:modelId,name:'Screenshot fixture',reasoning:true,input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:131072,maxTokens:32768}]}}}));
fs.writeFileSync(path.join(agentDir,'auth.json'),'{}');
const guard=path.join(tmp,'guard.ts');fs.writeFileSync(guard,"export default function(pi){pi.on('tool_call',()=>({block:true,reason:'Read-only screenshot replay'}));}");
const settings=SettingsManager.create(tmp,agentDir);
const loader=new DefaultResourceLoader({cwd:tmp,agentDir,settingsManager:settings,additionalExtensionPaths:[guard,path.join(here,'compaction.ts')],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
await loader.reload();assert.equal(loader.getExtensions().errors.length,0,JSON.stringify(loader.getExtensions().errors));
const runtime=await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:path.join(agentDir,'models.json'),modelsStorePath:path.join(tmp,'models-store.json'),refreshOnCreate:false});
const model=runtime.getModel('splash',modelId),manager=SessionManager.inMemory(tmp);
let imageCount=0,imageBytes=0;
const countImages=value=>{
 if(Array.isArray(value))value.forEach(countImages);
 else if(value&&typeof value==='object'){
  if(value.type==='image'&&typeof value.data==='string'){imageCount++;imageBytes+=Buffer.byteLength(value.data);}
  Object.values(value).forEach(countImages);
 }
};
if(process.env.PI_REAL_SESSION_FILE){
 const rows=fs.readFileSync(process.env.PI_REAL_SESSION_FILE,'utf8').trim().split('\n').map(JSON.parse);
 const leaf=process.env.PI_REAL_SESSION_BEFORE_COMPACTION==='1'?rows.find(e=>e.type==='compaction')?.parentId??rows.findLast(e=>e.id)?.id:rows.findLast(e=>e.id)?.id;
 // Project first so branches, edits and prior checkpoints cannot be replayed as
 // chronological duplicates. The source file is never opened for writing.
 const projected=buildSessionProjection(rows.filter(e=>e.id),leaf);
 for(const message of projected.messages){countImages(message);manager.appendMessage(structuredClone(message));}
}else{
 const message={role:'user',content:[{type:'text',text:'A verified screenshot with pending work.'},{type:'image',data:'a'.repeat(12*1024*1024),mimeType:'image/png'}],timestamp:Date.now()};
 countImages(message);manager.appendMessage(message);
}
const canonicalBytes=Buffer.byteLength(JSON.stringify(convertToLlm(manager.buildSessionProjection().messages)));
assert.ok(canonicalBytes*2>16*1024*1024,'Fixture must reproduce the old duplicated-context limit');
let session;
const result={realHistory:!!process.env.PI_REAL_SESSION_FILE,sourceSessionUnchanged:true,canonicalBytes,imageCount,imageBytes,inferenceRequests:0,externalRequests:0,toolsExecuted:0,compactions:[]};
const sourceBefore=process.env.PI_REAL_SESSION_FILE?createHash('sha256').update(fs.readFileSync(process.env.PI_REAL_SESSION_FILE)).digest('hex'):undefined;
try{
 ({session}=await createAgentSession({cwd:tmp,agentDir,settingsManager:settings,resourceLoader:loader,sessionManager:manager,modelRuntime:runtime,model,thinkingLevel:'medium'}));
 const errors=[];session.subscribe(e=>{if(e.type==='extension_error')errors.push(e);if(e.type==='tool_execution_start')result.toolsExecuted++;});
 for(let trial=0;trial<3;trial++){
  if(trial===2)await session.reload();
  for(let turn=0;turn<3;turn++)await session.prompt(`Read-only fixture continuation ${trial}-${turn}. Preserve verified facts; do not call tools. `+'Historical verification remains incomplete. '.repeat(80));
  const normal=calls.at(-1),before=calls.length;
  const compact=await session.compact('Preserve verified facts and unresolved work.');
  assert.equal(compact.details.strategy,ID.STRATEGY);assert.equal(compact.details.verification.status,'disabled');assert.equal(calls.length,before+1);
  const summary=calls.at(-1);
  assert.deepEqual(summary.messages.slice(0,-1),normal.messages,'Final provider prefix must be byte-identical, including screenshots');
  assert.deepEqual(summary.tools,normal.tools);assert.equal(summary.tool_choice,'none');
  assert.ok(!JSON.stringify(summary.messages).includes('Summarize the captured provider request.'),'Carrier must never reach the model');
  result.compactions.push({trial:trial+1,afterReload:trial===2,exactPrefix:true,reviewDisabled:true,payloadBytes:Buffer.byteLength(JSON.stringify(normal)),prefixSha256:createHash('sha256').update(JSON.stringify(normal.messages)).digest('hex')});
 }
 assert.equal(errors.length,0,JSON.stringify(errors));assert.equal(result.toolsExecuted,0);
 const telemetry=fs.readdirSync(path.join(agentDir,ID.TELEMETRY_DIRECTORY)).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(agentDir,ID.TELEMETRY_DIRECTORY,f))));
 assert.equal(telemetry.filter(e=>e.status==='completed'&&e.strategy===ID.STRATEGY).length,3);
 assert.ok(telemetry.every(e=>e.verificationStatus==='disabled'));
 if(sourceBefore)assert.equal(createHash('sha256').update(fs.readFileSync(process.env.PI_REAL_SESSION_FILE)).digest('hex'),sourceBefore,'Source session was modified');
 result.passed=true;
 if(process.env.PI_SCREENSHOT_RESULT_FILE)fs.writeFileSync(process.env.PI_SCREENSHOT_RESULT_FILE,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}finally{session?.dispose();await new Promise(resolve=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});}
