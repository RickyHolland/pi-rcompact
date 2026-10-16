import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {findPiRoot} from './pi-root.mjs';
const root=findPiRoot(),here=path.dirname(new URL(import.meta.url).pathname),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'sushi-normal-recovery-')),agentDir=path.join(tmp,'agent');fs.mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR=agentDir;
const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime}=await import(root+'/dist/index.js');
const config={packages:[],extensions:[],compaction:{enabled:false,reserveTokens:16384,keepRecentTokens:20000},retry:{enabled:false,provider:{maxRetries:0}},betterCompaction:{enabled:true,verify:false,thinking:'inherit'}};
const calls=[];let scenario='recover',start=0,arrived,held,extensionApi;
const server=http.createServer(async(req,res)=>{
 if(req.url!='/v1/chat/completions'){res.writeHead(404);res.end('{}');return;}
 let text='';for await(const b of req)text+=b;const payload=JSON.parse(text);const i=calls.length-start;calls.push(payload);
 if(scenario==='error'){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture unavailable'}}));return;}
 if(scenario==='abort-retry'&&i===1){held=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': held recovery\n\n');arrived?.();return;}
 let finish='stop',delta={role:'assistant',content:'RECOVERY OK'};
 if(scenario==='always'||scenario==='off'||scenario==='other'||(scenario==='recover'||scenario==='abort-retry')&&i===0||scenario==='tools'&&i===1)delta={role:'assistant',reasoning_content:'I will run the next check now.',content:''};
 if(scenario==='length'){delta={role:'assistant',reasoning_content:'Truncated thought',content:''};finish='length';}
 if(scenario==='tools'&&(i===0||i===2)){finish='tool_calls';delta={role:'assistant',tool_calls:[{index:0,id:'fixture-'+i,type:'function',function:{name:'fixture_local_action',arguments:JSON.stringify({action:i===0?'first':'second'})}}]};}
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 res.write('data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
 res.write('data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:12000,completion_tokens:25,total_tokens:12025,completion_tokens_details:{reasoning_tokens:delta.reasoning_content?25:0},prompt_tokens_details:{cached_tokens:11000}}})+'\n\n');res.end('data: [DONE]\n\n');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const modelId='Fixture';const definition={baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture',models:[{id:modelId,name:'Fixture',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:147456,maxTokens:32768}]};
fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(config));fs.writeFileSync(path.join(agentDir,'models.json'),JSON.stringify({providers:{sushi:definition,other:definition}}));fs.writeFileSync(path.join(agentDir,'auth.json'),'{}');
globalThis.__normalRecoveryActions=[];
const future=path.join(tmp,'fixture.ts');fs.writeFileSync(future,`export default function(pi){
 globalThis.__normalRecoveryExtensionApi=pi;
 pi.registerTool({name:'fixture_local_action',label:'Fixture',description:'Safe counted synthetic action',parameters:{type:'object',properties:{action:{type:'string'}},required:['action']},async execute(_id,args){globalThis.__normalRecoveryActions.push(args.action);return {content:[{type:'text',text:'Fixture action done'}],details:{}}}});
 pi.on('before_provider_request',e=>({...e.payload,fixture_sentinel:true}));
}`);
let session;
try{
 const settings=SettingsManager.create(tmp,agentDir);const extension=path.join(here,'compaction.ts');
 const loader=new DefaultResourceLoader({cwd:tmp,agentDir,settingsManager:settings,additionalExtensionPaths:process.env.HOOK_ORDER==='before'?[future,extension]:[extension,future],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 const runtime=await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:path.join(agentDir,'models.json'),modelsStorePath:path.join(tmp,'models-store.json'),refreshOnCreate:false});const manager=SessionManager.inMemory(tmp);
 ({session}=await createAgentSession({cwd:tmp,agentDir,settingsManager:settings,resourceLoader:loader,sessionManager:manager,modelRuntime:runtime,model:runtime.getModel('sushi',modelId),thinkingLevel:'medium'}));const errors=[];session.subscribe(e=>{if(e.type==='extension_error')errors.push(e)});
 const last=()=>session.messages.filter(m=>m.role==='assistant').at(-1);
 const run=async(mode)=>{scenario=mode;start=calls.length;await session.prompt('Synthetic '+mode+' request.');return calls.slice(start);};
 let rows=await run('recover');assert.equal(rows.length,2);assert.equal(rows[0].reasoning_budget_tokens,undefined);assert.equal(rows[1].reasoning_budget_tokens,0);assert.equal(last().content.find(b=>b.type==='text').text,'RECOVERY OK');assert.equal(rows[1].reasoning_effort,rows[0].reasoning_effort);assert.deepEqual(rows[1].tools,rows[0].tools);assert.equal(rows[1].fixture_sentinel,true);
 rows=await run('always');assert.equal(rows.length,2,'Repeated empty stops are bounded');assert.ok(manager.getEntries().some(e=>e.customType==='sushi-turn-recovery'&&e.data?.status==='exhausted'));
 rows=await run('always');assert.equal(rows.length,2,'A new user prompt gets a fresh allowance');assert.equal(rows[0].reasoning_budget_tokens,undefined);
 extensionApi=globalThis.__normalRecoveryExtensionApi;assert.ok(extensionApi);
 scenario='always';start=calls.length;
 const settled=new Promise(resolve=>{const off=session.subscribe(e=>{if(e.type==='agent_end'){off();resolve();}})});
 extensionApi.sendMessage({customType:'fixture-custom-start',content:'Synthetic extension continuation.',display:false},{triggerTurn:true});
 await settled;await session.waitForIdle();assert.equal(calls.length-start,1,'A custom-message start cannot renew a consumed recovery allowance');
 rows=await run('tools');assert.equal(rows.length,4);assert.deepEqual(globalThis.__normalRecoveryActions,['first','second'],'Each genuine action runs once');assert.equal(rows[0].reasoning_budget_tokens,undefined);assert.equal(rows[2].reasoning_budget_tokens,0);assert.equal(rows[3].reasoning_budget_tokens,undefined,'After recovery, ordinary tool turns regain normal thinking');
 for(const mode of ['length','error']){rows=await run(mode);assert.equal(rows.length,1,mode+' is not silently retried');}
 scenario='abort-retry';start=calls.length;const ready=new Promise(r=>arrived=r);const pending=session.prompt('Synthetic cancellation during recovery.');await Promise.race([ready,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('No held recovery request')),5000);t.unref();})]);await session.abort();await pending;held?.destroy();assert.equal(calls.length-start,2);assert.equal(last().stopReason,'aborted');
 rows=await run('valid');assert.equal(rows.length,1);assert.equal(rows[0].reasoning_budget_tokens,undefined,'Aborted recovery cannot leak the budget');
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({...config,betterCompaction:{...config.betterCompaction,normalThinkingRecovery:false}}));await settings.reload();rows=await run('off');assert.equal(rows.length,1);
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify(config));await settings.reload();await session.reload();rows=await run('recover');assert.equal(rows.length,2,'Reload registers exactly one recovery hook');
 await session.setModel(runtime.getModel('other',modelId));rows=await run('other');assert.equal(rows.length,1,'Other providers remain unchanged');
 assert.deepEqual(errors,[]);console.log('PASS: actual SDK normal thinking-only recovery; one per user run; subsequent normal budgets; single tool execution; truncation/error exclusion; abort during recovery; settings off; reload; provider isolation; both payload-hook orders supported. Fake loopback only; no production writes.');
}finally{session?.dispose();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});delete globalThis.__normalRecoveryActions;delete globalThis.__normalRecoveryExtensionApi;}
