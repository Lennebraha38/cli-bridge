/**
 * Smoke test for the MCP server: performs a real JSON-RPC handshake over
 * stdio and calls a couple of tools.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'dist', 'mcp', 'main.js');

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let buffer = '';
const pending = new Map();

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const init = await request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '1.0.0' },
});

console.log('initialize ->', JSON.stringify(init.result?.serverInfo));
notify('notifications/initialized', {});

const tools = await request('tools/list', {});
const names = (tools.result?.tools ?? []).map((tool) => tool.name);
console.log(`tools/list -> ${names.length} tools`);
console.log('sample:', names.slice(0, 8).join(', '));
console.log('has cli_ tools:', names.filter((n) => n.startsWith('cli_')).length);

const search = await request('tools/call', {
  name: 'bridge_search',
  arguments: { query: 'json', limit: 3 },
});
const searchText = search.result?.content?.[0]?.text ?? '';
console.log('bridge_search ->', searchText.slice(0, 160).replace(/\n/g, ' '));

const call = await request('tools/call', {
  name: 'bridge_call',
  arguments: { tool: 'node', args: ['-e', 'console.log(6*7)'] },
});
console.log('bridge_call ->', (call.result?.content?.[0]?.text ?? '').slice(0, 120).replace(/\n/g, ' '));

const op = await request('tools/call', {
  name: 'bridge_run_op',
  arguments: { op: 'json.query', input: { json: '{"a":{"b":7}}', filter: '$.a.b' } },
});
console.log('bridge_run_op ->', (op.result?.content?.[0]?.text ?? '').slice(0, 200).replace(/\n/g, ' '));

child.stdin.end();
setTimeout(() => process.exit(0), 300);
