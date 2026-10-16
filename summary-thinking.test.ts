import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {summaryThinkingBudget,applySummaryThinking,summaryReasoningInstruction,BRIEF_SUMMARY_REASONING,summaryOutputLimit} from './summary-thinking';
const model={provider:'sushi',api:'openai-completions',baseUrl:'http://127.0.0.1:8000/v1'};
test('brief extraction changes only the appended summary instruction when enabled',()=>{
 const original='Preserve verified facts and the next step.';
 assert.equal(summaryReasoningInstruction(original,false),original);
 assert.equal(summaryReasoningInstruction(original,true),original+BRIEF_SUMMARY_REASONING);
});
test('Sushi summary budgets are independent of normal Pi reasoning',()=>{
 for(const level of ['off','low','medium','xhigh'])assert.equal(summaryThinkingBudget({...model,thinkingLevel:level},512,10000),512);
});
test('invalid settings remote endpoints and other providers retain their original policy',()=>{
 for(const value of [undefined,null,-1,1.2,NaN,Infinity,'512',true,'low','auto'])assert.equal(summaryThinkingBudget(model,value,10000),undefined);
 for(const m of [{...model,provider:'splash'},{...model,provider:'omlx'},{...model,baseUrl:'https://127.0.0.1:8000/v1'},{...model,baseUrl:'http://example.com/v1'},{...model,api:'anthropic-messages'}])assert.equal(summaryThinkingBudget(m,512,10000),undefined);
});
test('zero thinking and bounded answer headroom remain explicit',()=>{
 assert.equal(summaryThinkingBudget(model,0,10000),0);
 assert.equal(summaryThinkingBudget(model,999999,2048),1024);
 assert.equal(summaryThinkingBudget(model,512,1000),undefined);
});
test('generation budget leaves captured prefix tools and thinking template byte identical',()=>{
 const body={messages:[{role:'system',content:'prefix'},{role:'user',content:'evidence'},{role:'system',content:'summary'}],tools:[{function:{name:'read'}}],reasoning_effort:'medium',chat_template_kwargs:{enable_thinking:true},max_tokens:4096};
 const original=JSON.stringify(body),out=applySummaryThinking(body,512);
 assert.equal(out.reasoning_budget_tokens,512);assert.equal(JSON.stringify(body),original);
 const {reasoning_budget_tokens,...rest}=out;assert.deepEqual(rest,body);
 assert.equal(applySummaryThinking(body,undefined),body);
});

test('summary output headroom is independent of the normal model output ceiling',()=>{
 assert.equal(summaryOutputLimit(model,8192,26214),8192);assert.equal(summaryOutputLimit(model,8192,4000),4000);
 for(const setting of [undefined,null,0,512,NaN,'8192',1.1])assert.equal(summaryOutputLimit(model,setting,26214),26214);
 assert.equal(summaryOutputLimit({...model,provider:'splash'},8192,26214),26214);
});
