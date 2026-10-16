import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {normalizeSplashError,classifySplashStream} from './provider-errors';
import {isRetryableAssistantError} from '@earendil-works/pi-ai/compat';
const error={stopReason:'error',errorMessage:'the inference engine stopped unexpectedly and is restarting; retry the request'};
test('Splash streamed recovery is recognized by the real Pi retry classifier',()=>{
 assert.equal(isRetryableAssistantError(error as any),false);
 const fixed=normalizeSplashError({provider:'splash'},error);
 assert.equal(isRetryableAssistantError(fixed),true);assert.equal(error.errorMessage.startsWith('503'),false);
 assert.equal(normalizeSplashError({provider:'splash'},fixed),fixed);
});
test('fatal, validation, cancelled, and other provider messages are unchanged',()=>{
 for(const message of [{stopReason:'error',errorMessage:'context_length_exceeded'}, {stopReason:'error',errorMessage:'engine failed permanently'}, {...error,stopReason:'aborted'}])assert.equal(normalizeSplashError({provider:'splash'},message),message);
 assert.equal(normalizeSplashError({provider:'omlx'},error),error);
});
test('terminal event and result agree without changing ordinary stream methods',async()=>{
 const source={value:4,method(){return this.value},result:async()=>error,async *[Symbol.asyncIterator](){yield {type:'text_delta',delta:'hello'};yield {type:'error',error};}};
 const wrapped=classifySplashStream({provider:'splash'},source),events=[];
 for await(const event of wrapped)events.push(event);
 assert.equal(events[0].delta,'hello');assert.deepEqual(events[1].error,await wrapped.result());assert.equal(wrapped.method(),4);assert.equal(source.result.constructor.name,'AsyncFunction');
 assert.equal(classifySplashStream({provider:'splash'},Promise.resolve(4)) instanceof Promise,true);
});
