import {test} from "bun:test";
import assert from "node:assert/strict";
import {buildSessionProjection, convertToLlm} from "@earendil-works/pi-coding-agent";
import {validateSnapshot, summaryPayload, createRequestCapture, filterFileMetadata, messageHashes} from "./request-snapshot";

test('file metadata respects final conversation filtering without losing canonical bookkeeping',()=>{
 const f=fixture();f.snapshot.payload.messages=[{role:'user',content:'Read /tmp/visible.js; filtered file omitted.'}];
 f.snapshot.payload.tools=[{description:'/tmp/hidden.js'}];
 const read=['/tmp/visible.js','/tmp/hidden.js'],modified=['/tmp/pruned.js'];
 assert.deepEqual(filterFileMetadata(f.snapshot,read,modified),{readFiles:['/tmp/visible.js'],modifiedFiles:[]});
 assert.deepEqual(read,['/tmp/visible.js','/tmp/hidden.js']);assert.deepEqual(modified,['/tmp/pruned.js']);
});
test('file metadata supports nested JSON tool arguments with escaped paths',()=>{
 const f=fixture();const file='C:\\work\\a"b.js';
 f.snapshot.payload.messages=[{role:'assistant',tool_calls:[{function:{arguments:JSON.stringify({path:file})}}]}];
 assert.deepEqual(filterFileMetadata(f.snapshot,[],[file]),{readFiles:[],modifiedFiles:[file]});
});

function fixture() {
  const messages = ['older user', 'recent user', 'latest user'];
  const entries = messages.map((content,i)=>({type:'message',id:`e${i}`,parentId:i?`e${i-1}`:null,timestamp:'2026-10-03T00:00:00Z',message:{role:'user',content,timestamp:1}}));
  const projection=buildSessionProjection(entries as any,'e2');
  const ctx:any={model:{provider:'splash',id:'model'},thinkingLevel:'medium',sessionManager:{getSessionId:()=> 'session'}};
  const snapshot:any={confirmed:true,sessionId:'session',provider:'splash',modelId:'model',reasoning:'medium',payload:{model:'model',messages:[{role:'system',content:'Memory and future extension instructions'},{role:'user',content:'redacted input'}],tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}],temperature:1,top_k:20,top_p:.95,reasoning_effort:'medium',fixture_extra:true,max_tokens:100,stop:['stop'],response_format:{type:'json_schema'}},canonicalHashes:messageHashes(convertToLlm(projection.messages)),entryIds:['e0','e1','e2']};
  return {entries,projection,ctx,snapshot};
}
test('accepts a captured request covering all discarded entries',()=>{const f=fixture();assert.equal(validateSnapshot(f.snapshot,f.ctx,f.projection,1),undefined)});
test('missing capture is a native fallback, never a reconstructed request',()=>{const f=fixture();assert.match(validateSnapshot(undefined,f.ctx,f.projection,1)!,/no ordinary/)});
test('session isolation',()=>{const f=fixture();f.snapshot.sessionId='other';assert.match(validateSnapshot(f.snapshot,f.ctx,f.projection,1)!,/session changed/)});
test('model isolation',()=>{const f=fixture();f.snapshot.modelId='other';assert.match(validateSnapshot(f.snapshot,f.ctx,f.projection,1)!,/model changed/)});
test('provider isolation',()=>{const f=fixture();f.snapshot.provider='other';assert.match(validateSnapshot(f.snapshot,f.ctx,f.projection,1)!,/model changed/)});
test('reasoning changes invalidate the captured template',()=>{const f=fixture();f.ctx.thinkingLevel='low';assert.match(validateSnapshot(f.snapshot,f.ctx,f.projection,1)!,/thinking level/)});
test('context edits invalidate old capture',()=>{const f=fixture();const changed=structuredClone(f.projection);changed.messages[0].content='corrected';assert.match(validateSnapshot(f.snapshot,f.ctx,changed,1)!,/edited/)});
test('branching cannot reuse another branch',()=>{const f=fixture();const changed=structuredClone(f.projection);changed.messages.pop();assert.match(validateSnapshot(f.snapshot,f.ctx,changed,1)!,/branched/)});
test('uncaptured discarded tool output causes native fallback',()=>{const f=fixture();f.snapshot.entryIds=['e0'];assert.match(validateSnapshot(f.snapshot,f.ctx,f.projection,2)!,/uncaptured/)});
test('uncaptured latest output is allowed only when retained verbatim',()=>{const f=fixture();f.snapshot.canonicalHashes=f.snapshot.canonicalHashes.slice(0,2);f.snapshot.entryIds=['e0','e1'];assert.equal(validateSnapshot(f.snapshot,f.ctx,f.projection,2),undefined)});
test('unsupported future provider format yields native fallback',()=>{const f=fixture();f.snapshot.payload.messages={};assert.match(validateSnapshot(f.snapshot,f.ctx,f.projection,1)!,/format changed/)});
test('final normal prefix and tools are preserved exactly',()=>{const f=fixture();const out=summaryPayload({messages:[{role:'user',content:'compiled'}],max_tokens:4096,temperature:0},f.snapshot,'Only summarize');assert.deepEqual(out.messages.slice(0,-1),f.snapshot.payload.messages);assert.deepEqual(out.tools,f.snapshot.payload.tools);assert.equal(out.messages.at(-1).role,'system');assert.equal(out.max_tokens,4096);assert.equal(out.temperature,1);assert.equal(out.top_k,20);assert.equal(out.fixture_extra,true)});
test('normal stops and output schema cannot truncate or constrain a checkpoint',()=>{const f=fixture();const out=summaryPayload({messages:[]},f.snapshot,'Summarize');assert.equal(out.stop,undefined);assert.equal(out.response_format,undefined);assert.equal(out.tool_choice,'none');assert.equal(out.parallel_tool_calls,false)});
test('capture and provider payload are immutable under summary construction',()=>{const f=fixture();const raw=JSON.stringify(f.snapshot);const input={messages:[],max_tokens:2048};const before=JSON.stringify(input);const out=summaryPayload(input,f.snapshot,'Summarize');out.messages[0].content='changed';out.tools[0].function.name='changed';assert.equal(JSON.stringify(f.snapshot),raw);assert.equal(JSON.stringify(input),before)});
test('unsupported summary payload cancels instead of bypassing its guard',()=>{const f=fixture();assert.throws(()=>summaryPayload({},f.snapshot,'Summarize'))});
test('public provider API missing remains an inert native fallback',()=>{
  const handlers=new Map<string,Function[]>();const pi:any={on:(k:string,h:Function)=>handlers.set(k,[...(handlers.get(k)??[]),h])};
  const capture=createRequestCapture(pi);const ctx:any={model:{provider:'splash',api:'openai-completions'},sessionManager:{getSessionId:()=> 's'},modelRegistry:{}};
  for(const h of handlers.get('session_start')??[])h({},ctx);
  assert.equal(capture.get(),undefined);
});
test('normal alternative output limit cannot bypass the bounded summary ceiling',()=>{
 const f=fixture();f.snapshot.payload.max_completion_tokens=100000;
 const out=summaryPayload({messages:[],max_tokens:4096},f.snapshot,'Summarize');
 assert.equal(out.max_tokens,4096);assert.equal(out.max_completion_tokens,undefined);
 const alternative=summaryPayload({messages:[],max_completion_tokens:2048},f.snapshot,'Summarize');
 assert.equal(alternative.max_completion_tokens,2048);assert.equal(alternative.max_tokens,undefined);
});

