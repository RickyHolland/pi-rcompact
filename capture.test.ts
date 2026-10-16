import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createRequestCapture,messageHashes,validateSnapshot,summaryPayload} from './request-snapshot';
import {buildSessionProjection,convertToLlm} from '@earendil-works/pi-coding-agent';

function harness() {
  const handlers=new Map<string,Function[]>();
  const entries:any[]=[{type:'message',id:'entry',parentId:null,timestamp:'2026-10-03T00:00:00Z',message:{role:'user',content:'Verified original context',timestamp:1}}];
  let sessionId='first'; let payload:any={messages:[{role:'user',content:'Filtered final context'}]};
  let configured:any; const base:any={streamSimple:async (_m:any,_c:any,o:any)=>o.onPayload(payload)};
  let provider=base;
  const pi:any={on:(event:string,handler:Function)=>handlers.set(event,[...(handlers.get(event)??[]),handler]),registerProvider:(_id:string,config:any)=>{configured=config;provider={streamSimple:config.streamSimple};}};
  const ctx:any={model:{provider:'splash',api:'openai-completions',id:'model'},thinkingLevel:'medium',sessionManager:{getSessionId:()=>sessionId,getEntries:()=>entries,getLeafId:()=>entries.at(-1).id},modelRegistry:{getProvider:()=>provider,getRegisteredProviderConfig:()=>configured}};
  const capture=createRequestCapture(pi);
  const fire=async(event:string,data:any={})=>{for(const h of handlers.get(event)??[])await h(data,ctx)};
  const start=()=>fire('before_agent_start');
  const request=async(onPayload?:Function,session=sessionId)=>{await fire('context_with_system');return provider.streamSimple(ctx.model,{messages:[{role:'user',content:'Final context'}]},{sessionId:session,reasoning:'medium',onPayload:async(body:any)=>{await fire('before_provider_request');return onPayload?onPayload(body):body}})};
  return {ctx,capture,fire,start,request,entries,pi,base,setSession:(id:string)=>sessionId=id,setPayload:(p:any)=>payload=p,replaceProvider:(p:any)=>{provider=p;configured={streamSimple:p.streamSimple}},getProvider:()=>provider};
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve}}

test('captures final async payload rewrite and preserves ordinary inference',async()=>{
 const h=harness();await h.start();const output=await h.request(async()=>({messages:[{role:'system',content:'Injected by future extension'}]}));
 assert.deepEqual(h.capture.get()?.payload,output);assert.equal(h.capture.get()?.sessionId,'first');
});
test('late payload hook after shutdown cannot resurrect a snapshot',async()=>{
 const h=harness();await h.start();const gate=deferred();const request=h.request(async()=>{await gate.promise});await Promise.resolve();await Promise.resolve();
 await h.fire('session_shutdown');gate.resolve();await request;
 assert.equal(h.capture.get(),undefined);
});
test('late payload hook from previous session cannot label old context as the new session',async()=>{
 const h=harness();await h.start();const gate=deferred();const request=h.request(async()=>{await gate.promise});await Promise.resolve();await Promise.resolve();
 h.setSession('second');await h.fire('session_start');gate.resolve();await request;
 assert.equal(h.capture.get(),undefined);await h.request();assert.equal(h.capture.get()?.sessionId,'second');
});
test('late payload hook cannot undo thinking invalidation',async()=>{
 const h=harness();await h.start();const gate=deferred();const request=h.request(async()=>{await gate.promise});await Promise.resolve();await Promise.resolve();
 await h.fire('thinking_level_select');gate.resolve();await request;assert.equal(h.capture.get(),undefined);
});
test('direct LLM calls without normal session marker cannot replace the normal capture',async()=>{
 const h=harness();await h.start();await h.request();const normal=structuredClone(h.capture.get());
 await h.getProvider().streamSimple(h.ctx.model,{messages:[]},{});assert.deepEqual(h.capture.get(),normal);
});
test('oversized and unserializable requests keep inference alive while dropping capture',async()=>{
 const h=harness();await h.start();await h.request();
 h.setPayload({messages:[{role:'user',content:'x'.repeat(16*1024*1024)}]});await h.request();assert.equal(h.capture.get(),undefined);
 const body:any={messages:[]};body.loop=body;h.setPayload(body);assert.equal(await h.request(),body);assert.equal(h.capture.get(),undefined);
});
test('a replaced custom provider is captured again on the next ordinary prompt',async()=>{
 const h=harness();await h.start();await h.request();
 let calls=0;h.replaceProvider({streamSimple:async(_m:any,_c:any,o:any)=>{calls++;return o.onPayload({messages:[{role:'system',content:'Replacement provider'}]})}});
 await h.start();await h.request();assert.equal(calls,1);assert.equal(h.capture.get()?.payload.messages[0].content,'Replacement provider');
});
test('capture snapshots canonical entries before asynchronous extension hook edits',async()=>{
 const h=harness();await h.start();const request=h.request(async()=>{h.entries[0].message.content='Changed after request began'});await request;
 const before=buildSessionProjection([{...h.entries[0],message:{...h.entries[0].message,content:'Verified original context'}}] as any,'entry');
 assert.deepEqual(h.capture.get()?.canonicalHashes,messageHashes(convertToLlm(before.messages)));
});

