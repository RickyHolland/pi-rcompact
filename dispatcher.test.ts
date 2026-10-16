import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createRequestCapture,supportsRequestCapture,messageHashes} from './request-snapshot';
import {buildSessionProjection,convertToLlm} from '@earendil-works/pi-coding-agent';
let fixtureId=0;
function sharedHarness() {
 const id='local-frozen-fixture-'+(++fixtureId);let configured:any;let frozen=false;let attempts=0;
 const delegate=async (_m:any,_c:any,o:any={})=>o.onPayload?o.onPayload({messages:[{role:'user',content:'ordinary'}]}):{messages:[{role:'user',content:'ordinary'}]};
 let provider:any={streamSimple:delegate};
 const registry={getProvider:()=>provider,getRegisteredProviderConfig:()=>configured};
 function client(sessionId:string) {
  const handlers=new Map<string,Function[]>();
  const pi:any={on:(event:string,h:Function)=>handlers.set(event,[...(handlers.get(event)??[]),h]),registerProvider:(_id:string,c:any)=>{attempts++;if(!frozen){configured=c;provider={streamSimple:c.streamSimple}}}};
  const entries:any[]=[{type:'message',id:sessionId+'entry',parentId:null,timestamp:'2026-10-03T00:00:00Z',message:{role:'user',content:'private-'+sessionId,timestamp:1}}];
  const ctx:any={model:{provider:id,api:'openai-completions',baseUrl:'http://127.0.0.1:1234/v1',id:'model'},thinkingLevel:'medium',sessionManager:{getSessionId:()=>sessionId,getEntries:()=>entries,getLeafId:()=>entries.at(-1).id},modelRegistry:registry};
  const capture=createRequestCapture(pi,{providers:[id],streamSimple:delegate});
  const fire=async(event:string)=>{for(const h of handlers.get(event)??[])await h({},ctx)};
  const begin=async()=>{await fire('before_agent_start');await fire('context_with_system')};
  const send=(onPayload?:Function)=>provider.streamSimple(ctx.model,{messages:[{role:'user',content:'private-'+sessionId}]},{sessionId,reasoning:'medium',onPayload:async(body:any)=>{await fire('before_provider_request');return onPayload?onPayload(body):body}});
  return {ctx,capture,fire,begin,send};
 }
 return {client,freeze:()=>frozen=true,attempts:()=>attempts};
}

test('startup dispatcher captures final replacement on a frozen provider registry',async()=>{
 const h=sharedHarness();const c=h.client('first');h.freeze();await c.begin();
 const result=await c.send(async()=>({messages:[{role:'system',content:'final arbitrary hook rewrite'}],tools:[{function:{name:'future'}}]}));
 assert.deepEqual(c.capture.get()?.payload,result);assert.equal(h.attempts(),1);
});
test('shared frozen runtime keeps independent live sessions isolated',async()=>{
 const h=sharedHarness();const a=h.client('first');h.freeze();const b=h.client('second');await a.begin();await b.begin();
 await b.send(async()=>({messages:[{role:'user',content:'payload-second'}]}));await a.send(async()=>({messages:[{role:'user',content:'payload-first'}]}));
 assert.equal(a.capture.get()?.payload.messages[0].content,'payload-first');assert.equal(b.capture.get()?.payload.messages[0].content,'payload-second');
 assert.deepEqual(a.capture.get()?.canonicalHashes,messageHashes(convertToLlm(buildSessionProjection(a.ctx.sessionManager.getEntries(),a.ctx.sessionManager.getLeafId()).messages)));
 assert.notDeepEqual(a.capture.get()?.canonicalHashes,b.capture.get()?.canonicalHashes);
});
test('inactive duplicate session observer does not block a subsequent SDK client',async()=>{
 const h=sharedHarness();const a=h.client('same');h.freeze();await a.begin();await a.send();const b=h.client('same');await b.begin();await b.send();assert.ok(b.capture.get());
});
test('simultaneous clients with identical session IDs cannot steal captures',async()=>{
 const h=sharedHarness();const a=h.client('same');h.freeze();const b=h.client('same');await a.begin();await b.begin();
 const output=await a.send();assert.ok(output.messages.length);assert.equal(a.capture.get(),undefined);assert.equal(b.capture.get(),undefined);
});
test('shutdown detaches old dispatcher observer before reload',async()=>{
 const h=sharedHarness();const a=h.client('same');h.freeze();await a.begin();await a.fire('session_shutdown');const b=h.client('same');await b.begin();await b.send();assert.ok(b.capture.get());assert.equal(a.capture.get(),undefined);
});
test('capture supports oMLX and arbitrary loopback OpenAI inference engines',()=>{
 assert.equal(supportsRequestCapture({provider:'omlx',api:'openai-completions'}),true);
 assert.equal(supportsRequestCapture({provider:'custom-local',api:'openai-completions',baseUrl:'http://localhost:9999/v1'}),true);
 assert.equal(supportsRequestCapture({provider:'remote',api:'openai-completions',baseUrl:'https://api.example.com/v1'}),false);
 assert.equal(supportsRequestCapture({provider:'omlx',api:'anthropic-messages'}),false);
});
