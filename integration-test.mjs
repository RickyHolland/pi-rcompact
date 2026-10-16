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
const config={compaction:{enabled:false,reserveTokens:4096,keepRecentTokens:256},betterCompaction:{enabled:true,report:true,thinking:'inherit',lowThinkingBudget:0,verify:'background'},retry:{enabled:false,provider:{maxRetries:0}}};
fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(config));
const summary='## Goal\nFix the checkpoint.\n## Constraints & Preferences\nDo not commit.\n## Progress\nFive failures remain; no verified fix.\n## Key Decisions\nPreserve jump speed 17.\n## Next Steps\nRun node dev/run-smokes.js.\n## Critical Context\nCheckpoint x=3460; boss HP=6. SECRET_CHECKPOINT_MARKER';
const calls=[];const reviewRequests=[];let summaryMode='valid';let reviewCalls=0;let normalPromptTokens=12000;let cachedTokens=11000;let abortArrived;let heldResponse;
const server=http.createServer(async(req,res)=>{
 if(req.method==='GET' && req.url==='/status'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({schema_version:0}));return;}
 let text='';for await(const b of req)text+=b;const payload=JSON.parse(text);
 // Review asks are recorded separately: they are not ordinary requests, and the
 // prefix assertions below compare the last ORDINARY request to a compaction ask.
  const isReview=JSON.stringify(payload).includes(MARKER);
 if(isReview)reviewRequests.push(payload);else calls.push(payload);
  const compact=!isReview&&JSON.stringify(payload).includes('CACHED CHECKPOINT SCOPE');const review=isReview;
 if(compact&&summaryMode==='http-error'){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture provider unavailable'}}));return;}
 if((compact&&summaryMode==='abort')||(review&&summaryMode==='review-abort')){heldResponse=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': awaiting cancellation\n\n');abortArrived?.();return;}
 if(review)reviewCalls++;
 let verdict={valid:true,issues:[]};if(review&&(summaryMode==='review-reject'||summaryMode==='review-repair'&&reviewCalls===1))verdict={valid:false,issues:[{claim:'Full suite passed',reason:'Only a focused test ran'}]};
 let answer=review?JSON.stringify(verdict):compact?summary:'ACK';if(review&&summaryMode==='review-invalid')answer='PASS';let finish='stop';let delta={role:'assistant',content:answer};
 if(compact&&summaryMode==='empty')delta.content='';
 if(compact&&summaryMode==='missing-headings')delta.content='I will continue coding.';
 if((compact&&summaryMode==='truncated')||(review&&summaryMode==='review-truncated'))finish='length';
 if((compact&&summaryMode==='tool-call')||(review&&summaryMode==='review-tool-call')){delta={role:'assistant',tool_calls:[{index:0,id:'bad-call',type:'function',function:{name:'read',arguments:'{"path":"/tmp/never-executed"}'}}]};finish='tool_calls';}
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 res.write('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
 res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:compact?12000:normalPromptTokens,completion_tokens:100,total_tokens:(compact?12000:normalPromptTokens)+100,prompt_tokens_details:{cached_tokens:compact?cachedTokens:0}}})+'\n\n');res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const modelId='SiliconSpecies/Swift-1.5-Qwen3.8-27B-Splash';