test('latest normal request wins even if an older asynchronous payload hook finishes last',async()=>{
 const h=harness();await h.start();const gate=deferred();const first=h.request(async()=>{await gate.promise;return {messages:[{role:'user',content:'Older request'}]}});await Promise.resolve();await Promise.resolve();
 await h.request(async()=>({messages:[{role:'user',content:'Latest request'}]}));gate.resolve();await first;
 assert.equal(h.capture.get()?.payload.messages[0].content,'Latest request');
});
test('large canonical context redacted to a small payload retains only digests and filtered data',async()=>{
 const h=harness();h.entries[0].message.content='x'.repeat(17*1024*1024);await h.start();const output=await h.request();
 assert.ok(output.messages.length);assert.ok(h.capture.get());assert.ok(JSON.stringify(h.capture.get()).length<2048);
 assert.equal('canonical' in h.capture.get()!,false);assert.equal('context' in h.capture.get()!,false);
});

test('screenshot-heavy requests retain one exact payload within the original safety limit',async()=>{
 const h=harness();const data='a'.repeat(12*1024*1024);
 h.entries[0].message.content=[{type:'text',text:'Verified screenshot'},{type:'image',data,mimeType:'image/png'}];
 const payload={messages:[{role:'user',content:[{type:'text',text:'Verified screenshot'},{type:'image_url',image_url:{url:'data:image/png;base64,'+data}}]}]};
 h.setPayload(payload);await h.start();await h.request();
 const snapshot=h.capture.get()!;assert.ok(snapshot);assert.deepEqual(snapshot.payload,payload);assert.ok(JSON.stringify(snapshot).length<13*1024*1024);
 await h.fire('message_end',{message:{role:'assistant',provider:'splash',model:'model',stopReason:'stop',usage:{input:12000}}});
 const projection=buildSessionProjection(h.entries,'entry');assert.equal(validateSnapshot(snapshot,h.ctx,projection,1),undefined);
 const summary=summaryPayload({messages:[{role:'user',content:'carrier'}],max_tokens:2048},snapshot,'Only summarize');assert.deepEqual(summary.messages.slice(0,-1),payload.messages);
 const changed=structuredClone(projection);changed.messages[0].content[1].data='b'+data.slice(1);
 assert.match(validateSnapshot(snapshot,h.ctx,changed,1)!,/edited/);
 payload.messages[0].content[0].text='Mutated after capture';assert.equal(snapshot.payload.messages[0].content[0].text,'Verified screenshot');
});

test('oversize and malformed captures explain their fallback and recover on the next request',async()=>{
 const h=harness();await h.start();h.setPayload({messages:[{role:'user',content:'x'.repeat(16*1024*1024)}]});await h.request();
 assert.equal(h.capture.get(),undefined);assert.match(h.capture.failureReason(),/exceeds 16 MiB safety limit \(\d+ bytes\)/);
 const projection=buildSessionProjection(h.entries,'entry');assert.equal(validateSnapshot(undefined,h.ctx,projection,1,h.capture.failureReason()),h.capture.failureReason());
 h.setPayload({messages:{}});await h.request();assert.equal(h.capture.failureReason(),'provider request format changed');
 const circular:any={messages:[]};circular.loop=circular;h.setPayload(circular);await h.request();assert.equal(h.capture.failureReason(),'provider request could not be captured safely');
 h.setPayload({messages:[{role:'user',content:'Recovered'}]});await h.request();assert.ok(h.capture.get());
});

test('an ignored provider registration is never treated as an owned adapter',async()=>{
 const h=harness();let attempts=0;h.pi.registerProvider=()=>attempts++;
 await h.start();await h.request(async(body:any)=>body);assert.equal(h.capture.get(),undefined);
 await h.start();assert.equal(attempts,2);
});

test('a captured payload is not cache-eligible until ordinary inference succeeds',async()=>{
 const h=harness();await h.start();await h.request();
 assert.equal(h.capture.get()?.confirmed,false);
 await h.fire('message_end',{message:{role:'assistant',provider:'splash',model:'model',stopReason:'stop',usage:{input:100,cacheRead:0}}});
 assert.equal(h.capture.get()?.confirmed,true);
});
test('rejected, cancelled and unmetered requests never become cached summary inputs',async()=>{
 for(const stopReason of ['error','aborted']){
  const h=harness();await h.start();await h.request();
  await h.fire('message_end',{message:{role:'assistant',provider:'splash',model:'model',stopReason,usage:{input:0,cacheRead:0}}});
  assert.equal(h.capture.get(),undefined);
 }
 const h=harness();await h.start();await h.request();
 await h.fire('message_end',{message:{role:'assistant',provider:'splash',model:'model',stopReason:'stop',usage:{input:0,cacheRead:0}}});
 assert.equal(h.capture.get()?.confirmed,false);
});
test('helper/model responses cannot confirm or invalidate another request',async()=>{
 const h=harness();await h.start();await h.request();
 await h.fire('message_end',{message:{role:'assistant',provider:'other',model:'model',stopReason:'error',usage:{input:100}}});
 assert.equal(h.capture.get()?.confirmed,false);
});
