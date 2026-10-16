import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {fitOutputBudget,createHeadroomGuard} from './request-headroom';

test('real failed Pi request fits after final tools are accounted for',()=>{
 const body={max_tokens:32768,messages:[{role:'user',content:'done'}],tools:[{function:{name:'new_tool'}}]};
 const result=fitOutputBudget(body,98830,131072);
 assert.equal(result.max_tokens,32242);assert.equal(body.max_tokens,32768);
 assert.equal(result.messages,body.messages);assert.equal(result.tools,body.tools);
});
test('small requests and intentionally smaller limits stay unchanged',()=>{
 const body={max_tokens:2048};assert.equal(fitOutputBudget(body,500,131072),body);
 assert.equal(fitOutputBudget({max_completion_tokens:32768},98830,131072).max_completion_tokens,32242);
 const brief={max_tokens:128};assert.equal(fitOutputBudget(brief,130900,131072),brief,'An intentionally short reply already fitting the context must not force compaction');
 const defaults={messages:[]};assert.equal(fitOutputBudget(defaults,500,131072),defaults,'Native default output limits must stay native');
});
test('no safe continuation headroom enters existing Pi overflow recovery',()=>{
 assert.throws(()=>fitOutputBudget({max_tokens:32768},131000,131072),/context_length_exceeded/);
 assert.throws(()=>fitOutputBudget({max_tokens:1,max_completion_tokens:1},10,131072),/Conflicting/);
});
test('native tokenizer sees final arbitrary tool and context rewrites',async()=>{
 const calls:any[]=[];
 const f:any=async(url:string,options:any)=>{
  calls.push({url,options});
  return {ok:true,json:async()=>url.endsWith('/status')?{schema_version:6,maximum_context_tokens:131072}:url.endsWith('/apply-template')?{prompt:'native-rendered'}:{tokens:Array(98830).fill(1)}};
 };
 const guard=createHeadroomGuard(f);
 const model={api:'openai-completions',provider:'splash',baseUrl:'http://127.0.0.1:8000/v1',contextWindow:131072};
 const body={messages:[{role:'user',content:'final rewrite'}],tools:[{function:{name:'arbitrary_future_extension'}}],max_tokens:32768};
 const result=await guard(model,body);
 assert.equal(result.inputTokens,98830);assert.equal(result.payload.max_tokens,32242);
 assert.deepEqual(JSON.parse(calls[1].options.body),body);
 assert.equal(calls[1].options.redirect,'error');
 await guard(model,body);assert.equal(calls.filter(c=>c.url.endsWith('/status')).length,1);
});
test('guard never sends prompts to remote or authenticated endpoints',async()=>{
 let calls=0;const guard=createHeadroomGuard((async()=>{calls++;throw Error('must not call')}) as any);
 for(const baseUrl of ['https://remote.example/v1','http://name:secret@127.0.0.1:8000/v1']){
  const body={messages:[],max_tokens:32768};assert.equal((await guard({api:'openai-completions',provider:'splash',baseUrl},body)).payload,body);
 }
 assert.equal(calls,0);
});
test('unavailable tokenizers preserve provider validation and cancellation',async()=>{
 const guard=createHeadroomGuard((async()=>{throw Error('offline')}) as any);
 const model={api:'openai-completions',provider:'splash',baseUrl:'http://127.0.0.1:8000/v1'};
 const body={messages:[],max_tokens:32768};assert.equal((await guard(model,body)).payload,body);
 const controller=new AbortController();controller.abort();
 await assert.rejects(()=>guard(model,body,controller.signal));
});
test('multimodal requests do not pretend text counts include vision embeddings',async()=>{
 let calls=0;
 const guard=createHeadroomGuard((async()=>{calls++;return {ok:true,json:async()=>({schema_version:6,maximum_context_tokens:131072})}}) as any);
 const body={messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}]}]};
 assert.equal((await guard({provider:'splash',api:'openai-completions',baseUrl:'http://127.0.0.1:8000/v1'},body)).payload,body);
 assert.equal(calls,1);
});
