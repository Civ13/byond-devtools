import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDmm, DmmError } from '../src/dmm.js';
const d='"a"=(/obj/item{name="x, ) }"; values=list(1,list(2,3))},/obj/item,/turf/floor,/area/a)\n"b"=(/turf/wall,/area/b)\n';
const grid='(1,1,1)={"\nab\nba\n"}';
test('ordered duplicate atoms and opaque overrides are preserved',()=>{
 const m=parseDmm(d+grid); const a=m.inspectCell(1,2,1).atoms;
 assert.equal(a.length,4); assert.equal(a[0].path,a[1].path); assert.match(a[0].overridesRaw,/list\(2,3\)/);
 assert.equal(m.source,d+grid); assert.equal(m.inspectCell(2,2,1).key,'b');
 assert.equal(m.inspectCell(1,1,1).key,'b'); assert.equal(m.inspectCell(3,1,1),null);
});
test('per-block coordinates support offset blocks and z planes',()=>{
 const m=parseDmm(d+'(10,20,2)={"\nab\nba\n"}\n(2,3,1)={"\na\n"}');
 assert.equal(m.inspectCell(10,21,2).key,'a'); assert.equal(m.inspectCell(10,20,2).key,'b');
 assert.equal(m.inspectCell(2,3,1).key,'a'); assert.deepEqual(m.summary().levels,[1,2]);
});
test('TGM single-column blocks preserve axes',()=>{
 const m=parseDmm(d+'(1,1,1)={"\na\nb\n"}\n(2,1,1)={"\nb\na\n"}');
 assert.equal(m.inspectCell(1,2,1).key,'a'); assert.equal(m.inspectCell(2,1,1).key,'a');
});
test('dictionary aliases are not normalized',()=>{const m=parseDmm('"a"=(/turf/a,/area/a)\n"b"=(/turf/a,/area/a)\n'+grid); assert.equal(m.definitions.length,2);});
test('summary counts instances, search counts cells with bounded results',()=>{
 const m=parseDmm(d+grid); assert.equal(m.summary().types.find(t=>t.path==='/obj/item').instances,4);
 const r=m.find('/obj',{includeSubtypes:true,limit:1});assert.equal(r.matchedCells,2); assert.equal(r.results.length,1);assert.equal(r.truncated,true);
 assert.equal(m.find('/obj',{includeSubtypes:false}).matchedCells,0);
 assert.equal(m.find('/obj/item',{offset:1,limit:1}).truncated,false);
});
test('snapshots cannot be mutated through public objects',()=>{
 const m=parseDmm(d+grid); assert.throws(()=>m.blocks.push({}));assert.throws(()=>m.inspectCell(1,2,1).atoms[0].path='/x');assert.throws(()=>m.definitions[0].atoms.pop());
});
test('comments and escaped resource/string values are data',()=>{
 const text='// header\n"a"=(/obj/a{icon=\'icons/a.dmi\';name="a\\\"b"},/* fine */ /turf/a,/area/a)\n(1,1,1)={"\na\n"}';
 // Comments around atoms are deliberately not accepted; no silent data loss.
 assert.throws(()=>parseDmm(text),DmmError);
 const m=parseDmm(text.replace('/* fine */ ','')); assert.match(m.inspectCell(1,1,1).atoms[0].overridesRaw,/icons/);
});
const invalid=[
 ['duplicate key',d+'"a"=(/turf/a)\n'+grid],['undefined key',d+'(1,1,1)={"\nc\n"}'],
 ['width',d+'(1,1,1)={"\nab\na\n"}'],['mixed keys','"a"=(/turf/a)\n"bb"=(/turf/b)\n'+grid],
 ['overlap',d+grid+grid],['zero',d+'(0,1,1)={"\na\n"}'],['negative',d+'(-1,1,1)={"\na\n"}'],
 ['overflow',d+'(9007199254740991,1,1)={"\naa\n"}'],['junk',d+grid+'oops'],
 ['unbalanced','"a"=(/obj/a{v=list(1,2]},/turf/a)\n'+grid],['extra overrides','"a"=(/obj/a{v=1}{v=2})\n(1,1,1)={"\na\n"}'],
 ['unclosed comment',d+grid+'/*'],['empty map',''],['bad path','"a"=(run_code())\n'+grid],['blank grid',d+'(1,1,1)={"\n\n"}']
];
for(const [name,text] of invalid)test(`reject ${name}`,()=>assert.throws(()=>parseDmm(text),DmmError));
test('limits bound input before expansion',()=>{
 assert.throws(()=>parseDmm(d+grid,{maxCells:3}),/Cell limit/); assert.throws(()=>parseDmm(d+grid,{maxBytes:4}),/byte limit/);
 assert.throws(()=>parseDmm(d+grid,{maxDepth:1}),/Nesting limit/); assert.throws(()=>parseDmm(d+grid,{maxCells:Infinity}),TypeError);
 assert.throws(()=>parseDmm(d+grid,{maxBlocks:1,maxDictionary:1}),/Dictionary limit/);
});
test('CRLF grid support and coordinate argument validation',()=>{const m=parseDmm((d+grid).replaceAll('\n','\r\n'));assert.equal(m.cellCount,4);assert.throws(()=>m.inspectCell(NaN,1,1),TypeError);});
test('generated 350k cell workload',()=>{
 const row='a'.repeat(500);const block=Array(350).fill(row).join('\n');
 const m=parseDmm('"a"=(/turf/a,/area/a)\n(1,1,1)={"\n'+block+'\n"}\n(1,1,2)={"\n'+block+'\n"}');
 assert.equal(m.cellCount,350000);assert.equal(m.find('/turf/a',{limit:1}).matchedCells,350000);assert.equal(m.inspectCell(500,350,2).key,'a');
});

test('expression segment limit enforced while splitting',()=>{assert.throws(()=>parseDmm(d+grid,{maxAtomsPerTile:2}),/segment limit/);});

test('row count limit enforced before split expansion',()=>{assert.throws(()=>parseDmm('"a"=(/turf/a)\n(1,1,1)={"\na\na\na\n"}',{maxCells:2}),/Cell limit/);});
test('find results do not duplicate large shared overrides',()=>{
 const m=parseDmm('"a"=(/obj/a{name="'+'x'.repeat(100000)+'"},/turf/a,/area/a)\n(1,1,1)={"\n'+'a'.repeat(10000)+'\n"}');
 const r=m.find('/obj/a',{limit:10000});assert.equal(r.results.length,10000);assert.equal('atoms' in r.results[0],false);assert.ok(JSON.stringify(r).length<600000);
});
