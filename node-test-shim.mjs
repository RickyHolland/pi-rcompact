import assert from 'node:assert/strict';
export {before as beforeAll, after as afterAll, describe, test} from 'node:test';
function subset(actual, expected) {
  for (const [key,value] of Object.entries(expected)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) subset(actual[key],value);
    else assert.deepEqual(actual[key],value);
  }
}
export function expect(value, message) {
  return {
    toBeDefined:()=>assert.notEqual(value,undefined,message),
    toMatchObject:expected=>subset(value,expected),
    toBe:expected=>assert.equal(value,expected,message),
    toContain:expected=>assert.ok(value.includes(expected),message),
    toEqual:expected=>assert.deepEqual(value,expected,message),
    toHaveLength:expected=>assert.equal(value.length,expected,message),
    toBeLessThan:expected=>assert.ok(value<expected,message),
    toBeGreaterThan:expected=>assert.ok(value>expected,message),
  };
}
