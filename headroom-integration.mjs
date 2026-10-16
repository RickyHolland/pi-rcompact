import fs from 'node:fs';
import {ID} from './test-identifiers.mjs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {findPiRoot} from './pi-root.mjs';
const here=path.dirname(new URL(import.meta.url).pathname),root=findPiRoot();
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rcompact-headroom-sdk-'));
const agentDir=path.join(tmp,'agent');fs.mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR=agentDir;
const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime}=await import(root+'/dist/index.js');
const summary='## Goal\nContinue the fixture.\n## Constraints & Preferences\nNo tools or commits.\n## Progress\nFive failures remain.\n## Key Decisions\nPreserve checkpoint 3460.\n## Next Steps\nRun smoke tests.\n## Critical Context\nJump speed 17, boss HP 6. Causes remain unverified.';
let mode='fit',normalCalls=[],summaryCalls=[],tokenCounts=[],recovered=false;
const server=http.createServer(async(req,res)=>{
 let body='';for await(const b of req)body+=b;
 const payload=body?JSON.parse(body):undefined;
 const json=data=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 if(req.url==='/status')return json({schema_version:6,maximum_context_tokens:131072});
 if(req.url==='/apply-template'){
  assert.ok(payload.tools.some(t=>t.function.name==='future_tool'),'The guard must see the final tool loadout');
  assert.ok(JSON.stringify(payload.messages).includes('Final payload sentinel'),'The guard must run after other payload hooks');
  return json({prompt:'fixture'});
 }
 if(req.url==='/tokenize'){
  const count=mode==='too-full'||mode==='stays-full'?recovered&&mode!=='stays-full'?1000:131000:98830;
  tokenCounts.push(count);return json({tokens:Array(count).fill(1)});
 }
 assert.equal(req.url,'/v1/chat/completions');
 const compact=!payload.tools?.length||JSON.stringify(payload.messages).includes('CACHED CHECKPOINT SCOPE');
 if(compact){summaryCalls.push(payload);recovered=true;}
 else {
  normalCalls.push(payload);
  if((mode==='engine-recovery'&&normalCalls.length===1)||mode==='engine-stays-down'){
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.end('data: '+JSON.stringify({error:{message:'the inference engine stopped unexpectedly and is restarting; retry the request',type:'server_error',code:'runtime_unavailable'}})+'\n\n');return;
  }
  if(mode==='reject'){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture ordinary request rejected'}}));return;}
  assert.ok((payload.max_tokens??payload.max_completion_tokens)+(tokenCounts.at(-1)??0)<=131072,'Oversized ordinary requests must not reach inference');
 }
 const count=compact?4000:tokenCounts.at(-1),answer=compact?summary:'ACK';
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 for(const event of [
  {choices:[{index:0,delta:{role:'assistant',content:answer},finish_reason:null}]},
  {choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:count,completion_tokens:100,total_tokens:count+100,prompt_tokens_details:{cached_tokens:compact?count-8:0}}}
 ])res.write('data: '+JSON.stringify(event)+'\n\n');
 res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const modelId='fixture';
fs.writeFileSync(path.join(agentDir,'models.json'),JSON.stringify({providers:{splash:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture',models:[{id:modelId,name:'Fixture',reasoning:true,input:['text'],contextWindow:131072,maxTokens:32768,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
fs.writeFileSync(path.join(agentDir,'auth.json'),'{}');
const future=path.join(tmp,'future.ts');
// Pi stamps the assistant before awaiting its payload/tokenizer hook. Delay
// at the context hook instead, before the recovered assistant is constructed,
// so a fast local fixture cannot share the checkpoint's millisecond timestamp.
fs.writeFileSync(future,`export default function(pi){pi.on('context_with_system',async()=>{await new Promise(resolve=>setTimeout(resolve,10))});pi.registerTool({name:'future_tool',label:'Future tool',description:'Future extension schema',parameters:{type:'object',properties:{mode:{type:'string',enum:['read','verify']}},required:['mode']},execute:async()=>{throw Error('Never execute')}});pi.on('before_provider_request',e=>({...e.payload,messages:e.payload.messages.map((m,i)=>i===0?{...m,content:m.content+'\\nFinal payload sentinel'}:m)}));}`);
const runtime=await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:path.join(agentDir,'models.json'),modelsStorePath:path.join(tmp,'store.json'),refreshOnCreate:false});
async function run(trial){
 mode=trial;normalCalls=[];summaryCalls=[];tokenCounts=[];recovered=false;
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({compaction:{enabled:trial==='too-full'||trial==='stays-full',reserveTokens:32768,keepRecentTokens:256},betterCompaction:{enabled:true,report:true,thinking:'inherit',verify:false},retry:{enabled:trial.startsWith('engine-'),maxRetries:2,baseDelayMs:10,maxDelayMs:20,provider:{maxRetries:0}}}));
 const settings=SettingsManager.create(tmp,agentDir),loader=new DefaultResourceLoader({cwd:tmp,agentDir,settingsManager:settings,additionalExtensionPaths:[path.join(here,'compaction.ts'),future],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 const manager=SessionManager.inMemory(tmp);
 for(let i=0;i<4;i++){
  manager.appendMessage({role:'user',content:'Historical inspection '+i+': '+'Five failures remain unverified. '.repeat(120),timestamp:Date.now()-10000+i});
  manager.appendMessage({role:'assistant',content:[{type:'text',text:'No verified fix.'}],api:'openai-completions',provider:'splash',model:modelId,usage:{input:1000,cacheRead:0,cacheWrite:0,output:10,totalTokens:1010,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()-9000+i});
 }
 const {session}=await createAgentSession({cwd:tmp,agentDir,settingsManager:settings,resourceLoader:loader,sessionManager:manager,modelRuntime:runtime,model:runtime.getModel('splash',modelId),thinkingLevel:'medium'});
 const errors=[],ends=[];session.subscribe(e=>{if(e.type==='extension_error')errors.push(e);if(e.type==='compaction_end')ends.push(e);if(e.type==='tool_execution_start')throw Error('No tools allowed');});
 try{
  await session.prompt('Continue the fixture; no tools.');
  if(trial==='fit'){
   assert.equal(normalCalls[0].max_tokens??normalCalls[0].max_completion_tokens,32242);
   const result=await session.compact();assert.equal(result.details.cacheStrategy,'captured-request');assert.equal(result.details.verification.status,'disabled');
   assert.deepEqual(summaryCalls.at(-1).messages.slice(0,-1),normalCalls[0].messages);assert.deepEqual(summaryCalls.at(-1).tools,normalCalls[0].tools);
  }else if(trial==='reject'){
   assert.equal(session.messages.at(-1).stopReason,'error');
   const result=await session.compact();assert.notEqual(result.details?.strategy,ID.STRATEGY);
   assert.equal(summaryCalls.length,1);assert.ok(!summaryCalls[0].tools?.length);assert.ok(!JSON.stringify(summaryCalls[0]).includes('CACHED CHECKPOINT SCOPE'));
  }else if(trial.startsWith('engine-')){
   if(trial==='engine-recovery'){
    assert.equal(normalCalls.length,2);assert.equal(session.messages.at(-1).stopReason,'stop');
    const result=await session.compact();assert.equal(result.details.cacheStrategy,'captured-request','Successful retry may populate the cache capture');
   }else {assert.equal(normalCalls.length,3,'One initial attempt plus two configured retries');assert.equal(session.messages.at(-1).stopReason,'error');}
  }else{
   assert.ok(summaryCalls.length>=1 && summaryCalls.length<=2,'Native compaction may summarize the discarded prefix and split turn separately');
   assert.equal(ends.filter(e=>e.result).length,1);
   if(trial==='too-full'){assert.equal(normalCalls.length,1,'Initial oversized request stays local; only the recovered request reaches inference');assert.equal(session.messages.at(-1).stopReason,'stop');}
   else {assert.equal(normalCalls.length,0);assert.ok(ends.some(e=>e.errorMessage?.includes('one compact-and-retry')),'A repeated overflow must stop without looping: '+JSON.stringify(ends));}
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({trial,tokenCounts,ordinaryRequests:normalCalls.length,summaryRequests:summaryCalls.length,passed:true}));
 }finally{session.dispose();}
}
try{for(const trial of ['fit','reject','too-full','stays-full','engine-recovery','engine-stays-down'])await run(trial);}
finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});}
