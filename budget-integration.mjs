import fs from 'node:fs';
import {ID} from './test-identifiers.mjs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const here=path.dirname(new URL(import.meta.url).pathname);
import {findPiRoot} from './pi-root.mjs';
const root=findPiRoot();
import {MARKER} from './test-marker.mjs';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-request-integration-'));
const agentDir=path.join(tmp,'agent');fs.mkdirSync(agentDir,{recursive:true});
process.env.PI_CODING_AGENT_DIR=agentDir;process.env.PI_MEMORY_DIR=path.join(tmp,'memory');
process.env.PI_MEMORY_EXIT_SUMMARY='0';process.env.PI_MEMORY_QMD_UPDATE='off';process.env.PATH='/usr/bin:/bin:/usr/sbin:/sbin';
fs.mkdirSync(process.env.PI_MEMORY_DIR);fs.writeFileSync(path.join(process.env.PI_MEMORY_DIR,'MEMORY.md'),'# Fixture\nMemory integration sentinel: checkpoint x=3460; preserve unresolved failures.\n');
const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime,estimateTokens}=await import(root+'/dist/index.js');
const config={compaction:{enabled:false,reserveTokens:4096,keepRecentTokens:256},betterCompaction:{enabled:true,report:true,thinking:'inherit',lowThinkingBudget:0,sushiThinkingBudget:512,sushiBriefReasoning:true},retry:{enabled:false,provider:{maxRetries:0}}};
fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(config));
const summary='## Goal\nFix the checkpoint.\n## Constraints & Preferences\nDo not commit.\n## Progress\nFive failures remain; no verified fix.\n## Key Decisions\nPreserve jump speed 17.\n## Next Steps\nRun node dev/run-smokes.js.\n## Critical Context\nCheckpoint x=3460; boss HP=6. SECRET_CHECKPOINT_MARKER';
const calls=[];let summaryMode='valid';let reviewCalls=0;let normalPromptTokens=12000;let abortArrived;let heldResponse;let memoryFailures=0;
const server=http.createServer(async(req,res)=>{
 if(req.method==='GET' && req.url==='/status'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({schema_version:0}));return;}
 let text='';for await(const b of req)text+=b;const payload=JSON.parse(text);calls.push(payload);
 const compact=JSON.stringify(payload.messages).includes('CACHED CHECKPOINT SCOPE');const review=String(payload.messages.at(-1)?.content).includes(MARKER);
 if(compact&&!review&&(summaryMode==='prefill-always'||summaryMode==='prefill-once'&&memoryFailures++===0)){
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({error:{message:'error.PrefillDoesNotFit',type:'server_error'}})+'\n\ndata: [DONE]\n\n');return;
 }
 if(compact&&summaryMode==='http-error'){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture provider unavailable'}}));return;}
 if(compact&&!review&&summaryMode==='http-transient-once'&&memoryFailures++===0){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'503 Service unavailable; retry shortly'}}));return;}
 if(compact&&summaryMode==='http-capacity'){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Context 128778 does not fit available GPU memory at KV8, prefill chunk 512. Maximum context: 98862 tokens. Reduce context or free memory.'}}));return;}
 if((compact&&summaryMode==='abort')||(review&&summaryMode==='review-abort')){heldResponse=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': awaiting cancellation\n\n');abortArrived?.();return;}
 if(review)reviewCalls++;
 let verdict={valid:true,issues:[]};if(review&&(summaryMode==='review-reject'||summaryMode==='review-repair'&&reviewCalls===1))verdict={valid:false,issues:[{claim:'Full suite passed',reason:'Only a focused test ran'}]};
 let answer=review?JSON.stringify(verdict):compact?summary:'ACK';if(review&&summaryMode==='review-invalid')answer='PASS';let finish='stop';let delta={role:'assistant',content:answer};
 if(compact&&summaryMode==='empty')delta.content='';
 if(compact&&!review&&(summaryMode==='thinking-always'||summaryMode==='thinking-once'&&memoryFailures++===0))delta={role:'assistant',reasoning_content:'I am considering the checkpoint, but stopped without an answer.',content:''};
 if(compact&&!review&&summaryMode==='format-once'&&memoryFailures++===0)delta.content='Only partial checkpoint notes.';
 if(compact&&summaryMode==='missing-headings')delta.content='I will continue coding.';
 if((compact&&summaryMode==='truncated')||(review&&summaryMode==='review-truncated'))finish='length';
 if((compact&&summaryMode==='tool-call')||(review&&summaryMode==='review-tool-call')){delta={role:'assistant',tool_calls:[{index:0,id:'bad-call',type:'function',function:{name:'read',arguments:'{"path":"/tmp/never-executed"}'}}]};finish='tool_calls';}
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 res.write('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
 res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:compact?12000:normalPromptTokens,completion_tokens:100,total_tokens:(compact?12000:normalPromptTokens)+100,prompt_tokens_details:{cached_tokens:compact?11000:0}}})+'\n\n');res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const modelId='SiliconSpecies/Swift-1.5-Qwen3.8-27B-Splash';
