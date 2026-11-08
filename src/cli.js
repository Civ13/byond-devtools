#!/usr/bin/env node
import { boundedJson } from './json.js';
import { parseDmm } from './dmm.js';
import { readProjectFile, readProjectBytes, inspectDme, loadProjectTypes } from './project.js';
import { parseTypeTree, resolveVar, collectDefines, lintMap } from './typetree.js';
import { overrideAssignments } from './world.js';
import { decodeDmi } from './dmi.js';
import { loadRenderer, renderMap } from './render-project.js';
import { editMapFile } from './edit-project.js';
import { loadDiff, renderDiff } from './diff-project.js';
import { diffRegion } from './diff.js';
import { extractPrefab, placePrefab, validatePrefab } from './prefab.js';
import { findGenerators, markTiles, GENERATOR_PROFILES } from './generators.js';
import { checkContract, validateContract, needsTypes, densityResolver } from './contracts.js';
import { compileProject, playtest } from './devrun-project.js';
import { recordIngame, PROFILES } from './ingame.js';
import { renderIngame } from './ingame-render.js';
import { encodePng } from './png.js';
import { writeFile, lstat, readFile } from 'node:fs/promises';
const usage = `Usage: node src/cli.js <summary|cell|find|project|types|lint|icon|render|ingame|edit|diff|prefab-extract|prefab-place|generators|check|compile|playtest> --root DIR --map FILE [--dme FILE]
  cell: --x N --y N --z N
  find: --type /path [--subtypes] [--limit N] [--offset N]
  project: --dme FILE (no --map needed)
  types: --dme FILE (--byond BIN | --tree FILE) [--type /path]   native type tree via DreamMaker -o
  lint: --map FILE --dme FILE (--byond BIN | --tree FILE)   unknown types and undefined vars; exit 3 on problems
  icon: --dmi FILE   DMI size, states, dirs, frames and delays (no --map needed)
  render: --map FILE --dme FILE (--byond BIN | --tree FILE) --out FILE.png [--z N] [--x1 N --y1 N --x2 N --y2 N]
          [--grid N] [--areas] [--show-invisible] [--icon-size N] [--force]
          static preview from authored source + type defaults (not a client screenshot); at most 128x128 tiles
  ingame: --dme FILE --byond BIN --out FILE.png --x1 N --y1 N --x2 N --y2 N --z N [--profile default|civ13]
          [--map FILE] [--time-of-day NAME] [--save-dump FILE.json] [--force]   or: --dump FILE.json --out FILE.png
          boots the game headless in a temp folder (RUNS GAME CODE: -safe, 127.0.0.1, no saves) and renders the
          initialized world: runtime icons, overlays, colour matrices, planes and lighting
  edit: --map FILE --patch FILE.json [--apply] [--inverse-out FILE.json] [--contract FILE.json [--dme FILE (--byond BIN | --tree FILE)]]
          dry run by default; --apply replaces the map atomically after checking base sha256 and expected stacks
  diff: --map FILE (--before FILE | --git-ref REF | --patch FILE.json) [--limit N]
          [--out FILE.png --dme FILE (--byond BIN | --tree FILE) [--z N] [--x1 N --y1 N --x2 N --y2 N] [--pad N] [--force]]
          changed cells by atom stack (removed/added atoms); --out draws before | after | highlighted changes
  prefab-extract: --map FILE --x1 N --y1 N --x2 N --y2 N --z N --out FILE.json [--layers movable,turf,area]
  prefab-place: --map FILE --prefab FILE.json --x N --y N --z N [--mode replace|overlay] [--out PATCH.json]
          makes an edit patch (base = the map's sha256); preview it with diff --patch, apply it with edit
  generators: --map FILE --dme FILE (--byond BIN | --tree FILE) [--profile default|civ13] [--roots /a,/b] [--z N] [--limit N]
          [--out FILE.png --x1 N --y1 N --x2 N --y2 N --z N [--force]]
          spawners, loot drops and landmarks: where they are and the types their vars name; --out marks them on a render
  check: --map FILE --contract FILE.json [--dme FILE (--byond BIN | --tree FILE)]
          spatial contract: require/forbid/area counts, reachable/unreachable routes, enclosed rooms; exit 3 on failure
          (edit --contract refuses --apply when the edited map would fail it)
  compile: --dme FILE --byond BIN [--map FILE]   full DreamMaker build in a temp folder; structured errors/warnings, exit 3 on errors
  playtest: --dme FILE --byond BIN [--map FILE] [--port N] [--minutes N] [--profile-procs] [--follow]
          RUNS THE GAME for you to join with Dream Seeker: temp folder, -safe, 127.0.0.1 only, no saves.
          Stops after --minutes (default 30) or Ctrl+C; reports runtime errors with source lines and the proc profile
Apart from ingame and playtest, nothing runs DM code or touches a server. Only render/diff/prefab/generators --out, edit --apply and edit --inverse-out write files.`;
function options(args) {
  const opts = Object.create(null), allowed = new Set(['root','map','dme','x','y','z','type','subtypes','limit','offset','byond','tree','dmi','out','x1','y1','x2','y2','grid','areas','show-invisible','icon-size','force','patch','apply','inverse-out','profile','time-of-day','save-dump','dump','before','git-ref','pad','layers','prefab','mode','roots','contract','port','minutes','profile-procs','follow']);
  for (let i=0;i<args.length;i++) {
    const flag=args[i]; if (!flag.startsWith('--') || !allowed.has(flag.slice(2))) throw new Error(`Unknown option ${flag}`);
    const key=flag.slice(2); if (key in opts) throw new Error(`Duplicate option --${key}`);
    if(['subtypes','areas','show-invisible','force','apply','profile-procs','follow'].includes(key)) opts[key]=true;
    else { if(i+1>=args.length || args[i+1].startsWith('--')) throw new Error(`Missing value for ${flag}`); opts[key]=args[++i]; }
  }
  return opts;
}
function integer(value, name, fallback) {
  if(value===undefined && fallback!==undefined) return fallback;
  if(typeof value!=='string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid --${name}`);
  return Number(value);
}
async function contractChecker(opts, dme) {
  const contract=validateContract(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readFile(opts.contract))));
  let density=null;
  if(needsTypes(contract)) {
    if(!dme) throw new Error('This contract has an actor with dense: true; pass --dme with --byond or --tree');
    const renderer=await loadRenderer({root:opts.root,dme:opts.dme,binDir:opts.byond,treeFile:opts.tree});
    density=densityResolver(renderer.tree,renderer.project.sourceLine,renderer.defines);
  }
  return text => { const r=checkContract(parseDmm(text),contract,{isDense:density?.isDense}); if(density) r.unresolvedDensity=[...density.unresolved].sort().slice(0,50); return r; };
}
try {
  const [command,...args]=process.argv.slice(2);
  if(!command || command==='--help') { console.log(usage); process.exit(0); }
  if(!['summary','cell','find','project','types','lint','icon','render','ingame','edit','diff','prefab-extract','prefab-place','generators','check','compile','playtest'].includes(command)) throw new Error('Unknown command');
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
  else if(command==='ingame') {
    if(!opts.out || !/\.png$/i.test(opts.out)) throw new Error('--out must name a .png file');
    const exists=async f=>{ try { return !!(await lstat(f)); } catch { return false; } };
    if(await exists(opts.out) && !opts.force) throw new Error(`${opts.out} exists; pass --force to overwrite`);
    if(opts['save-dump'] && await exists(opts['save-dump'])) throw new Error(`${opts['save-dump']} exists`);
    let dump, run=null;
    if(opts.dump) dump=JSON.parse(await readFile(opts.dump,'utf8'));
    else {
      if(!dme) throw new Error('--dme is required'); if(!opts.byond) throw new Error('--byond is required');
      const profile=opts.profile??'default'; if(!PROFILES.includes(profile)) throw new Error(`--profile must be one of ${PROFILES.join(', ')}`);
      const region={}; for(const k of ['x1','y1','x2','y2','z']) region[k]=integer(opts[k],k);
      run=await recordIngame({root:opts.root,dme:opts.dme,map:opts.map,binDir:opts.byond,profile,region,timeOfDay:opts['time-of-day'],onPhase:p=>console.error(JSON.stringify({phase:p}))});
      if(run.status!=='ok') { const e=new Error(`in-game run ${run.status}: ${run.failure??''}`); e.details=run; console.error(JSON.stringify({compiler:run.compiler,runtime:run.runtime?.slice(-4000)})); throw e; }
      dump=run.dump;
      if(opts['save-dump']) await writeFile(opts['save-dump'],JSON.stringify(dump)+'\n',{flag:'wx'});
    }
    const icons=dump.icons.map(i=>{ try { return i.base64?decodeDmi(Buffer.from(i.base64,'base64'),{plainPng:true}):null; } catch { return null; } });
    const r=renderIngame(dump,icons);
    await writeFile(opts.out,encodePng(r,{text:{Comment:`byond-devtools in-game render; ${r.truthLayer}; composed by byond-devtools, not a client screenshot`}}),{flag:opts.force?'w':'wx'});
    result={schemaVersion:1,provenance:{...dump.provenance,byond:dump.byond,region:dump.region,timeOfDay:dump.time_of_day,seconds:run?.seconds??null,runtimeErrors:run?.runtimeErrors??null},
      data:{out:opts.out,width:r.width,height:r.height,drawn:r.drawn,diagnostics:r.diagnostics,
        notModelled:['filters (incl. client ambient occlusion)','maptext','vis_contents','animation past frame 1','KEEP_TOGETHER groups','client.color and screen objects']}};
  }
  else if(command==='edit') {
    if(!opts.map) throw new Error('--map is required'); if(!opts.patch) throw new Error('--patch is required');
    const patchBytes=await readFile(opts.patch); if(patchBytes.byteLength>16*1024*1024) throw new Error('Patch byte limit exceeded');
    const patch=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(patchBytes));
    if(opts['inverse-out']) { let exists=false; try { exists=!!(await lstat(opts['inverse-out'])); } catch {} if(exists) throw new Error(`${opts['inverse-out']} exists`); }
    const postcondition=opts.contract?await contractChecker(opts,dme):undefined;
    const report=await editMapFile({root:opts.root,map:opts.map,patch,apply:!!opts.apply,postcondition});
    if(report.postcondition?.failed) process.exitCode=3;
    if(opts['inverse-out']) await writeFile(opts['inverse-out'],JSON.stringify(report.inverse,null,1)+'\n',{flag:'wx'});
    result={schemaVersion:1,provenance:{map:report.map,baseSha256:report.baseSha256,truthLayer:'authored-source'},data:{...report,inverse:opts['inverse-out']?{file:opts['inverse-out']}:report.inverse}};
  }
  else if(command==='diff') {
    if(!opts.map) throw new Error('--map is required');
    let patch;
    if(opts.patch) { const bytes=await readFile(opts.patch); if(bytes.byteLength>16*1024*1024) throw new Error('Patch byte limit exceeded'); patch=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
    if(opts.out) {
      if(!/\.png$/i.test(opts.out)) throw new Error('--out must name a .png file');
      if(!dme) throw new Error('--dme is required with --out');
      let exists=false; try { exists=!!(await lstat(opts.out)); } catch {}
      if(exists && !opts.force) throw new Error(`${opts.out} exists; pass --force to overwrite`);
    }
    const loaded=await loadDiff({root:opts.root,map:opts.map,before:opts.before,gitRef:opts['git-ref'],patch,limit:integer(opts.limit,'limit',10000)});
    let image=null;
    if(opts.out) {
      let region;
      if(['x1','y1','x2','y2'].some(k=>opts[k]!==undefined)) { region={z:integer(opts.z,'z',1)}; for(const k of ['x1','y1','x2','y2']) region[k]=integer(opts[k],k); }
      const renderer=await loadRenderer({root:opts.root,dme:opts.dme,binDir:opts.byond,treeFile:opts.tree});
      const pad=integer(opts.pad,'pad',2);
      region??=diffRegion(loaded.diff,{z:opts.z!==undefined?integer(opts.z,'z'):undefined,pad});
      const r=region?await renderDiff(renderer,{root:opts.root,loaded,region}):null;
      if(r) { await writeFile(opts.out,r.png,{flag:opts.force?'w':'wx'}); image={out:opts.out,width:r.width,height:r.height,region:r.region,outlined:r.outlined,panels:['before','after','highlight'],diagnostics:r.diagnostics}; }
      else image={out:null,reason:'no changed cells on the requested level'};
    }
    result={schemaVersion:1,provenance:{before:loaded.before,after:loaded.after,truthLayer:'authored-source'},data:{...loaded.diff,image}};
  }
  else if(command==='prefab-extract' || command==='prefab-place') {
    if(!opts.map) throw new Error('--map is required');
    if(opts.out) { if(!/\.json$/i.test(opts.out)) throw new Error('--out must name a .json file'); let exists=false; try { exists=!!(await lstat(opts.out)); } catch {} if(exists) throw new Error(`${opts.out} exists`); }
    const input=await readProjectFile(opts.root,opts.map), map=parseDmm(input.text.replace(/^\uFEFF/,''));
    const provenance={map:opts.map,sha256:input.sha256,truthLayer:'authored-source'};
    let out;
    if(command==='prefab-extract') {
      if(!opts.out) throw new Error('--out is required');
      const region={}; for(const k of ['x1','y1','x2','y2','z']) region[k]=integer(opts[k],k);
      out=extractPrefab(map,{...region,layers:opts.layers?opts.layers.split(','):undefined,source:{map:opts.map,sha256:input.sha256}});
      result={schemaVersion:1,provenance,data:{out:opts.out,width:out.width,height:out.height,cells:out.cells.length,holes:out.holes,types:out.types.length}};
    } else {
      if(!opts.prefab) throw new Error('--prefab is required');
      const prefab=validatePrefab(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readFile(opts.prefab))));
      out=placePrefab(map,prefab,{x:integer(opts.x,'x'),y:integer(opts.y,'y'),z:integer(opts.z,'z'),mode:opts.mode??'replace',base:input.sha256});
      result={schemaVersion:1,provenance,data:opts.out?{out:opts.out,edits:out.edits.length,...out.prefab}:out};
    }
    if(opts.out) await writeFile(opts.out,JSON.stringify(out,null,1)+'\n',{flag:'wx'});
  }
  else if(command==='generators') {
    if(!opts.map) throw new Error('--map is required'); if(!dme) throw new Error('--dme is required');
    const profile=opts.profile??'default'; if(!GENERATOR_PROFILES[profile]) throw new Error(`--profile must be one of ${Object.keys(GENERATOR_PROFILES).join(', ')}`);
    const roots=opts.roots?opts.roots.split(','):GENERATOR_PROFILES[profile].roots;
    let region=null;
    if(opts.out) {
      if(!/\.png$/i.test(opts.out)) throw new Error('--out must name a .png file');
      let exists=false; try { exists=!!(await lstat(opts.out)); } catch {}
      if(exists && !opts.force) throw new Error(`${opts.out} exists; pass --force to overwrite`);
      region={}; for(const k of ['x1','y1','x2','y2','z']) region[k]=integer(opts[k],k);
    }
    const renderer=await loadRenderer({root:opts.root,dme:opts.dme,binDir:opts.byond,treeFile:opts.tree});
    const input=await readProjectFile(opts.root,opts.map), map=parseDmm(input.text.replace(/^\uFEFF/,''));
    const found=findGenerators(map,renderer.tree,renderer.project.sourceLine,{roots,z:opts.z!==undefined?integer(opts.z,'z'):undefined,limit:integer(opts.limit,'limit',10000),defines:renderer.defines});
    let image=null;
    if(region) {
      const r=await renderMap(renderer,{root:opts.root,mapText:map.source,...region,showInvisible:true});
      const inRegion=[]; for(let y=region.y1;y<=region.y2;y++) for(let x=region.x1;x<=region.x2;x++) { const c=map.inspectCell(x,y,region.z); if(c && c.atoms.some(a=>renderer.tree.has(a.path) && roots.some(rt=>renderer.tree.isA(a.path,rt)))) inRegion.push({x,y,z:region.z}); }
      const marked=markTiles(r.result,inRegion,region,renderer.iconSize);
      await writeFile(opts.out,encodePng(r.result,{text:{Comment:'byond-devtools generator map: static render with invisible atoms shown, generator tiles outlined'}}),{flag:opts.force?'w':'wx'});
      image={out:opts.out,width:r.result.width,height:r.result.height,region,marked,diagnostics:r.result.diagnostics};
    }
    result={schemaVersion:1,provenance:{map:opts.map,sha256:input.sha256,dme:renderer.project.dme,truthLayer:'authored-source+native-type-tree',profile},data:{...found,image,
      limitations:['Spawn targets are read from var source text, not by running the generator; whether its code uses that var is not proven.','Generators made at runtime by other code (events, map metadata, ecology) are not listed.']}};
  }
  else if(command==='check') {
    if(!opts.map) throw new Error('--map is required'); if(!opts.contract) throw new Error('--contract is required');
    const check=await contractChecker(opts,dme);
    const input=await readProjectFile(opts.root,opts.map);
    const report=check(input.text.replace(/^\uFEFF/,''));
    result={schemaVersion:1,provenance:{map:opts.map,sha256:input.sha256,contract:opts.contract,truthLayer:'authored-source'},data:{...report,
      limitations:['Movement is a static walk over authored tiles: Bump(), CanPass(), door locks, runtime spawns and z transitions are not modelled.']}};
    if(report.failed) process.exitCode=3;
  }
  else if(command==='compile') {
    if(!dme) throw new Error('--dme is required'); if(!opts.byond) throw new Error('--byond is required');
    const r=await compileProject({root:opts.root,dme:opts.dme,map:opts.map,binDir:opts.byond});
    result={schemaVersion:1,provenance:{dme:opts.dme,dmeSha256:r.dmeSha256,map:r.map,truthLayer:'native-compiler'},data:r};
    if(r.status!=='ok') process.exitCode=3;
  }
  else if(command==='playtest') {
    if(!dme) throw new Error('--dme is required'); if(!opts.byond) throw new Error('--byond is required');
    const minutes=opts.minutes!==undefined?Number(opts.minutes):30; if(!(minutes>0 && minutes<=1440)) throw new Error('Invalid --minutes');
    const port=opts.port!==undefined?integer(opts.port,'port'):undefined; if(port!==undefined && (port<1024||port>65535)) throw new Error('--port must be 1024-65535');
    const ac=new AbortController(); const stop=()=>ac.abort(); process.once('SIGINT',stop); process.once('SIGTERM',stop);
    console.error(JSON.stringify({phase:'compile'}));
    const r=await playtest({root:opts.root,dme:opts.dme,map:opts.map,binDir:opts.byond,port,minutes,profileProcs:!!opts['profile-procs'],signal:ac.signal,
      onReady:({url})=>console.error(JSON.stringify({phase:'ready',url,join:`Open ${url} in Dream Seeker (or run: DreamSeeker ${url}); Ctrl+C stops the world`})),
      onLog:opts.follow?chunk=>process.stderr.write(chunk):undefined});
    process.off('SIGINT',stop); process.off('SIGTERM',stop);
    result={schemaVersion:1,provenance:{dme:opts.dme,dmeSha256:r.compile.dmeSha256,map:opts.map??null,truthLayer:'native-playtest'},data:r};
    if(r.status==='compile-failed'||r.status==='boot-failed') process.exitCode=3;
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
} catch(error) { console.error(JSON.stringify({error:error.name,message:error.message,...(error.edit!==undefined?{edit:error.edit}:{}),...(error.actual?{actual:error.actual}:{}),...(error.actualSha256?{actualSha256:error.actualSha256}:{}),...(error.postcondition?{postcondition:error.postcondition}:{})})); process.exitCode=1; }
