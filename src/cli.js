#!/usr/bin/env node
import { boundedJson } from './json.js';
import { parseDmm } from './dmm.js';
import { readProjectFile, inspectDme } from './project.js';
const usage = `Usage: node src/cli.js <summary|cell|find|project> --root DIR --map FILE [--dme FILE]
  cell: --x N --y N --z N
  find: --type /path [--subtypes] [--limit N] [--offset N]
  project: --dme FILE (no --map needed)
Read-only authored-source inspection; no map writes, DM execution, or server access.`;
function options(args) {
  const opts = Object.create(null), allowed = new Set(['root','map','dme','x','y','z','type','subtypes','limit','offset']);
  for (let i=0;i<args.length;i++) {
    const flag=args[i]; if (!flag.startsWith('--') || !allowed.has(flag.slice(2))) throw new Error(`Unknown option ${flag}`);
    const key=flag.slice(2); if (key in opts) throw new Error(`Duplicate option --${key}`);
    if(key==='subtypes') opts[key]=true;
    else { if(i+1>=args.length || args[i+1].startsWith('--')) throw new Error(`Missing value for ${flag}`); opts[key]=args[++i]; }
  }
  return opts;
}
function integer(value, name, fallback) {
  if(value===undefined && fallback!==undefined) return fallback;
  if(typeof value!=='string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid --${name}`);
  return Number(value);
}
try {
  const [command,...args]=process.argv.slice(2);
  if(!command || command==='--help') { console.log(usage); process.exit(0); }
  if(!['summary','cell','find','project'].includes(command)) throw new Error('Unknown command');
  const opts=options(args); if(!opts.root) throw new Error('--root is required');
  const dme=opts.dme ? await readProjectFile(opts.root,opts.dme,16*1024*1024) : null;
  let result;
  if(command==='project') { if(!dme) throw new Error('--dme is required'); result={...inspectDme(dme.text),file:opts.dme,sha256:dme.sha256}; }
  else {
    if(!opts.map) throw new Error('--map is required');
    const input=await readProjectFile(opts.root,opts.map), map=parseDmm(input.text);
    const provenance={map:opts.map,sha256:input.sha256,bytes:input.bytes,truthLayer:'authored-source',dme:dme?{file:opts.dme,sha256:dme.sha256,resolution:'not-resolved'}:null};
    let data;
    if(command==='summary') data=map.summary();
    else if(command==='cell') data=map.inspectCell(integer(opts.x,'x'),integer(opts.y,'y'),integer(opts.z,'z'));
    else { if(!opts.type) throw new Error('--type is required'); data=map.find(opts.type,{includeSubtypes:!!opts.subtypes,limit:integer(opts.limit,'limit',100),offset:integer(opts.offset,'offset',0)}); }
    result={schemaVersion:1,provenance,data};
  }
  console.log(boundedJson(result));
} catch(error) { console.error(JSON.stringify({error:error.name,message:error.message})); process.exitCode=1; }
