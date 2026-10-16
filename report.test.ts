import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {formatCompactionReport,measureCompactedContext} from './compaction-report';

const legacy={totalMs:12345,thinkingMs:0,cacheRead:0,timestamp:0};
test('completion report shows token reduction, summary, retention, cache and review',()=>{
 const text=formatCompactionReport({...legacy,tokensBefore:98420,tokensAfterEstimate:22180,summaryTokensEstimate:1860,retainedMessages:34,promptTokens:10000,cacheRead:9240,verificationStatus:'disabled'});
 assert.equal(text,'Compaction completed in 12.3s.\nContext (estimated): 98,420 → 22,180 tokens · 77.5% smaller (76,240 freed)\nSummary ≈1,860 tokens · Kept 34 messages · 92.4% summary input cached · Review off');
});
test('legacy persisted reports still render without inventing unavailable counts',()=>{
 assert.equal(formatCompactionReport(legacy),'Compaction completed in 12.3s.');
 assert.match(formatCompactionReport({...legacy,cacheRead:1200}),/1,200 summary input tokens from cache/);
});
test('zero-sized and expanded checkpoints are reported honestly',()=>{
 const text=formatCompactionReport({...legacy,tokensBefore:0,tokensAfterEstimate:10});
 assert.match(text,/0 → 10 tokens/);assert.doesNotMatch(text,/NaN|Infinity|smaller/);
 assert.match(formatCompactionReport({...legacy,tokensBefore:100,tokensAfterEstimate:150}),/50.0% larger \(50 added\)/);
 assert.match(formatCompactionReport({...legacy,tokensBefore:100,tokensAfterEstimate:0}),/100.0% smaller \(100 freed\)/);
});
test('invalid optional measurements are omitted instead of fabricated',()=>{
 const text=formatCompactionReport({...legacy,tokensBefore:NaN,tokensAfterEstimate:20,summaryTokensEstimate:-1,retainedMessages:Infinity,promptTokens:-2,cacheRead:NaN});
 assert.equal(text,'Compaction completed in 12.3s.');
});
test('retries and review calls appear alongside lifecycle timing',()=>{
 const text=formatCompactionReport({...legacy,thinkingMs:3000,attempts:3,retainedMessages:1,verificationStatus:'passed'});
 assert.match(text,/3.0s final-attempt thinking, 3 inference calls/);
 assert.match(text,/Kept 1 message · Review passed/);
});
test('applied projection token estimate includes summary and retained messages without trusting historical usage',()=>{
 const messages=[{role:'system',tokens:10},{role:'compactionSummary',tokens:20},{role:'assistant',tokens:30,usage:{input:999999}},{role:'toolResult',tokens:40}];
 assert.deepEqual(measureCompactedContext(messages,m=>m.tokens),{tokensAfterEstimate:100,summaryTokensEstimate:20,retainedMessages:2});
 assert.throws(()=>measureCompactedContext([{role:'user'}],()=>NaN));
});
