/** Bounded metadata only. No prompts, summaries, file paths or provider errors. */
import {mkdirSync,readdirSync,statSync,unlinkSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {getAgentDir} from '@earendil-works/pi-coding-agent';
import {TELEMETRY_DIRECTORY} from './identifiers';
import {writeFileAtomic} from './atomic-write';
import {VERSION} from './version';
const finite=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:undefined;
export function providerMeasurements(chunk:any):Record<string,number> {
 const out:Record<string,number>={};const u=chunk?.usage;
 if(u&&typeof u==='object'){
  for(const [key,field,mult] of [
   ['providerTtftMs','time_to_first_token',1000],['providerPrefillMs','prompt_eval_duration',1000],['providerGenerationMs','generation_duration',1000],['providerTotalMs','total_time',1000],['providerLoadMs','model_load_duration',1000],['providerPrefillTokensPerSecond','prompt_tokens_per_second',1],['providerGenerationTokensPerSecond','generation_tokens_per_second',1]
  ] as const){const value=finite(u[field]);if(value!==undefined)out[key]=value*mult;}
  const thinking=finite(u.completion_tokens_details?.reasoning_tokens);if(thinking!==undefined)out.thinkingTokens=thinking;
 }
 const latency=chunk?.metrics?.request_latency;
 if(latency&&typeof latency==='object')for(const [key,field] of [
  ['providerTtftMs','ttft_ms'],['providerStartToFirstTokenMs','start_to_first_token_ms'],['providerQueueMs','queue_to_start_ms'],['providerGenerationMs','first_token_to_done_ms'],['providerTotalMs','wall_ms'],['providerGenerationTokensPerSecond','stream_tokens_per_second']
 ] as const){const value=finite(latency[field]);if(value!==undefined)out[key]=value;}
 for(const [key,field] of [['providerProcessedPromptTokens','prefill'],['providerDecodeTokens','decode']] as const){const value=finite(chunk?.metrics?.[field]?.tokens);if(value!==undefined)out[key]=value;}
 // llama.cpp-style timings are also emitted by Sushi. They describe native
 // prefill/decode work, not HTTP queueing, loading or first-token latency.
 const timings=chunk?.timings;
 if(timings&&typeof timings==='object'){
  for(const [key,field] of [
   ['providerPrefillMs','prompt_ms'],['providerGenerationMs','predicted_ms'],
   ['providerPrefillTokensPerSecond','prompt_per_second'],['providerGenerationTokensPerSecond','predicted_per_second'],
   ['providerDecodeTokens','predicted_n'],['providerTokenizeMs','tokenize_ms']
  ] as const){const value=finite(timings[field]);if(value!==undefined&&out[key]===undefined)out[key]=value;}
  const prompt=finite(timings.prompt_n),cached=finite(timings.cached_n??timings.cache_n);
  if(out.providerProcessedPromptTokens===undefined&&prompt!==undefined&&cached!==undefined&&cached<=prompt)out.providerProcessedPromptTokens=prompt-cached;
 }
 return out;
}
export function errorCategory(error:any):string {
 const message=String(error?.message??error);
 if(/evidence review|evidence verification/i.test(message))return "summary_verification";
 if(/abort|cancel/i.test(message))return 'cancelled';
 if(/token cap|incomplete|checkpoint structure/i.test(message))return 'incomplete_summary';
 if(/tool/i.test(message))return 'unexpected_tool_call';
 if(/no text|without a result/i.test(message))return 'empty_summary';
 if(/Summarization failed/i.test(message))return 'provider_error';
 return 'extension_error';
}
export function createCompactionTelemetry(ctx:any,event:any) {
 const startedAt=Date.now(),started=performance.now();const id=randomUUID();
 const directory=join(getAgentDir(),TELEMETRY_DIRECTORY);
 const record:any={schemaVersion:1,extensionVersion:VERSION,id,processPid:process.pid,sessionId:ctx.sessionManager.getSessionId(),provider:ctx.model?.provider,model:ctx.model?.id,reason:event.reason??'manual',willRetry:event.willRetry===true,status:'running',phase:'preparing',startedAt,updatedAt:startedAt,tokensBefore:finite(event.preparation?.tokensBefore),attempts:0};
 const persist=()=>{
  try{
   mkdirSync(directory,{recursive:true,mode:0o700});
   writeFileAtomic(join(directory,id+'.json'),JSON.stringify(record)+'\n',{mode:0o600,backup:false});
  }catch{/* Monitoring must never fail compaction. */}
 };
 const update=(data:Record<string,unknown>)=>{Object.assign(record,data,{updatedAt:Date.now(),elapsedMs:performance.now()-started});persist();};
 update({});
 // Bound retained attempts across restarts. Running attempts stay available.
 try{
  const files=readdirSync(directory).filter(f=>/^[a-f0-9-]{36}\.json$/.test(f)).map(f=>({file:f,mtime:statSync(join(directory,f)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime);
  for(const entry of files.slice(250)){
   const path=join(directory,entry.file);
   if(Date.now()-entry.mtime>86400000||JSON.parse(readFileSync(path,'utf8')).status!=='running')unlinkSync(path);
  }
 }catch{}
 return {id,update,finish:(status:string,data:Record<string,unknown>={})=>update({...data,status,phase:status,finishedAt:Date.now(),totalMs:performance.now()-started}),record};
}
