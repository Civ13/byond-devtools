import test from 'node:test';import assert from 'node:assert/strict';import {boundedJson} from '../src/json.js';
test('JSON preflight rejects amplified or oversized output',()=>{
 assert.throws(()=>boundedJson({text:'x'.repeat(1000)},100),/output limit/);
 assert.throws(()=>boundedJson(Array(1000).fill({text:'x'.repeat(1000)}),10000),/output limit/);
 assert.deepEqual(JSON.parse(boundedJson({a:[1,'x',null]})),{a:[1,'x',null]});
});
