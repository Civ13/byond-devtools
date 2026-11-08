/**
 * Native compile and playtest reports. Pure: compiler and world-log text in, structured
 * diagnostics out. Paths are made project-relative when they start with the project root
 * (DreamMaker and DreamDaemon print absolute paths for a probe .dme with absolute includes).
 */
const norm = (file, root) => {
  let f = String(file).trim().replaceAll('\\', '/');
  if (root) {
    const r = root.replaceAll('\\', '/').replace(/\/?$/, '/');
    const fold = /^[A-Za-z]:\//.test(r) ? s => s.toLowerCase() : s => s;
    if (fold(f).startsWith(fold(r))) f = f.slice(r.length);
  }
  return f;
};

/**
 * DreamMaker output -> {diagnostics: [{file, line, severity, code, message}], errors, warnings, summary}.
 * Lines look like `code/x.dm:12:error: foo: undefined var` or `x.dm:2:warning (unused_var): ...`.
 */
export function parseCompilerOutput(text, { root } = {}) {
  const diagnostics = [];
  let summary = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const m = /^(.+?):(\d+):(error|warning)(?: \(([^)]+)\))?: ?(.*)$/.exec(line);
    if (m) { diagnostics.push({ file: norm(m[1], root), line: Number(m[2]), severity: m[3], code: m[4] ?? null, message: m[5] }); continue; }
    const s = /^(.*\.dmb) - (\d+) errors?, (\d+) warnings?/.exec(line);
    if (s) summary = { errors: Number(s[2]), warnings: Number(s[3]) };
  }
  const errors = diagnostics.filter(d => d.severity === 'error').length, warnings = diagnostics.length - errors;
  return { diagnostics, errors: summary?.errors ?? errors, warnings: summary?.warnings ?? warnings, summary: !!summary };
}

/**
 * World log -> runtime errors grouped by message and location, in first-seen order:
 * {total, unique: [{message, proc, file, line, src, usr, callStack, count}], truncated}.
 * BYOND prints `runtime error: <message>` then indented `proc name:`, `source file: f,line`
 * (only when compiled with DEBUG), `usr:`, `src:`, `src.loc:`, `call stack:` and the stack.
 */
export function parseRuntimeErrors(log, { root, limit = 200, stackDepth = 20 } = {}) {
  const lines = String(log).split(/\r?\n/), groups = new Map();
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const head = /runtime error: (.*)$/.exec(lines[i]);
    if (!head) continue;
    total++;
    const e = { message: head[1].trim(), proc: null, file: null, line: null, src: null, usr: null, callStack: [] };
    let j = i + 1, inStack = false;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (/runtime error: /.test(l) || (!inStack && !/^\s/.test(l) && !/^proc name:/.test(l))) break;
      let m;
      if ((m = /^proc name: (.*)$/.exec(l))) e.proc = m[1].trim();
      else if ((m = /^\s+source file: (.*),(\d+)\s*$/.exec(l))) { e.file = norm(m[1], root); e.line = Number(m[2]); }
      else if ((m = /^\s+usr: (.*)$/.exec(l))) e.usr = m[1].trim();
      else if ((m = /^\s+src: (.*)$/.exec(l))) e.src = m[1].trim();
      else if (/^\s+call stack:\s*$/.test(l)) inStack = true;
      else if (inStack) { if (!/(\)|\.\.\.)\s*$/.test(l)) break; if (e.callStack.length < stackDepth) e.callStack.push(l.trim()); }
    }
    i = j - 1;
    const key = `${e.message}\u0000${e.proc}\u0000${e.file}:${e.line}`;
    const g = groups.get(key);
    if (g) g.count++; else if (groups.size < limit) groups.set(key, { ...e, count: 1 });
  }
  const unique = [...groups.values()];
  return { total, unique, truncated: unique.reduce((n, g) => n + g.count, 0) < total };
}

/** Top procs from world.Profile(PROFILE_REFRESH, null, "json") output, by total time. */
export function summarizeProfile(json, { top = 25 } = {}) {
  let rows;
  try { rows = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!Array.isArray(rows)) return null;
  return rows.filter(r => r && typeof r.name === 'string').sort((p, q) => (q.total ?? 0) - (p.total ?? 0)).slice(0, top)
    .map(r => ({ proc: r.name, calls: r.calls ?? null, selfSeconds: r.self ?? null, totalSeconds: r.total ?? null, realSeconds: r.real ?? null, overtime: r.over ?? null }));
}
