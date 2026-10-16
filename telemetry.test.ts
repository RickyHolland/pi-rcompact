import {test} from 'bun:test';import assert from 'node:assert/strict';
import {providerMeasurements,errorCategory} from './compaction-telemetry';
test('oMLX stage measurements preserve units and exclude arbitrary stream content',()=>{
 const values=providerMeasurements({usage:{time_to_first_token:2.5,prompt_eval_duration:1.3,generation_duration:8,prompt_tokens_per_second:400,generation_tokens_per_second:35,completion_tokens_details:{reasoning_tokens:25},secret:'private'},choices:[{delta:{content:'secret'}}]});
 assert.deepEqual(values,{providerTtftMs:2500,providerPrefillMs:1300,providerGenerationMs:8000,providerPrefillTokensPerSecond:400,providerGenerationTokensPerSecond:35,thinkingTokens:25});
});
test('missing provider metrics remain unavailable instead of fabricated zeroes',()=>assert.deepEqual(providerMeasurements({usage:{prompt_tokens:500}}),{}));
test('Sushi native timings name prefill work without inventing queue or first-token latency',()=>{
 assert.deepEqual(providerMeasurements({timings:{prompt_n:1000,cached_n:800,prompt_ms:250,prompt_per_second:800,predicted_n:120,predicted_ms:2000,predicted_per_second:60,tokenize_ms:12}}),{providerPrefillMs:250,providerGenerationMs:2000,providerPrefillTokensPerSecond:800,providerGenerationTokensPerSecond:60,providerDecodeTokens:120,providerProcessedPromptTokens:200,providerTokenizeMs:12});
});
test('invalid or conflicting Sushi counters cannot create negative processed prompt counts',()=>{
 for(const v of [-1,true,'4',NaN,Infinity])assert.deepEqual(providerMeasurements({timings:{prompt_ms:v,predicted_ms:v}}),{});
 assert.equal(providerMeasurements({timings:{prompt_n:10,cached_n:20}}).providerProcessedPromptTokens,undefined);
 assert.equal(providerMeasurements({timings:{prompt_n:10}}).providerProcessedPromptTokens,undefined);
});
test('provider metrics reject negative, boolean, string and non-finite values',()=>{
 for(const v of [-1,true,'4',NaN,Infinity])assert.deepEqual(providerMeasurements({usage:{generation_duration:v}}),{});
});
test('telemetry error labels cannot expose raw provider credentials or prompts',()=>{
 assert.equal(errorCategory(new Error('Summarization failed: secret_api_key')),'provider_error');assert.equal(errorCategory('Compaction aborted'),'cancelled');assert.equal(errorCategory('generation hit the token cap'),'incomplete_summary');
});
test('Splash native request intervals stay distinct from GPU prefill work',()=>{
 assert.deepEqual(providerMeasurements({metrics:{request_latency:{ttft_ms:250,start_to_first_token_ms:200,queue_to_start_ms:50,first_token_to_done_ms:1000,wall_ms:1250,stream_tokens_per_second:36},prefill:{tokens:320},decode:{tokens:36},cache:{slot:12}}}),{providerTtftMs:250,providerStartToFirstTokenMs:200,providerQueueMs:50,providerGenerationMs:1000,providerTotalMs:1250,providerGenerationTokensPerSecond:36,providerProcessedPromptTokens:320,providerDecodeTokens:36});
});