fs.writeFileSync(path.join(agentDir,'models.json'),JSON.stringify({providers:{sushi:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture-key',models:[{id:modelId,name:'Fixture',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:131072,maxTokens:32768}]}}}));
fs.writeFileSync(path.join(agentDir,'auth.json'),'{}');
const future=path.join(tmp,'future-extension.ts');
fs.writeFileSync(future,`export default function(pi) {
 pi.registerTool({name:'fixture_future_tool',label:'Fixture future tool',description:'Future extension tool schema sentinel',parameters:{type:'object',properties:{checkpoint:{type:'integer'},mode:{type:'string',enum:['read','verify']}},required:['checkpoint'],additionalProperties:false},async execute(){throw new Error('Fixture tool must never execute')}});
 pi.on('before_agent_start',event=>({systemPrompt:event.systemPrompt+'\\nMemory integration sentinel: checkpoint x=3460; preserve unresolved failures.'}));
 pi.on('context_with_system',async(event,ctx)=>{const stream=await ctx.modelRegistry.streamSimple(ctx.model,{messages:[{role:'user',content:'Auxiliary extension inference; this is not an ordinary agent request.'}]},{sessionId:ctx.sessionManager.getSessionId(),reasoning:ctx.thinkingLevel,onPayload:payload=>({...payload,fixture_auxiliary:true})});for await(const part of stream){} });
 pi.on('context',event=>({messages:event.messages.map(m=>m.role==='user'?{...m,content:typeof m.content==='string'?m.content.replaceAll('REDACT_ME','[removed]'):m.content.map(b=>b.type==='text'?{...b,text:b.text.replaceAll('REDACT_ME','[removed]')}:b)}:m)}));
 pi.on('before_provider_request',event=>({...event.payload,fixture_extension_setting:'supported',messages:event.payload.messages.filter(m=>process.env.PI_TEST_PRUNE_CHECKPOINT!=='1'||!JSON.stringify(m.content).includes('Fix the checkpoint.')).map(m=>({...m,content:typeof m.content==='string'?m.content.replaceAll('SECRET_CHECKPOINT_MARKER','[removed]')+(['system','developer'].includes(m.role)?'\\nFuture payload sentinel':''):Array.isArray(m.content)?m.content.map(b=>b.type==='text'?{...b,text:b.text.replaceAll('SECRET_CHECKPOINT_MARKER','[removed]')}:b):m.content}))}));
 pi.on('before_provider_request',event=>process.env.PI_TEST_REDACT_FILEPATH==='1'?JSON.parse(JSON.stringify(event.payload).replaceAll('/tmp/fixture-current-hidden-edit.js','[filtered-file]')):undefined);
}`);
let session;
try{
 const extension=process.env.COMPACTION_SOURCE??path.join(here,'compaction.ts');
 const order=process.env.HOOK_ORDER==='before'?[future,extension]:[extension,future];
 // Optional: also load a real third-party extension alongside this one so the
 // scenario is tested against a non-trivial extension stack. Unset skips it.
 const memory=process.env.PI_MEMORY_EXTENSION;
 const memoryPaths=memory&&fs.existsSync(memory)?[memory]:[];
 const settings=SettingsManager.create(tmp,agentDir);
 const loader=new DefaultResourceLoader({cwd:tmp,agentDir,settingsManager:settings,additionalExtensionPaths:[...memoryPaths,...order],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
 await loader.reload();assert.equal(loader.getExtensions().errors.length,0,JSON.stringify(loader.getExtensions().errors));
 const runtime=await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:path.join(agentDir,'models.json'),modelsStorePath:path.join(tmp,'models-store.json'),refreshOnCreate:false});
 const model=runtime.getModel('sushi',modelId);assert.ok(model);const manager=SessionManager.inMemory(tmp);
 // Historical tool records exercise Pi's real file-operation extraction.
 const tracked='/tmp/fixture-before-first-compaction.js';
 manager.appendMessage({role:'user',content:'Historical fixture edit, already completed.',timestamp:Date.now()});
 manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:'fixture-historical-edit',name:'edit',arguments:{path:tracked,oldText:'old',newText:'new'}}],api:'openai-completions',provider:'sushi',model:modelId,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:Date.now()});
 manager.appendMessage({role:'toolResult',toolCallId:'fixture-historical-edit',toolName:'edit',content:[{type:'text',text:'Historical edit succeeded.'}],isError:false,timestamp:Date.now()});

 ({session}=await createAgentSession({cwd:tmp,agentDir,settingsManager:settings,resourceLoader:loader,sessionManager:manager,modelRuntime:runtime,model,thinkingLevel:'medium'}));
 const errors=[];session.subscribe(e=>{if(e.type==='extension_error')errors.push(e)});
 for(let i=0;i<4;i++)await session.prompt(`REDACT_ME. Observation ${i}: `+'Older verified observation; five unresolved failures. '.repeat(80));
 const normal=structuredClone(calls.at(-1));
 assert.ok(JSON.stringify(normal.messages).includes(tracked),'The ordinary provider input must include the historical tool record');assert.ok(normal.messages[0].content.includes('Memory integration sentinel'));assert.ok(normal.messages[0].content.includes('Future payload sentinel'));assert.ok(!JSON.stringify(normal.messages).includes('REDACT_ME'));
 const result=await session.compact('Keep verified facts, unresolved failures, and exact next test.');const compact=calls.at(-1);
 assert.equal(result.details.strategy,ID.STRATEGY);assert.deepEqual(result.details.summaryReasoning,{thinkingBudget:512,focusedExtraction:true});assert.deepEqual(result.details.verification,{status:'passed',passes:1,revisions:0});assert.ok(result.details.modifiedFiles.includes(tracked),'First checkpoint must track the historical edit');assert.deepEqual(compact.messages.slice(0,-1),normal.messages,'Every final normal message must be the exact summary prefix');
 const firstReport=manager.getEntries().findLast(e=>e.type==='custom'&&e.customType===ID.REPORT_ENTRY);
 assert.ok(firstReport,'Completion report must be persisted after the checkpoint');
 const applied=manager.buildSessionProjection().messages;
 assert.equal(firstReport.data.tokensBefore,result.tokensBefore);
 assert.equal(firstReport.data.tokensAfterEstimate,applied.reduce((n,m)=>n+estimateTokens(m),0));
 assert.equal(firstReport.data.summaryTokensEstimate,applied.filter(m=>m.role==='compactionSummary').reduce((n,m)=>n+estimateTokens(m),0));
 assert.equal(firstReport.data.retainedMessages,applied.filter(m=>!['system','compactionSummary'].includes(m.role)).length);
 assert.equal(firstReport.data.verificationStatus,'passed');
 assert.equal(firstReport.data.attempts,2,'Summary and review are separate inference calls');
 assert.ok(firstReport.data.totalMs>=0);
 assert.ok(!JSON.stringify(applied).includes(ID.REPORT_ENTRY),'Report must never enter model context');
 if(process.env.PI_NATIVE_TOKENIZER){
  const endpoint=process.env.PI_NATIVE_TOKENIZER;assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(endpoint));
  const tokenize=async(body)=>{const response=await fetch(endpoint+'/apply-template',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);const {prompt}=await response.json();const tokenResponse=await fetch(endpoint+'/tokenize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:prompt})});assert.equal(tokenResponse.status,200);return (await tokenResponse.json()).tokens;};
  const base=await tokenize(normal),proof=[];
  for(const request of calls.slice(-2)){const tokens=await tokenize(request);let common=0;while(common<base.length&&base[common]===tokens[common])common++;assert.ok(common>=base.length-64,'Native rendered prompt prefix must survive summary and review');proof.push({kind:String(request.messages.at(-1).content).includes(MARKER)?'review':'summary',baseTokens:base.length,commonTokens:common});}
  fs.writeFileSync(process.env.PI_NATIVE_PREFIX_REPORT??path.join(here,'native-prefix-proof.json'),JSON.stringify(proof,null,2));
 }
 assert.equal(compact.messages.at(-1).role,'system');assert.equal(compact.fixture_extension_setting,'supported');assert.ok(compact.tools.some(t=>t.function.name==='fixture_future_tool'));assert.equal(compact.tool_choice,'none');assert.deepEqual(compact.tools,normal.tools,'Final tool schemas must survive verbatim');assert.ok(!JSON.stringify(compact.messages).includes('REDACT_ME'));
 assert.equal(errors.length,0,JSON.stringify(errors));assert.ok(JSON.stringify(manager.buildSessionProjection().messages).includes('Observation 3'));
 await session.prompt('After compaction, five failures remain; preserve checkpoint x=3460. '+'Follow-up observation. '.repeat(80));const normal2=structuredClone(calls.at(-1));
 const repeated=await session.compact();assert.equal(repeated.details.strategy,ID.STRATEGY);assert.ok(repeated.details.modifiedFiles.includes(tracked),'Own previous checkpoint file metadata must survive repeated compaction');assert.deepEqual(calls.at(-1).messages.slice(0,-1),normal2.messages);assert.ok(!JSON.stringify(normal2.messages).includes('SECRET_CHECKPOINT_MARKER'));assert.ok(!JSON.stringify(calls.at(-1).messages.slice(0,-1)).includes('SECRET_CHECKPOINT_MARKER'),'Previously redacted checkpoint must not be reintroduced into review evidence');
 // A future extension may remove a whole checkpoint, not merely redact words.
 process.env.PI_TEST_PRUNE_CHECKPOINT='1';
 await session.prompt('A context-pruning extension removed the previous checkpoint. Keep current observations. '+'Latest unchanged inspection. '.repeat(80));
 const prunedNormal=structuredClone(calls.at(-1));
 assert.ok(!JSON.stringify(prunedNormal.messages).includes('Fix the checkpoint.'));
 assert.ok(!JSON.stringify(prunedNormal.messages).includes(tracked));
 const pruned=await session.compact();assert.equal(pruned.details.cacheStrategy,'captured-request');
 assert.deepEqual(calls.at(-1).messages.slice(0,-1),prunedNormal.messages);
 assert.ok(!JSON.stringify(calls.at(-1).messages.slice(0,-1)).includes('Fix the checkpoint.'),'Intentionally pruned checkpoint must stay removed from review evidence');
 assert.ok(pruned.details.modifiedFiles.includes(tracked));
 assert.ok(!pruned.summary.includes(tracked),'Filtered checkpoint paths must not be resurrected from local file metadata');
 delete process.env.PI_TEST_PRUNE_CHECKPOINT;
 const hidden='/tmp/fixture-current-hidden-edit.js';
 manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:'fixture-filtered-edit',name:'edit',arguments:{path:hidden,oldText:'old',newText:'new'}}],api:'openai-completions',provider:'sushi',model:modelId,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:Date.now()});
 manager.appendMessage({role:'toolResult',toolCallId:'fixture-filtered-edit',toolName:'edit',content:[{type:'text',text:'Edit succeeded.'}],isError:false,timestamp:Date.now()});
 process.env.PI_TEST_REDACT_FILEPATH='1';
 await session.prompt('A payload extension filtered file names. '+'Current observation. '.repeat(80));
 const filteredNormal=structuredClone(calls.at(-1));assert.ok(!JSON.stringify(filteredNormal.messages).includes(hidden));
 const filtered=await session.compact();assert.ok(filtered.details.modifiedFiles.includes(hidden));assert.ok(!filtered.summary.includes(hidden));assert.deepEqual(calls.at(-1).messages.slice(0,-1),filteredNormal.messages);
 delete process.env.PI_TEST_REDACT_FILEPATH;
 for(const mode of ['empty','missing-headings','truncated','tool-call','http-error']){
  await session.prompt('Keep five failures unresolved. '+ 'Inspection unchanged. '.repeat(80));
  const entriesBefore=JSON.stringify(manager.getEntries());const projectionBefore=JSON.stringify(manager.buildSessionProjection());
  summaryMode=mode;
  await assert.rejects(()=>session.compact(),/Compaction cancelled/);
  assert.equal(JSON.stringify(manager.getEntries()),entriesBefore,mode+' must not alter transcript');
  assert.equal(JSON.stringify(manager.buildSessionProjection()),projectionBefore,mode+' must retain context');
  summaryMode='valid';
 }
 // A rejected draft is revised once; an unsafe/invalid reviewer can never replace context.
 for(const mode of ['review-reject','review-invalid','review-truncated','review-tool-call']){
  await session.prompt('Before quality rejection, five failures remain. '+'Unchanged inspection. '.repeat(80));
  const original=JSON.stringify(manager.getEntries()),projection=JSON.stringify(manager.buildSessionProjection());
  summaryMode=mode;reviewCalls=0;await assert.rejects(()=>session.compact(),/Compaction cancelled/);
  assert.equal(JSON.stringify(manager.getEntries()),original);assert.equal(JSON.stringify(manager.buildSessionProjection()),projection);
  if(mode==='review-reject')assert.equal(reviewCalls,2,'Evidence rejection is bounded to two reviews and one revision');
  summaryMode='valid';
 }
 await session.prompt('Before a repairable draft, five failures remain. '+'Unchanged inspection. '.repeat(80));
 const repairNormal=structuredClone(calls.at(-1));summaryMode='review-repair';reviewCalls=0;const repaired=await session.compact();
 assert.deepEqual(repaired.details.verification,{status:'passed',passes:2,revisions:1});assert.equal(reviewCalls,2);
 assert.deepEqual(calls.at(-1).messages.slice(0,-1),repairNormal.messages);assert.deepEqual(calls.at(-1).tools,repairNormal.tools);summaryMode='valid';
 // Known local capacity failures recover once without bypassing filtered evidence.
 await session.prompt('Before memory recovery, five failures remain. '+'Unchanged inspection. '.repeat(80));
 const memoryNormal=structuredClone(calls.at(-1));summaryMode='prefill-once';memoryFailures=0;const memoryStart=calls.length;
 const recovered=await session.compact();assert.equal(recovered.details.memoryRecovery,'fresh-prefix');
 const memoryCalls=calls.slice(memoryStart);assert.equal(memoryCalls.length,3,'Refusal, one cold summary, then optional review');
 assert.deepEqual(memoryCalls[0].messages.slice(0,-1),memoryNormal.messages);
 assert.ok(String(memoryCalls[1].messages[0].content).startsWith('[CHECKPOINT RECOVERY '));
 assert.ok(memoryCalls[1].messages[0].content.endsWith(memoryNormal.messages[0].content));
 assert.deepEqual(memoryCalls[1].messages.slice(1,-1),memoryNormal.messages.slice(1));
 assert.ok(memoryCalls[1].tools[0].function.description.endsWith(memoryNormal.tools[0].function.description??''));
 assert.deepEqual({...memoryCalls[1].tools[0].function,description:memoryNormal.tools[0].function.description},memoryNormal.tools[0].function);
 assert.deepEqual(memoryCalls[1].tools.slice(1),memoryNormal.tools.slice(1));
 assert.notEqual(memoryCalls[1].messages[0].content,memoryCalls[2].messages[0].content,'Each recovery-stage request must avoid re-pinning an old prefix');
 summaryMode='valid';await session.prompt('Before unrecoverable memory refusal. '+'Unchanged inspection. '.repeat(80));
 const memoryEntries=JSON.stringify(manager.getEntries()),memoryProjection=JSON.stringify(manager.buildSessionProjection()),beforeMemoryFailure=calls.length;
 summaryMode='prefill-always';await assert.rejects(()=>session.compact(),/Compaction cancelled/);
 assert.equal(calls.length-beforeMemoryFailure,2,'Only one alternate capacity attempt is permitted');
 assert.equal(JSON.stringify(manager.getEntries()),memoryEntries);assert.equal(JSON.stringify(manager.buildSessionProjection()),memoryProjection);summaryMode='valid';
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...config,retry:{enabled:true,maxRetries:3,baseDelayMs:1,provider:{maxRetries:0}}}));await settings.reload();
 await session.prompt('Before HTTP capacity refusal. '+'Unchanged inspection. '.repeat(80));
 const httpCapacityEntries=JSON.stringify(manager.getEntries()),httpCapacityStart=calls.length;summaryMode='http-capacity';
 await assert.rejects(()=>session.compact(),/Compaction cancelled/);assert.equal(calls.length-httpCapacityStart,2,'Known HTTP 500 capacity errors must bypass generic retries on both attempts');
 assert.equal(JSON.stringify(manager.getEntries()),httpCapacityEntries);
 summaryMode='valid';await session.prompt('Before transient HTTP retry. '+'Unchanged inspection. '.repeat(80));
 const transientStart=calls.length;summaryMode='http-transient-once';memoryFailures=0;
 const transientResult=await session.compact();assert.equal(transientResult.details.memoryRecovery,undefined);
 assert.equal(calls.length-transientStart,3,'Transient retry, successful summary, optional review');
 assert.deepEqual(calls[transientStart].messages,calls[transientStart+1].messages,'Transient retries retain the cache prefix');
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(config));await settings.reload();summaryMode='valid';
 // Summary-only thinking budget must not change normal requests or templates.
 for(const payload of calls){
  const last=String(payload.messages.at(-1)?.content);
  if(last.includes('CACHED CHECKPOINT SCOPE')&&!last.includes(MARKER)){
   assert.equal(payload.reasoning_budget_tokens,last.includes('RECOVERY: the previous attempt')?0:512,'Only the explicit recovery may lower the Sushi thinking cap');
   assert.equal(payload.reasoning_effort,'medium','Cached reasoning template must stay unchanged');
   assert.ok(String(payload.messages.at(-1).content).includes('COMPACTION REASONING:'),'Summary must request focused extraction');
  }else assert.equal(payload.reasoning_budget_tokens,undefined,'Ordinary and review requests must retain their own thinking policy');
 }
 // Even a small summary output ceiling must not constrain optional review.
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...config,betterCompaction:{...config.betterCompaction,sushiMaxTokens:1024}}));
 await settings.reload();await session.prompt('Independent summary ceiling fixture. '+'Unchanged evidence. '.repeat(80));
 const ceilingStart=calls.length;await session.compact();const ceilingCalls=calls.slice(ceilingStart).filter(p=>!p.fixture_auxiliary);
 assert.equal(ceilingCalls[0].max_tokens??ceilingCalls[0].max_completion_tokens,1024);assert.equal(ceilingCalls[0].reasoning_budget_tokens,0);
 assert.equal(ceilingCalls[1].max_tokens??ceilingCalls[1].max_completion_tokens,Math.floor(.8*config.compaction.reserveTokens));assert.equal(ceilingCalls[1].reasoning_budget_tokens,undefined);
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(config));await settings.reload();
 // Cancellation during the review phase has the same rollback guarantee as generation.
 for(const mode of ['thinking-once','format-once','thinking-always']){
  await session.prompt('Thinking-only recovery fixture. '+'Current verified evidence. '.repeat(80));
  const prefix=structuredClone(calls.at(-1));const before=JSON.stringify(manager.getEntries());
  summaryMode=mode;memoryFailures=0;const start=calls.length;
  if(mode!=='thinking-always'){
   const recovered=await session.compact();assert.equal(recovered.details.summaryRecovery,mode==='format-once'?'missing-sections':'thinking-only');
   if(mode==='thinking-once')assert.equal(recovered.details.emptySummaryRecovery,true);
   assert.equal(recovered.details.verification.status,'passed');
  }else{
   await assert.rejects(()=>session.compact(),/cancelled|failed/i);
   assert.equal(JSON.stringify(manager.getEntries()),before,'Two thinking-only attempts must preserve the original session');
  }
  const asks=calls.slice(start).filter(p=>!p.fixture_auxiliary);
  assert.equal(asks.length,mode!=='thinking-always'?3:2,'Recovery is bounded to one extra summary ask');
  assert.equal(asks[1].reasoning_budget_tokens,0,'Recovery forces only the generation reasoning phase to end');
  assert.deepEqual(asks[1].messages.slice(0,-1),prefix.messages,'Recovery retains the exact cached source');
  assert.deepEqual(asks[1].tools,prefix.tools);assert.equal(asks[1].reasoning_effort,prefix.reasoning_effort);
  summaryMode='valid';
 }
 await session.prompt('Before review cancellation, five failures remain. '+'Unchanged inspection. '.repeat(80));
 const reviewOriginal=JSON.stringify(manager.getEntries());summaryMode='review-abort';
 const reviewArrived=new Promise(resolve=>abortArrived=resolve);const reviewCancelled=session.compact();
 await Promise.race([reviewArrived,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Review abort fixture did not arrive')),5000);timer.unref();})]);
 session.abortCompaction();await assert.rejects(()=>reviewCancelled,/Compaction cancelled|aborted/i);heldResponse?.destroy();summaryMode='valid';
 assert.equal(JSON.stringify(manager.getEntries()),reviewOriginal);
 // Cancellation must retain every original entry, with no success report.
 await session.prompt('Before cancellation, five failures remain. '+'Unchanged inspection. '.repeat(80));
 const entriesBeforeAbort=JSON.stringify(manager.getEntries());const projectionBeforeAbort=JSON.stringify(manager.buildSessionProjection());
 summaryMode='abort';
 const arrived=new Promise(resolve=>abortArrived=resolve);
 const cancelled=session.compact();
 await Promise.race([arrived,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Abort fixture request did not arrive')),5000);timer.unref();})]);
 session.abortCompaction();
 await assert.rejects(()=>cancelled,/Compaction cancelled|aborted/i);
 heldResponse?.destroy();summaryMode='valid';
 assert.equal(JSON.stringify(manager.getEntries()),entriesBeforeAbort);
 assert.equal(JSON.stringify(manager.buildSessionProjection()),projectionBeforeAbort);
 // Drive Pi's automatic threshold using realistic near-threshold usage.
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...config,compaction:{enabled:true,reserveTokens:32768,keepRecentTokens:256}}));
 await settings.reload();normalPromptTokens=100000;
 const compactionsBefore=manager.getEntries().filter(e=>e.type==='compaction').length;
 await session.prompt('Automatic checkpoint: five failures remain. '+'Latest unchanged inspection. '.repeat(80));
 const automatic=manager.getEntries().filter(e=>e.type==='compaction');
 assert.equal(automatic.length,compactionsBefore+1,'Automatic threshold must produce exactly one checkpoint');
 assert.equal(automatic.at(-1).details.strategy,ID.STRATEGY);
 const autoPayload=calls.findLast(p=>JSON.stringify(p.messages).includes('CACHED CHECKPOINT SCOPE'));
 assert.ok((autoPayload.max_tokens??autoPayload.max_completion_tokens)<=131072-100100-2048,'Near-threshold summary must respect remaining context');
 normalPromptTokens=12000;settings.setCompactionEnabled(false);
 for(let reload=0;reload<3;reload++) {
 await session.reload();
 await session.prompt('After reload, five failures remain. '+ 'Inspection unchanged. '.repeat(80));
 const reloadNormal=structuredClone(calls.at(-1));const reloadResult=await session.compact();
 assert.equal(reloadResult.details.strategy,ID.STRATEGY);assert.deepEqual(calls.at(-1).messages.slice(0,-1),reloadNormal.messages);
 assert.equal((reloadNormal.messages[0].content.match(/Future payload sentinel/g)??[]).length,1,'Reload must invoke each normal hook only once');
 }
 const telemetryDir=path.join(agentDir,ID.TELEMETRY_DIRECTORY);
 // Reporting respects review/report toggles without affecting checkpoints.
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...config,betterCompaction:{...config.betterCompaction,verify:false}}));
 await session.prompt('Review disabled completion report fixture. '+'Unchanged inspection. '.repeat(80));
 const reviewBefore=reviewCalls;
 await session.compact();
 const offReport=manager.getEntries().findLast(e=>e.type==='custom'&&e.customType===ID.REPORT_ENTRY);
 assert.equal(offReport.data.verificationStatus,'disabled');assert.equal(offReport.data.attempts,1);assert.equal(reviewCalls,reviewBefore);
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...config,betterCompaction:{...config.betterCompaction,verify:false,report:false}}));
 await session.prompt('Reporting disabled fixture. '+'Unchanged inspection. '.repeat(80));
 const countReports=()=>manager.getEntries().filter(e=>e.type==='custom'&&e.customType===ID.REPORT_ENTRY).length;
 const reportsBefore=countReports();await session.compact();assert.equal(countReports(),reportsBefore);
 const telemetry=fs.readdirSync(telemetryDir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(telemetryDir,f))));
 assert.ok(telemetry.some(e=>e.status==='completed'&&e.strategy===ID.STRATEGY&&e.verificationPasses===1&&e.revisions===0));
 assert.ok(telemetry.some(e=>e.status==='failed'));assert.ok(telemetry.some(e=>e.status==='cancelled'));assert.ok(telemetry.some(e=>e.verificationStatus==='passed'&&e.revisions===1));assert.ok(telemetry.some(e=>e.status==='failed'&&e.errorCategory==='summary_verification'));assert.ok(telemetry.every(e=>!('reviewIssuesText' in e)));
 assert.ok(!JSON.stringify(telemetry).includes('SECRET_CHECKPOINT_MARKER'));assert.ok(!JSON.stringify(telemetry).includes('checkpoint x=3460'));
 console.log('PASS: '+(memoryPaths.length?'actual pi-memory plus ':'')+'memory injection; future tool registration; arbitrary context/payload hooks '+(process.env.HOOK_ORDER??'after')+' capture; byte-exact request prefix and tools; privacy filter; redacted/pruned prior checkpoints stay removed; retained tail; cumulative file metadata; repeated compaction; invalid/empty/truncated/tool-call/provider-error rollback; cancellation; automatic threshold; three reloads; metadata-only completion/failure/cancellation telemetry; zero extension errors. Fake loopback provider only.');
}finally{session?.dispose();await new Promise(resolve=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});}
