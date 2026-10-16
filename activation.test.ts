import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {capturedActivation} from './activation';
test('captured activation defaults to verified zero input and cache prices',()=>{
 const m={id:'Qwen[Next]',provider:'sushi',cost:{input:0,cacheRead:0}};
 assert.equal(capturedActivation(m).enabled,true);
 for(const cost of [undefined,{input:0},{input:1,cacheRead:0},{input:0,cacheRead:1},{input:'0',cacheRead:0}])assert.equal(capturedActivation({...m,cost}).enabled,false);
});
test('explicit model globs override price metadata and escape regex punctuation',()=>{
 const m={id:'Qwen[Next]',provider:'sushi'};
 for(const patterns of [['sushi/*'],['Qwen?Next?'],['Qwen[Next]']])assert.equal(capturedActivation(m,patterns).enabled,true);
 for(const patterns of [[],['other/*'],['Qwen(Next)'],['']])assert.equal(capturedActivation(m,patterns).enabled,false);
});
