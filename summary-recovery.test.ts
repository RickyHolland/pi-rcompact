import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {isSushiPrefillRefusal,freshSummaryPrefix,isThinkingOnlySummary,needsSummaryFormatRecovery} from './summary-recovery';
const model={provider:'sushi',api:'openai-completions',baseUrl:'http://127.0.0.1:8000/v1'};
test('capacity recovery is specific to the known local Sushi prefill refusal',()=>{
 assert.equal(isSushiPrefillRefusal(model,'error.PrefillDoesNotFit'),true);
 assert.equal(isSushiPrefillRefusal(model,'Context 128778 does not fit available GPU memory at KV8, prefill chunk 512. Maximum context: 98862 tokens. Reduce context or free memory.'),true);
 for(const message of ['timeout','HTTP 503','Metal unhealthy','memory','PrefillDoesNotFitSomething',null])assert.equal(isSushiPrefillRefusal(model,message),false);
 for(const m of [{...model,provider:'splash'},{...model,baseUrl:'http://example.com/v1'}])assert.equal(isSushiPrefillRefusal(m,'PrefillDoesNotFit'),false);
});
test('cold recovery preserves all filtered messages tools sampling and template flags',()=>{
 const p={messages:[{role:'system',content:'Filtered system'},{role:'user',content:'[removed] evidence'},{role:'system',content:'Checkpoint'}],tools:[{type:'function',function:{name:'future_tool',description:'Original guidance',parameters:{type:'object',properties:{x:{type:'string'}}}}}],temperature:1,reasoning_effort:'medium',reasoning_budget_tokens:2048,chat_template_kwargs:{enable_thinking:true}};
 const before=JSON.stringify(p),out=freshSummaryPrefix(p,'one');assert.equal(JSON.stringify(p),before);
 assert.deepEqual(out.messages.slice(1),p.messages.slice(1));assert.ok(out.messages[0].content.endsWith(p.messages[0].content));
 assert.deepEqual({...out,messages:p.messages,tools:p.tools},p);assert.notEqual(out.messages[0].content,freshSummaryPrefix(p,'two').messages[0].content);
 assert.ok(out.tools[0].function.description.endsWith(p.tools[0].function.description));
 assert.deepEqual({...out.tools[0].function,description:p.tools[0].function.description},p.tools[0].function);
 assert.notEqual(out.tools[0].function.description,freshSummaryPrefix(p,'two').tools[0].function.description);
});
test('structured system blocks and systemless captures remain lossless',()=>{
 const blocks=[{type:'text',text:'[filtered]'},{type:'image_url',image_url:{url:'fixture'}}];
 const p={messages:[{role:'system',content:blocks},{role:'user',content:'facts'}]};assert.deepEqual(freshSummaryPrefix(p,'a').messages[0].content.slice(1),blocks);
 const q={messages:[{role:'user',content:'facts'}]};assert.deepEqual(freshSummaryPrefix(q,'a').messages.slice(1),q.messages);
});
test('unsafe capacity recovery payloads fail without substituting evidence',()=>{
 assert.throws(()=>freshSummaryPrefix({},'a'));assert.throws(()=>freshSummaryPrefix({messages:[{role:'system',content:null}]},'a'));
 assert.throws(()=>freshSummaryPrefix({messages:[],tools:[{type:'custom'}]},'a'));
});

test('empty-summary recovery only accepts successfully stopped thinking-only responses',()=>{
 const thinking={type:'thinking',thinking:'Fixture reasoning'};
 assert.equal(isThinkingOnlySummary({stopReason:'stop',content:[thinking,{type:'text',text:'  '}]}),true);
 for(const stopReason of ['length','aborted','error'])assert.equal(isThinkingOnlySummary({stopReason,content:[thinking]}),false);
 for(const content of [[],[{type:'text',text:''}],[thinking,{type:'text',text:'Summary'}],[thinking,{type:'toolCall',name:'read'}]])assert.equal(isThinkingOnlySummary({stopReason:'stop',content}),false);
});

test('format repair excludes unsuccessful stops, empty answers and tool calls',()=>{
 const content=[{type:'text',text:'Partial notes without checkpoint sections'}];
 assert.equal(needsSummaryFormatRecovery({stopReason:'stop',content}),true);
 for(const stopReason of ['length','aborted','error'])assert.equal(needsSummaryFormatRecovery({stopReason,content}),false);
 assert.equal(needsSummaryFormatRecovery({stopReason:'stop',content:[]}),false);
 assert.equal(needsSummaryFormatRecovery({stopReason:'stop',content:[...content,{type:'toolCall'}]}),false);
});
