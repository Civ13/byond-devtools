import test from 'node:test';import assert from 'node:assert/strict';import { mkdtemp,writeFile,symlink,rm } from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import { readProjectFile,inspectDme } from '../src/project.js';
import { spawnSync } from 'node:child_process';
test('DME inventory flags unresolved conditionals and skips comments',()=>{
 const r=inspectDme('// #include "bad.dm"\n#ifdef X\n#include "ok.dm"\n#endif\n/*\n#include "bad2.dm"\n*/');
 assert.equal(r.includes.length,1);assert.equal(r.includes[0].path,'ok.dm');assert.equal(r.includes[0].activation,'unknown-not-preprocessed');
});
test('filesystem containment, size, UTF8 and symlink escape',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'byond-tools-')); const outside=await mkdtemp(path.join(os.tmpdir(),'byond-outside-'));
 try{await writeFile(path.join(root,'ok'),'hello');await writeFile(path.join(outside,'out'),'private');
 assert.equal((await readProjectFile(root,'ok')).bytes,5);await assert.rejects(readProjectFile(root,'ok',2),/limit/);
 await assert.rejects(readProjectFile(root,path.join(outside,'out')),/relative/);
 await symlink(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');await assert.rejects(readProjectFile(root,'link/out'),/escapes/);
 await writeFile(path.join(root,'bad'),Buffer.from([255]));await assert.rejects(readProjectFile(root,'bad'));
 }finally{await rm(root,{recursive:true});await rm(outside,{recursive:true});}
});
test('CLI summary emits provenance and bounded JSON',()=>{
 const r=spawnSync(process.execPath,['src/cli.js','summary','--root','.','--map','fixtures/tiny.dmm'],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const j=JSON.parse(r.stdout);assert.equal(j.data.cellCount,4);assert.match(j.provenance.sha256,/^[a-f0-9]{64}$/);
});
test('CLI rejects invalid arguments without writes',()=>{
 for(const args of [['cell','--root','.','--map','fixtures/tiny.dmm','--x','1x'],['summary','--root','.','--map','fixtures/tiny.dmm','--evil','x']]){
 const r=spawnSync(process.execPath,['src/cli.js',...args],{encoding:'utf8'});assert.equal(r.status,1);assert.ok(JSON.parse(r.stderr).error);}
});

test('DME ignores include-looking text inside multiline strings',()=>{const r=inspectDme('var/x = {"\n#include "not-real.dm"\n"}\n#include "real.dm"');assert.deepEqual(r.includes.map(x=>x.path),['real.dm']);});
