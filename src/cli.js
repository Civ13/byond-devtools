#!/usr/bin/env node
import { boundedJson } from './json.js';
import { parseDmm } from './dmm.js';
import { readProjectFile, readProjectBytes, inspectDme, loadProjectTypes } from './project.js';
import { parseTypeTree, resolveVar, collectDefines, lintMap } from './typetree.js';
import { overrideAssignments } from './world.js';
import { decodeDmi } from './dmi.js';
import { loadRenderer, renderMap } from './render-project.js';
import { writeFile, lstat } from 'node:fs/promises';
const usage = `Usage: node src/cli.js <summary|cell|find|project|types|lint|icon|render> --root DIR --map FILE [--dme FILE]
  cell: --x N --y N --z N
  find: --type /path [--subtypes] [--limit N] [--offset N]
  project: --dme FILE (no --map needed)
  types: --dme FILE (--byond BIN | --tree FILE) [--type /path]   native type tree via DreamMaker -o
  lint: --map FILE --dme FILE (--byond BIN | --tree FILE)   unknown types and undefined vars; exit 3 on problems
  icon: --dmi FILE   DMI size, states, dirs, frames and delays (no --map needed)
  render: --map FILE --dme FILE (--byond BIN | --tree FILE) --out FILE.png [--z N] [--x1 N --y1 N --x2 N --y2 N]
          [--grid N] [--areas] [--show-invisible] [--icon-size N] [--force]
          static preview from authored source + type defaults (not a client screenshot); at most 128x128 tiles
Read-only authored-source inspection; no map writes, DM execution, or server access. render writes only --out.`;
function options(args) {
  const opts = Object.create(null), allowed = new Set(['root','map','dme','x','y','z','type','subtypes','limit','offset','byond','tree','dmi','out','x1','y1','x2','y2','grid','areas','show-invisible','icon-size','force']);
  for (let i=0;i<args.length;i++) {
    const flag=args[i]; if (!flag.startsWith('--') || !allowed.has(flag.slice(2))) throw new Error(`Unknown option ${flag}`);
    const key=flag.slice(2); if (key in opts) throw new Error(`Duplicate option --${key}`);
    if(['subtypes','areas','show-invisible','force'].includes(key)) opts[key]=true;
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
  if(!['summary','cell','find','project','types','lint','icon','render'].includes(command)) throw new Error('Unknown command');
  const opts=options(args); if(!opts.root) throw new Error('--root is required');
  const dme=opts.dme ? await readProjectFile(opts.root,opts.dme,16*1024*1024) : null;
  let result;
  if(command==='render') {
    if(!dme) throw new Error('--dme is required'); if(!opts.map) throw new Error('--map is required');
    if(!opts.out || !/\.png$/i.test(opts.out)) throw new Error('--out must name a .png file');
    let exists=false; try { exists=!!(await lstat(opts.out)); } catch {}
    if(exists && !opts.force) throw new Error(`${opts.out} exists; pass --force to overwrite`);
    const region={z:integer(opts.z,'z',1),grid:integer(opts.grid,'grid',0),areas:!!opts.areas,showInvisible:!!opts['show-invisible']};
    for(const k of ['x1','y1','x2','y2']) if(opts[k]!==undefined) region[k]=integer(opts[k],k);
    if(opts['icon-size']!==undefined) { region.iconSize=integer(opts['icon-size'],'icon-size'); if(region.iconSize<1||region.iconSize>256) throw new Error('Invalid --icon-size'); }
    const renderer=await loadRenderer({root:opts.root,dme:opts.dme,binDir:opts.byond,treeFile:opts.tree});
    const {png,result:r,provenance}=await renderMap(renderer,{root:opts.root,map:opts.map,...region});
    await writeFile(opts.out,png,{flag:opts.force?'w':'wx'});
    result=({schemaVersion:1,provenance:{...provenance,compilerErrors:renderer.project.compiler?.errorCount??null},data:{out:opts.out,width:r.width,height:r.height,drawn:r.drawn,holes:r.holes,diagnostics:r.diagnostics,
      notModelled:['New()/Initialize() changes','runtime overlays and smoothing','lighting','animation past frame 1','filters and transforms','colour matrices','see_invisible']}});
  }
  else if(command==='icon') {
    if(!opts.dmi) throw new Error('--dmi is required');
    const input=await readProjectBytes(opts.root,opts.dmi), icon=decodeDmi(input.data);
    result={schemaVersion:1,provenance:{dmi:opts.dmi,sha256:input.sha256,bytes:input.bytes,truthLayer:'authored-asset'},data:{version:icon.version,width:icon.width,height:icon.height,sheet:icon.sheet,
      png:{colorType:icon.colorType,bitDepth:icon.bitDepth},states:icon.states.map(s=>({name:s.name,dirs:s.dirs,frames:s.frames,delay:s.delay,movement:s.movement,loop:s.loop,rewind:s.rewind}))}};
  }
  else if(command==='types' || command==='lint') {
    if(!dme) throw new Error('--dme is required');
    const project=await loadProjectTypes({root:opts.root,dme:opts.dme,binDir:opts.byond,treeFile:opts.tree});
    const tree=parseTypeTree(project.xml), defines=collectDefines(project.defineSources);
    await project.preload([...new Set([...project.xml.matchAll(/file="([^":]+):\d+"/g)].map(m=>m[1]))]);
    const provenance={dme:project.dme,truthLayer:'native-type-tree',source:opts.tree?'saved-tree':'DreamMaker -o',recoveredTags:tree.recoveredTags,compilerExit:project.compiler?.status??null,compilerErrors:project.compiler?.errorCount??null,firstCompilerErrors:project.compiler?.errors?.slice(0,5)??[]};
    if(command==='types') {
      const RENDER=['icon','icon_state','layer','plane','dir','pixel_x','pixel_y','color','alpha','density','opacity'];
      if(opts.type) {
        if(!tree.has(opts.type)) throw new Error(`Unknown type ${opts.type}`);
        const chain=tree.chain(opts.type), names=new Set(); for(const p of chain) for(const v of tree.get(p)?.vars||[]) names.add(v);
        const vars={}; for(const n of [...names].sort()) { const e=tree.lookupVar(opts.type,n); vars[n]={...resolveVar(e,project.sourceLine,defines),declaredIn:e.from,at:e.file?`${e.file}:${e.line}`:null}; }
        result={schemaVersion:1,provenance,data:{type:opts.type,chain,file:tree.get(opts.type)?.file??null,vars}};
      } else {
        const coverage={}; let atoms=0;
        for(const p of tree.paths()) { if(!tree.isA(p,'/atom')) continue; atoms++; for(const v of RENDER) { const st=resolveVar(tree.lookupVar(p,v),project.sourceLine,defines).status; (coverage[v]??={})[st]=(coverage[v][st]||0)+1; } }
        result={schemaVersion:1,provenance,data:{types:tree.size,atomTypes:atoms,defines:defines.size,renderVarResolution:coverage,
          limitations:['Values are trusted only when the declaring line holds a literal, a macro for one, or simple + - * / arithmetic over those.','Conditional #define branches are not evaluated; a macro defined twice differently is unresolved.']}};
      }
    } else {
      if(!opts.map) throw new Error('--map is required');
      const input=await readProjectFile(opts.root,opts.map), map=parseDmm(input.text);
      const lint=lintMap(map,tree,{overrideKeys:raw=>overrideAssignments(raw).map(o=>o.key)});
      result={schemaVersion:1,provenance:{...provenance,map:opts.map,sha256:input.sha256},data:{...lint,parserDiagnostics:map.diagnostics}};
      if(lint.problems.length || map.diagnostics.length) process.exitCode=3;
    }
  }
  else if(command==='project') { if(!dme) throw new Error('--dme is required'); result={...inspectDme(dme.text),file:opts.dme,sha256:dme.sha256}; }
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
