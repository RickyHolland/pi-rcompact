import { test } from "bun:test";
import assert from "node:assert/strict";
import { registerNormalThinkingRecovery } from "./normal-thinking-recovery";
function fixture(config:any={}) {
 const handlers=new Map<string,any>();const notices:string[]=[];
 const pi:any={registerEntryRenderer:()=>{},on:(name:string,handler:any)=>handlers.set(name,handler)};
 registerNormalThinkingRecovery(pi,()=>config);
 const ctx:any={cwd:"/fixture",model:{provider:"sushi",api:"openai-completions",baseUrl:"http://127.0.0.1:8000/v1",maxTokens:32768},sessionManager:{getSessionId:()=>"fixture"},hasPendingMessages:()=>false,hasUI:true,ui:{notify:(m:string)=>notices.push(m)}};
 handlers.get("before_agent_start")({},ctx);
 const event:any={outcome:"completed",continue:false,toolResults:[],context:{pendingMessages:[]},message:{role:"assistant",stopReason:"stop",content:[{type:"thinking",thinking:"I will act next."}]}};
 return {handlers,ctx,event,notices};
}
test("normal recovery is local Sushi only and excludes non-empty, failed and cancelled turns",()=>{
 for(const change of [
  (x:any)=>x.ctx.model.provider="other",(x:any)=>x.ctx.model.baseUrl="https://example.com/v1",
  (x:any)=>x.event.outcome="aborted",(x:any)=>x.event.outcome="error",
  ...["length","aborted","error"].map(stop=>(x:any)=>x.event.message.stopReason=stop),
  (x:any)=>x.event.message.content.push({type:"text",text:"Answer"}),
  (x:any)=>x.event.message.content.push({type:"toolCall",name:"write"}),
  (x:any)=>x.event.toolResults.push({role:"toolResult"}),
  (x:any)=>x.event.continue=true,(x:any)=>x.ctx.hasPendingMessages=()=>true,
 ]) {const x=fixture();change(x);assert.equal(x.handlers.get("turn_end")(x.event,x.ctx),undefined);}
});
test("exactly one continuation and one generation-budget override per user run",()=>{
 const x=fixture();const first=x.handlers.get("turn_end")(x.event,x.ctx);assert.equal(first.continue,true);assert.equal(first.entries[0].type,"custom_message");
 const payload={messages:[{role:"user",content:"facts"}],tools:[{type:"function"}],reasoning_effort:"medium",temperature:1};const before=JSON.stringify(payload);
 assert.deepEqual(x.handlers.get("before_provider_request")({payload},x.ctx),{...payload,reasoning_budget_tokens:0});assert.equal(JSON.stringify(payload),before);
 assert.equal(x.handlers.get("before_provider_request")({payload},x.ctx),undefined);
 const second=x.handlers.get("turn_end")(x.event,x.ctx);assert.equal(second.continue,undefined);assert.equal(second.entries[0].data.status,"exhausted");
 assert.equal(x.handlers.get("turn_end")(x.event,x.ctx),undefined);assert.equal(x.notices.length,2);
 x.handlers.get("before_agent_start")({},x.ctx);assert.equal(x.handlers.get("turn_end")(x.event,x.ctx).continue,true);
});
test("session shutdown, settled cancellation and model changes disarm the retry budget",()=>{
 for(const event of ["session_shutdown","session_start","agent_settled","model_select","thinking_level_select"]){
  const x=fixture();x.handlers.get("turn_end")(x.event,x.ctx);x.handlers.get(event)({},x.ctx);
  assert.equal(x.handlers.get("before_provider_request")({payload:{messages:[]}},x.ctx),undefined,event);
 }
});
test("normal recovery respects live settings and never affects ordinary requests",()=>{
 for(const config of [{enabled:false},{normalThinkingRecovery:false}]){const x=fixture(config);assert.equal(x.handlers.get("turn_end")(x.event,x.ctx),undefined);}
 const config:any={};const x=fixture(config);assert.equal(x.handlers.get("before_provider_request")({payload:{messages:[]}},x.ctx),undefined);
 x.handlers.get("turn_end")(x.event,x.ctx);config.normalThinkingRecovery=false;
 assert.equal(x.handlers.get("before_provider_request")({payload:{messages:[]}},x.ctx),undefined);
});

test("extension-triggered starts do not renew a consumed recovery allowance",()=>{
 const x=fixture();x.handlers.get("turn_end")(x.event,x.ctx);
 x.handlers.get("before_provider_request")({payload:{messages:[]}},x.ctx);
 x.handlers.get("before_agent_start")({messageType:"custom"},x.ctx);
 const result=x.handlers.get("turn_end")(x.event,x.ctx);
 assert.equal(result.continue,undefined);assert.equal(result.entries[0].data.status,"exhausted");
 x.handlers.get("before_agent_start")({messageType:"user",prompt:"new instruction"},x.ctx);
 assert.equal(x.handlers.get("turn_end")(x.event,x.ctx).continue,true);
});