fs.writeFileSync(path.join(agentDir,'models.json'),JSON.stringify({providers:{splash:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture-key',models:[{id:modelId,name:'Fixture',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:131072,maxTokens:32768}]}}}));
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
 const model=runtime.getModel('splash',modelId);assert.ok(model);const manager=SessionManager.create(tmp,path.join(tmp,"sessions"));
 // Historical tool records exercise Pi's real file-operation extraction.
 const tracked='/tmp/fixture-before-first-compaction.js';
 manager.appendMessage({role:'user',content:'Historical fixture edit, already completed.',timestamp:Date.now()});
 manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:'fixture-historical-edit',name:'edit',arguments:{path:tracked,oldText:'old',newText:'new'}}],api:'openai-completions',provider:'splash',model:modelId,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:Date.now()});
 manager.appendMessage({role:'toolResult',toolCallId:'fixture-historical-edit',toolName:'edit',content:[{type:'text',text:'Historical edit succeeded.'}],isError:false,timestamp:Date.now()});

 ({session}=await createAgentSession({cwd:tmp,agentDir,settingsManager:settings,resourceLoader:loader,sessionManager:manager,modelRuntime:runtime,model,thinkingLevel:'medium'}));
 const errors=[];session.subscribe(e=>{if(e.type==='extension_error')errors.push(e)});
 for(let i=0;i<4;i++)await session.prompt(`REDACT_ME. Observation ${i}: `+'Older verified observation; five unresolved failures. '.repeat(80));
 const normal=structuredClone(calls.at(-1));
 assert.ok(JSON.stringify(normal.messages).includes(tracked),'The ordinary provider input must include the historical tool record');assert.ok(normal.messages[0].content.includes('Memory integration sentinel'));assert.ok(normal.messages[0].content.includes('Future payload sentinel'));assert.ok(!JSON.stringify(normal.messages).includes('REDACT_ME'));
 const result=await session.compact('Keep verified facts, unresolved failures, and exact next test.');const compact=calls.at(-1);
 assert.equal(result.details.strategy,ID.STRATEGY);assert.deepEqual(result.details.verification,{status:'detached',passes:0,revisions:0});assert.ok(result.details.modifiedFiles.includes(tracked),'First checkpoint must track the historical edit');assert.deepEqual(compact.messages.slice(0,-1),normal.messages,'Every final normal message must be the exact summary prefix');
 const firstReport=manager.getEntries().findLast(e=>e.type==='custom'&&e.customType===ID.REPORT_ENTRY);
 assert.ok(firstReport,'Completion report must be persisted after the checkpoint');
 const applied=manager.buildSessionProjection().messages;
 assert.equal(firstReport.data.tokensBefore,result.tokensBefore);
 assert.equal(firstReport.data.tokensAfterEstimate,applied.reduce((n,m)=>n+estimateTokens(m),0));
 assert.equal(firstReport.data.summaryTokensEstimate,applied.filter(m=>m.role==='compactionSummary').reduce((n,m)=>n+estimateTokens(m),0));
 assert.equal(firstReport.data.retainedMessages,applied.filter(m=>!['system','compactionSummary'].includes(m.role)).length);
 assert.equal(firstReport.data.verificationStatus,'detached');
 assert.equal(firstReport.data.attempts,1,'The report lands before the detached review runs');
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
  await session.prompt('Idle boundary while the pruning hook is active.');
  const prunedReview=reviewRequests.at(-1);
  assert.ok(prunedReview,'A detached review ask runs at the next idle boundary');
  assert.deepEqual(prunedReview.messages.slice(0,-1),prunedNormal.messages,'Review source must exactly preserve the filtered request');
  assert.ok(!JSON.stringify(prunedReview.messages.slice(0,-1)).includes('Fix the checkpoint.'),'Pruned checkpoint must stay removed from SOURCE evidence');
  assert.ok(!JSON.stringify(prunedReview.messages.slice(0,-1)).includes(tracked),'Pruned paths must stay removed from SOURCE evidence');
  assert.ok(prunedReview.messages.at(-1).content.includes('Fix the checkpoint.'),'The freshly generated candidate is separately quoted for review');
 assert.ok(pruned.details.modifiedFiles.includes(tracked));
 assert.ok(!pruned.summary.includes(tracked),'Filtered checkpoint paths must not be resurrected from local file metadata');
 delete process.env.PI_TEST_PRUNE_CHECKPOINT;
 const hidden='/tmp/fixture-current-hidden-edit.js';
 manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:'fixture-filtered-edit',name:'edit',arguments:{path:hidden,oldText:'old',newText:'new'}}],api:'openai-completions',provider:'splash',model:modelId,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:Date.now()});
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
 // A rejected review does not block the checkpoint (Pi cannot un-apply an applied
 // compaction entry): it runs detached, is announced loudly, and the NEXT summary
 // ask is told the checkpoint is unverified.
 const reviewEntriesBefore=manager.getEntries().filter(e=>e.customType===ID.REVIEW_ENTRY).length;
 for(const mode of ['review-reject','review-invalid','review-truncated','review-tool-call']){
  await session.prompt('Before quality rejection, five failures remain. '+'Unchanged inspection. '.repeat(80));
  summaryMode=mode;reviewCalls=0;
  const appliedCheckpoint=await session.compact();
  assert.deepEqual(appliedCheckpoint.details.verification,{status:'detached',passes:0,revisions:0},mode+' must not wait for the review');
  await session.prompt('Idle boundary. '+'New verified inspection. '.repeat(80));
  assert.equal(reviewCalls,1,mode+' issues exactly one detached review ask');
  const reviewEntry=manager.getEntries().findLast(e=>e.customType===ID.REVIEW_ENTRY);
  assert.ok(reviewEntry,mode+' must persist a loud rejection');
  assert.equal(reviewEntry.data.state,'rejected');
  assert.equal(reviewEntry.data.piCheckpointId,manager.getBranch().findLast(e=>e.type==='compaction').id,'Identical summary text must bind review to the newest applied checkpoint');
  assert.ok(reviewEntry.data.issues.length>0 && reviewEntry.data.codes.length>0,'Rejection carries issues and stable codes');
  summaryMode='valid';
 }
 assert.equal(manager.getEntries().filter(e=>e.customType===ID.REVIEW_ENTRY).length,reviewEntriesBefore+4);
 const flaggedAsk=structuredClone(calls.at(-1));
 await session.prompt('Prepare the next checkpoint. '+'Current verified observations. '.repeat(80));

 assert.ok(JSON.stringify(calls.at(-1).messages).includes('failed or expired evidence review'),'The next ordinary model turn must see the durable rejection warning');
 await session.compact();
 const summaryAsk=calls.filter((c)=>JSON.stringify(c.messages).includes('CACHED CHECKPOINT SCOPE')).at(-1);
 assert.ok(JSON.stringify(summaryAsk.messages).includes('UNVERIFIED CHECKPOINTS'),'A rejected checkpoint must be flagged to the model in the next summary ask');
 assert.notDeepEqual(structuredClone(flaggedAsk),summaryAsk);
 await session.prompt('Idle boundary. '+'New verified inspection. '.repeat(80));
 const repairNormal=structuredClone(calls.at(-1));summaryMode='review-repair';reviewCalls=0;const repaired=await session.compact();
 assert.deepEqual(repaired.details.verification,{status:'detached',passes:0,revisions:0});assert.equal(reviewCalls,0);
 await session.prompt('Idle boundary. '+'New verified inspection. '.repeat(80));
 assert.equal(reviewCalls,1,'A repairable draft is reviewed once, detached');
 assert.equal(manager.getEntries().filter(e=>e.customType===ID.REVIEW_ENTRY).length,reviewEntriesBefore+5,'A rejected detached draft stores its unapplied repair');
 assert.ok(manager.getEntries().findLast(e=>e.customType===ID.REVIEW_ENTRY).data.replacement,'Rejected review offers a replacement without applying it');
 assert.deepEqual(calls.at(-1).messages.slice(0,-1),repairNormal.messages);assert.deepEqual(calls.at(-1).tools,repairNormal.tools);summaryMode='valid';
 // Cancellation during the review phase has the same rollback guarantee as generation.
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...config,betterCompaction:{...config.betterCompaction,verify:'blocking'}}));await settings.reload();
 await session.prompt('Before review cancellation, five failures remain. '+'Unchanged inspection. '.repeat(80));
 const reviewOriginal=JSON.stringify(manager.getEntries());summaryMode='review-abort';
 const reviewArrived=new Promise(resolve=>abortArrived=resolve);const reviewCancelled=session.compact();
 await Promise.race([reviewArrived,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Review abort fixture did not arrive')),5000);timer.unref();})]);
 session.abortCompaction();await assert.rejects(()=>reviewCancelled,/Compaction cancelled|aborted/i);heldResponse?.destroy();summaryMode='valid';
 assert.equal(JSON.stringify(manager.getEntries()),reviewOriginal);
 summaryMode='review-reject';await session.prompt('Blocking review must preserve original history. '+'Current inspection. '.repeat(80));
 const rejectedOriginal=JSON.stringify(manager.getEntries());
 await assert.rejects(()=>session.compact(),/cancelled|failed/i);
 assert.equal(JSON.stringify(manager.getEntries()),rejectedOriginal,'A twice rejected blocking draft is never applied');
 summaryMode='valid';
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(config));await settings.reload();
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
 const reviewsBeforeReload=reviewRequests.length;
 await session.reload();
 await session.prompt('After reload, five failures remain. '+ 'Inspection unchanged. '.repeat(80));
 assert.equal(reviewRequests.length,reviewsBeforeReload,'Reload abandons pending review without a late call into the new extension');
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
 // Cache-miss feedback. A captured ask served entirely cold means the engine
 // dropped the resident prefix, so the next compaction goes native and the
 // captured path is then probed again. A measured hit clears the streak.
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...config,betterCompaction:{...config.betterCompaction,verify:false}}));await settings.reload();
 const summaryAsks=()=>calls.filter(c=>JSON.stringify(c.messages).includes('CACHED CHECKPOINT SCOPE')).length;
 // Sorted oldest-first: readdir order is arbitrary, so "the latest attempt"
 // needs a real timestamp.
 const readAttempts=()=>fs.readdirSync(telemetryDir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(telemetryDir,f),'utf8'))).sort((a,b)=>(a.startedAt??0)-(b.startedAt??0)||String(a.id).localeCompare(String(b.id)));
 const cycle=async(label)=>{await session.prompt(`${label} inspection. `+'Unchanged inspection. '.repeat(60));return session.compact();};
 cachedTokens=0;
 const coldFirst=await cycle('cold captured ask');
 assert.equal(coldFirst.details.strategy,ID.STRATEGY,'The first measured miss still checkpoints');
 assert.ok(readAttempts().some(e=>e.cacheOutcome==='miss'&&e.consecutiveMisses===1&&e.deferCompactions===1),'The cold ask must be measured and recorded');
 const deferBase=summaryAsks();
 const deferred=await cycle('after a measured miss');
 assert.notEqual(deferred.details?.strategy,ID.STRATEGY,'A measured miss hands the next compaction to native');
 assert.equal(summaryAsks(),deferBase,'A deferred compaction sends no captured-request ask');
 assert.ok(readAttempts().some(e=>e.deferredAfterMiss===true&&e.consecutiveMisses===1));
 const probe=await cycle('reprobe after the deferral');
 assert.equal(probe.details.strategy,ID.STRATEGY,'The deferral is consumed and the captured path is probed again');
 assert.equal(readAttempts().filter(e=>e.cacheOutcome==='miss').length,2);
 const secondDeferral=await cycle('second measured miss');
 assert.notEqual(secondDeferral.details?.strategy,ID.STRATEGY);
 assert.equal(secondDeferral.details?.verification,undefined,'Native compaction must not claim our verification');
 cachedTokens=11000;
 const restored=await cycle('cached again');
 assert.equal(restored.details.strategy,ID.STRATEGY);
 const cleared=await cycle('streak cleared');
 assert.equal(cleared.details.strategy,ID.STRATEGY,'A measured hit clears the streak, so no deferral follows');
 // Policy overrides: keep never defers, native never captures.
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...config,betterCompaction:{...config.betterCompaction,verify:false,cachePolicy:'keep'}}));await settings.reload();
 cachedTokens=0;await cycle('keep policy');const kept=await cycle('keep still captures');
 assert.equal(kept.details.strategy,ID.STRATEGY,'cachePolicy keep reports misses without deferring');
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...config,betterCompaction:{...config.betterCompaction,verify:false,cachePolicy:'native'}}));await settings.reload();
 const forcedNative=await cycle('native policy');
 assert.notEqual(forcedNative.details?.strategy,ID.STRATEGY,'cachePolicy native keeps the captured ask off this engine');
 assert.ok(readAttempts().some(e=>e.cacheStrategy==='native'&&e.status==='native_completed'&&String(e.fallbackReason).startsWith('cache policy')),'cachePolicy native must record that the ask was kept off this engine');
 // Restore the default policy before the scenarios below.
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(config));await settings.reload();
 // Streak hygiene for the scenarios below: a `keep` probe still measures real
 // misses, so a pending deferral can survive a policy switch. One captured ask
 // consumes it and the measured hit in the second restores the captured path.
 cachedTokens=11000;
 await cycle('consuming a probed deferral');
 const streakCleared=await cycle('streak cleared by a measured hit');
 assert.equal(streakCleared.details?.strategy,ID.STRATEGY,'A measured hit must restore the captured path');
 // Reasoning-effort mirroring. A configured "low" no longer requires the session
 // level to match: the ask mirrors the captured wire effort so the hot prefix
 // survives, and the thinking phase is bounded by the budget knob instead.
 const originalThinking=session.thinkingLevel;
 session.setThinkingLevel('medium');
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...config,betterCompaction:{...config.betterCompaction,verify:false,thinking:'low'}}));await settings.reload();
 await session.prompt('Medium thinking ordinary request. '+'Unchanged inspection. '.repeat(60));
 const mediumNormal=structuredClone(calls.at(-1));
 const mirrored=await session.compact();
 assert.equal(mirrored.details.strategy,ID.STRATEGY,'A configured low effort must not abandon the hot prefix');
 const mirrorAsk=calls.at(-1);
 const reasoningKeys=['reasoning_effort','reasoning','thinking','chat_template_kwargs'];
 assert.ok(reasoningKeys.some((k)=>mediumNormal[k]!==undefined),'The fixture ordinary request must carry reasoning somewhere on the wire');
 for(const key of reasoningKeys)assert.equal(JSON.stringify(mirrorAsk[key]),JSON.stringify(mediumNormal[key]),`The summary ask must mirror the captured ${key}`);
 assert.deepEqual(mirrorAsk.messages.slice(0,-1),mediumNormal.messages,'Mirroring must leave the request prefix byte-identical');
 assert.ok(readAttempts().some(e=>e.thinkingMirrored===true&&e.configuredThinking==='low'&&e.capturedReasoning==='medium'),'The mirror must be reported in metadata-only telemetry');
 // Explicit "off" is the one effort a capture cannot produce, so it still defers.
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...config,betterCompaction:{...config.betterCompaction,verify:false,thinking:'off'}}));await settings.reload();
 await session.prompt('Thinking off request. '+'Unchanged inspection. '.repeat(60));
 const turnedOff=await session.compact();
 assert.notEqual(turnedOff.details?.strategy,ID.STRATEGY,'thinking off cannot mirror a captured reasoning effort');
 assert.ok(readAttempts().some(e=>String(e.fallbackReason).includes('cannot mirror the captured reasoning effort')));
 session.setThinkingLevel(originalThinking);
 // Recall over the transcript that compaction replaced. Opt-in, because a tool
 // declaration costs tokens on every ordinary request.
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(config));await settings.reload();
 const toolsBeforeRecall=JSON.stringify(structuredClone(calls.at(-1)).tools??[]);
 assert.ok(!toolsBeforeRecall.includes('recall_before_compaction'),'default settings must not declare the recall tools');
 const recallOn={...config,betterCompaction:{...config.betterCompaction,verify:false,recall:true}};
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(recallOn));await settings.reload();
 await session.reload();
 await session.prompt('Recall-enabled ordinary request. '+'Unchanged inspection. '.repeat(60));
 const recallNormal=structuredClone(calls.at(-1));
 assert.ok(JSON.stringify(recallNormal.tools).includes('recall_before_compaction'),'recall on must declare the recall tools on ordinary requests');
 assert.ok(JSON.stringify(recallNormal.tools).includes('recall_generations'),'recall_generations must be declared too');
 await session.prompt('Plant ARCHIVED EVIDENCE 12345 and REDACT_ME and SECRET_CHECKPOINT_MARKER for recall. '+'Unchanged inspection. '.repeat(60));
 // Enough turns that the evidence falls inside the replaced prefix: compaction
 // keeps a recent tail, and recall is only for what the checkpoint removed.
 for(let turn=0;turn<4;turn++) await session.prompt('Filler '+turn+'. '+'Inspection unchanged. '.repeat(60));
 const plantRequest=structuredClone(calls.at(-1));
 const recallCompaction=await session.compact();
 assert.deepEqual(structuredClone(calls.at(-1)).messages.slice(0,-1),plantRequest.messages,'Declaring the recall tools must not break the byte-exact captured prefix');
 assert.equal(recallCompaction.details?.strategy,ID.STRATEGY);
 assert.ok((recallCompaction.details?.recall?.messages??0)>0,'compaction must report what it archived');
 const recallExt=loader.getExtensions().extensions.map(e=>e).find(e=>e.tools?.has?.('recall_before_compaction'));
 const recallTool=recallExt?.tools?.get('recall_before_compaction')?.definition;
 assert.ok(recallTool,'the recall tool must be registered with the extension loader');
 const hits=await recallTool.execute('recall-call-1',{pattern:'ARCHIVED EVIDENCE',snippetChars:200},undefined,undefined,undefined);
 assert.match(hits.content[0].text,/ARCHIVED EVIDENCE 12345/,'recall must return the archived message');
 assert.equal(hits.details.generations>=1,true);
 const payloadHidden=await recallTool.execute('payload-hidden',{pattern:'SECRET_CHECKPOINT_MARKER'},undefined,undefined,undefined);
 assert.equal(payloadHidden.details.hits,0,'Recall must preserve payload-hook redaction, not just context-hook redaction');
 const rawDenied=await recallTool.execute('raw-denied',{entryId:manager.getEntries()[1].id},undefined,undefined,{cwd:tmp,sessionManager:manager});
 assert.equal(rawDenied.details.result,'raw-mode-disabled','Filtered mode must not allow raw entry reads');
 const generationsTool=recallExt?.tools?.get('recall_generations')?.definition;
 const listed=await generationsTool.execute('recall-call-2',{},undefined,undefined,undefined);
 assert.match(listed.content[0].text,/archived messages/);
 const badPattern=await recallTool.execute('recall-call-3',{pattern:'([unclosed',isRegex:true},undefined,undefined,undefined);
 assert.match(badPattern.content[0].text,/Invalid regular expression/);
 assert.equal(badPattern.details.result,'invalid-pattern');
 // Recall reads the FILTERED view: what a redaction hook removed stays removed.
 const recallBodies=JSON.stringify(calls.slice(-6));
 assert.ok(!recallBodies.includes('REDACT_ME'),'recall must not resurrect text a context hook redacted');
 assert.ok(JSON.stringify(hits.content).includes('[removed]')||!recallBodies.includes('hunter2'),'the redacted secret must not be recallable');
 // --- explicit second opt-in: raw stored journal ---
 const sessionFile=manager.getSessionFile();
 const journalBefore=fs.readFileSync(sessionFile,'utf8');
 const storedOn={...config,betterCompaction:{...config.betterCompaction,verify:false,recall:true,recallJournal:'stored'}};
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(storedOn));await settings.reload();
 await session.reload();
 const storedExt=loader.getExtensions().extensions.find(e=>e.tools?.has?.('recall_before_compaction'));
 const storedTool=storedExt.tools.get('recall_before_compaction').definition;
 const recallCtx={cwd:tmp,sessionManager:manager};
 const rawHits=await storedTool.execute('recall-call-4',{pattern:'REDACT_ME',snippetChars:200},undefined,undefined,recallCtx);
 assert.match(rawHits.content[0].text,/UNFILTERED stored journal/,'stored mode must label results as unfiltered');
 assert.match(rawHits.content[0].text,/REDACT_ME/,'stored mode reads the raw journal by design');
 assert.equal(rawHits.details.source,'stored-journal');
 const entryId=rawHits.content[0].text.match(/entry=([A-Za-z0-9_-]+)/)?.[1];
 assert.ok(entryId,'stored hits must carry the entry id');
 const paged=await storedTool.execute('recall-call-5',{entryId,offsetChars:0,maxChars:200},undefined,undefined,recallCtx);
 assert.match(paged.content[0].text,new RegExp(`\\[entry ${entryId} chars 0-\\d+ of \\d+`));
 assert.ok(!paged.content[0].text.includes('Unchanged inspection. Unchanged inspection. Unchanged inspection.'),'an entryId read must honour maxChars');
 const storedList=await storedExt.tools.get('recall_generations').definition.execute('recall-call-6',{},undefined,undefined,recallCtx);
 assert.match(storedList.content[0].text,/mode=stored-journal \(UNFILTERED\)/,'recall_generations must report the active source');
 assert.equal(fs.readFileSync(sessionFile,'utf8'),journalBefore,'recall reads must never mutate the session journal');
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(storedOn));await settings.reload();
 await session.reload();
 await session.prompt('Recall from the journal: ARCHIVED EVIDENCE 12345. '+'Unchanged inspection. '.repeat(60));
 const journalRecallTool=loader.getExtensions().extensions.find(e=>e.tools?.has?.('recall_before_compaction'))?.tools?.get('recall_before_compaction')?.definition;
 const afterPromptHits=await journalRecallTool.execute('recall-call-7',{pattern:'ARCHIVED EVIDENCE'},undefined,undefined,recallCtx);
 assert.match(afterPromptHits.content[0].text,/ARCHIVED EVIDENCE 12345/,'stored mode recalls through a reload, which the in-memory archive cannot');
 // Turning the setting off and reloading must not leave the declarations behind.
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(config));await settings.reload();
 await session.reload();
 await session.prompt('Recall off again. '+'Unchanged inspection. '.repeat(60));
 assert.ok(!JSON.stringify(structuredClone(calls.at(-1)).tools).includes('recall_before_compaction'),'recall off must not declare the tools after a reload');
 const telemetry=fs.readdirSync(telemetryDir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(telemetryDir,f))));
 assert.ok(telemetry.some(e=>e.status==='completed'&&e.strategy===ID.STRATEGY&&e.reviewScheduled===true),'Applied background checkpoints schedule a review; later verdict updates the same record');
 assert.ok(telemetry.some(e=>e.verificationPasses===1&&e.reviewDetached===true&&e.revisions===0),'Detached verdicts update the same telemetry record');
 assert.ok(telemetry.some(e=>e.status==='failed'));assert.ok(telemetry.some(e=>e.status==='cancelled'));assert.ok(telemetry.some(e=>e.verificationStatus==='rejected'&&e.reviewDetached===true));assert.ok(telemetry.some(e=>e.status==='failed'&&e.errorCategory==='summary_verification'));assert.ok(telemetry.every(e=>!('reviewIssuesText' in e)));
 assert.ok(!JSON.stringify(telemetry).includes('SECRET_CHECKPOINT_MARKER'));assert.ok(!JSON.stringify(telemetry).includes('checkpoint x=3460'));
 console.log('PASS: '+(memoryPaths.length?'actual pi-memory plus ':'')+'memory injection; future tool registration; arbitrary context/payload hooks '+(process.env.HOOK_ORDER??'after')+' capture; byte-exact request prefix and tools; privacy filter; redacted/pruned prior checkpoints stay removed; retained tail; cumulative file metadata; repeated compaction; invalid/empty/truncated/tool-call/provider-error rollback; cancellation; automatic threshold; three reloads; measured prefix-cache miss defers to native and reprobes, keep/native policies honored; configured low effort mirrors the captured reasoning effort with a byte-identical prefix while thinking off still defers; opt-in recall tools read the filtered pre-compaction view and never resurrect redacted text; metadata-only completion/failure/cancellation telemetry; zero extension errors. Fake loopback provider only.');
}finally{session?.dispose();await new Promise(resolve=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});}
