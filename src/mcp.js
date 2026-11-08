#!/usr/bin/env node
/**
 * MCP server (stdio, newline-delimited JSON-RPC 2.0) for the byond-devtools agent API.
 *
 *   node src/mcp.js --root /path/to/Civ13 [--dme civ13.dme (--byond BIN | --tree FILE)] [--allow-write]
 *
 * Serves the tools in src/agent-api.js for one project root. Read-only unless --allow-write is
 * given, and even then a map is written only by map_edit with apply: true and a passing base hash.
 * ingame_render boots the game (temp folder, -safe, 127.0.0.1) only with --allow-game.
 * Logs go to stderr; stdout carries protocol messages only.
 */
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createAgentApi, ToolInputError } from './agent-api.js';
import { boundedJson } from './json.js';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function parseArgs(argv) {
  const opts = {}, flags = new Set(['allow-write', 'allow-game']), values = new Set(['root', 'dme', 'byond', 'tree']);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (flags.has(k)) opts[k] = true;
    else if (values.has(k) && i + 1 < argv.length) opts[k] = argv[++i];
    else throw new Error(`Unknown or incomplete option ${argv[i]}`);
  }
  if (!opts.root) throw new Error('--root is required');
  return opts;
}

/** Handle one JSON-RPC message; returns the response object, or null for notifications. */
export async function handleMessage(api, msg) {
  const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'Invalid request');
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({ protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'byond-devtools', version: VERSION },
        instructions: 'BYOND map tools for one project. Coordinates are one-based, (1,1) is south-west. Renders are static previews of authored source, not client screenshots. Edits need the map\'s current sha256 as patch.base and the current stack of each tile as expect; preview with map_diff before map_edit apply.' });
    }
    case 'notifications/initialized': case 'notifications/cancelled': return null;
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: api.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) });
    case 'tools/call': {
      const { name, arguments: args } = msg.params ?? {};
      if (!api.tools.some(t => t.name === name)) return error(-32602, `Unknown tool ${name}`);
      try {
        const out = await api.call(name, args ?? {});
        const { png, ...json } = out;
        const content = [{ type: 'text', text: boundedJson({ schemaVersion: 1, ...json }, 4 * 1024 * 1024) }];
        if (png) content.push({ type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' });
        return reply({ content, isError: false });
      } catch (e) {
        // Tool failures are results the model can read, not protocol errors.
        const detail = { error: e.name, message: e.message, ...(e.edit !== undefined ? { edit: e.edit } : {}), ...(e.actual ? { actual: e.actual } : {}), ...(e.actualSha256 ? { actualSha256: e.actualSha256 } : {}), ...(e.postcondition ? { postcondition: e.postcondition } : {}) };
        if (!(e instanceof ToolInputError)) process.stderr.write(`[byond-devtools] ${name}: ${e.stack ?? e.message}\n`);
        return reply({ content: [{ type: 'text', text: JSON.stringify(detail) }], isError: true });
      }
    }
    default: return isNotification ? null : error(-32601, `Method not found: ${msg.method}`);
  }
}

export async function serve(api, input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
    const p = handleMessage(api, msg).then(r => { if (r) output.write(JSON.stringify(r) + '\n'); }).finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const api = createAgentApi({ root: opts.root, dme: opts.dme, byond: opts.byond, tree: opts.tree, allowWrite: !!opts['allow-write'], allowGame: !!opts['allow-game'] });
    process.stderr.write(`[byond-devtools] MCP server for ${opts.root}${opts['allow-write'] ? ' (writes allowed)' : ' (read-only)'}${opts['allow-game'] ? ', in-game renders allowed' : ''}\n`);
    await serve(api);
  } catch (e) { process.stderr.write(`[byond-devtools] ${e.message}\n`); process.exitCode = 1; }
}
