import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {capabilitiesFor, configureEngineCapabilities, hasCapability} from './engine-capabilities';
import {summaryThinkingBudget, briefReasoningEnabled} from './summary-thinking';
import {isSushiPrefillRefusal} from './summary-recovery';
import {normalizeSplashError} from './provider-errors';
import {supportsRequestCapture} from './request-snapshot';

const LOOPBACK = 'http://127.0.0.1:8000/v1';
const sushi = {provider: 'sushi', api: 'openai-completions', id: 'qwen-sushi', baseUrl: LOOPBACK};
const splash = {provider: 'splash', api: 'openai-completions', id: 'qwen-splash', baseUrl: 'http://localhost:1234/v1'};
const omlx = {provider: 'omlx', api: 'openai-completions', id: 'qwen', baseUrl: 'http://127.0.0.1:8001/v1'};
const other = {provider: 'vendorx', api: 'openai-completions', id: 'model-x', baseUrl: 'https://api.vendorx.test/v1'};

test('the built-in grants reproduce the historical provider-id behaviour', () => {
  assert.deepEqual([...capabilitiesFor(sushi)].sort(), ['briefReasoningInstruction', 'prefillCapacityRecovery', 'reasoningBudget']);
  assert.deepEqual([...capabilitiesFor(splash)].sort(), ['engineRestartErrors', 'outputHeadroomGuard', 'prefixCacheCapture']);
  assert.deepEqual([...capabilitiesFor(omlx)], ['prefixCacheCapture']);
  assert.equal(capabilitiesFor(other).size, 0);
});

test('a grant does not override a consumer\'s own request-shape requirement', () => {
  configureEngineCapabilities({'*': 'all'});
  assert.equal(hasCapability({...sushi, api: 'anthropic-messages'}, 'reasoningBudget'), true);
  assert.equal(summaryThinkingBudget({...sushi, api: 'anthropic-messages'}, 512, 4096), undefined);
  // Restart-error classification never required a request shape, and still does not.
  assert.match(normalizeSplashError({provider: 'splash'}, {stopReason: 'error', errorMessage: 'the inference engine stopped unexpectedly and is restarting; retry the request'}).errorMessage, /^503 Service unavailable/);
  configureEngineCapabilities(undefined);
});

test('a novel engine id can be granted capabilities without a code change', () => {
  configureEngineCapabilities({vendorx: ['reasoningBudget', 'prefixCacheCapture']});
  assert.equal(hasCapability(other, 'reasoningBudget'), true);
  assert.equal(summaryThinkingBudget({...other, baseUrl: LOOPBACK}, 512, 4096), 512);
  assert.equal(supportsRequestCapture(other), true);
  configureEngineCapabilities(undefined);
});

test('loopback transport trust is still required for a generation-time budget', () => {
  configureEngineCapabilities({vendorx: ['reasoningBudget']});
  assert.equal(summaryThinkingBudget(other, 512, 4096), undefined, 'https host');
  assert.equal(summaryThinkingBudget({...other, baseUrl: LOOPBACK}, 512, 4096), 512);
  configureEngineCapabilities(undefined);
});

test('"none" removes built-in grants and a later rule can re-add a subset', () => {
  configureEngineCapabilities({'*': 'none', sushi: ['reasoningBudget']});
  assert.deepEqual([...capabilitiesFor(sushi)], ['reasoningBudget']);
  assert.equal(capabilitiesFor(splash).size, 0);
  configureEngineCapabilities(undefined);
});

test('"all" grants every capability and an invalid list contributes nothing', () => {
  configureEngineCapabilities({'sushi/*': 'all'});
  assert.equal(capabilitiesFor(sushi).size, 6);
  configureEngineCapabilities({'vendorx': ['not-a-capability', 'prefixCacheCapture']});
  assert.deepEqual([...capabilitiesFor(other)], ['prefixCacheCapture']);
  configureEngineCapabilities(undefined);
});

test('provider/modelId globs are more specific than a provider rule', () => {
  configureEngineCapabilities({'vendorx': ['prefixCacheCapture'], 'vendorx/experimental-*': 'none'});
  assert.equal(hasCapability({...other, id: 'experimental-v2'}, 'prefixCacheCapture'), false);
  assert.equal(hasCapability(other, 'prefixCacheCapture'), true);
  configureEngineCapabilities(undefined);
});

test('focused extraction needs both the instruction capability and a valid budget', () => {
  assert.equal(briefReasoningEnabled(sushi, true, true), true);
  assert.equal(briefReasoningEnabled(sushi, true, false), false, 'no generation-time budget configured');
  assert.equal(briefReasoningEnabled(sushi, undefined, true), false, 'user has not opted in');
  configureEngineCapabilities({vendorx: ['briefReasoningInstruction']});
  assert.equal(briefReasoningEnabled(other, true, true), true);
  configureEngineCapabilities(undefined);
});

test('capacity and restart-error handling follows capabilities, not provider ids', () => {
  const capacityMessage = 'Context 128778 does not fit available GPU memory at KV8, prefill chunk 512. Maximum context: 98862 tokens. Reduce context or free memory.';
  assert.equal(isSushiPrefillRefusal(sushi, capacityMessage), true);
  assert.equal(isSushiPrefillRefusal(other, capacityMessage), false);
  configureEngineCapabilities({vendorx: ['prefillCapacityRecovery', 'engineRestartErrors']});
  const loopbackOther = {...other, baseUrl: LOOPBACK};
  assert.equal(isSushiPrefillRefusal(loopbackOther, capacityMessage), true);
  const restarting = {stopReason: 'error', errorMessage: 'the inference engine stopped unexpectedly and is restarting; retry the request'};
  assert.match(normalizeSplashError(other, restarting).errorMessage, /^503 Service unavailable/);
  configureEngineCapabilities(undefined);
});
test('engine gates do not hard-code provider ids', () => {
  for (const file of ['summary-thinking.ts', 'summary-recovery.ts', 'provider-errors.ts', 'request-headroom.ts']) {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.equal(/provider\s*[!=]==?\s*["'](sushi|splash|omlx)["']/.test(source), false, `${file} gates on a provider id`);
    assert.equal(/["'](sushi|splash|omlx)["']\s*\]?\.includes\(.*provider/.test(source), false, `${file} gates on a provider list`);
  }
});

test('configured rules are validated instead of silently widening behaviour', () => {
  configureEngineCapabilities({vendorx: 'maybe'} as never);
  assert.equal(capabilitiesFor(other).size, 0);
  configureEngineCapabilities(undefined);
});