test('summaryPayload mirrors the captured reasoning effort over a lower configured effort',()=>{
 const f=fixture();f.snapshot.payload.reasoning_effort='medium';
 const out=summaryPayload({messages:[],reasoning_effort:'low'},f.snapshot,'Summarize');
 assert.equal(out.reasoning_effort,'medium','A configured low effort must not fork the captured prefix');
});

test('a thinking token budget survives reasoning-effort mirroring',()=>{
 const f=fixture();f.snapshot.payload.reasoning_effort='medium';f.snapshot.payload.chat_template_kwargs={enable_thinking:true};
 const out=summaryPayload({messages:[],reasoning_effort:'low',reasoning_budget_tokens:2048,chat_template_kwargs:{enable_thinking:false}},f.snapshot,'Summarize');
 assert.equal(out.reasoning_effort,'medium');
 assert.equal(out.reasoning_budget_tokens,2048,'Bounding the thinking phase is the supported way to shorten a mirrored ask');
 assert.deepEqual(out.chat_template_kwargs,{enable_thinking:true},'Captured template flags must not be replaced by reconstructed ones');
});

test('an ordinary request without a reasoning effort does not gain one',()=>{
 const f=fixture();delete f.snapshot.payload.reasoning_effort;f.snapshot.reasoning=undefined;
 const out=summaryPayload({messages:[],reasoning_effort:'low'},f.snapshot,'Summarize');
 assert.equal(out.reasoning_effort,undefined,'Mirroring must not invent effort the capture never sent');
});
