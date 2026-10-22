import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { runChain } from '../core/chain.js';
import { loadConfig } from '../core/config.js';
import { listOperations, OPERATION_BY_ID } from '../core/operations/index.js';
import { operationBackends, runOperation } from '../core/operations/runner.js';
import { Policy } from '../core/policy.js';
import { registry } from '../core/registry.js';
import { callTool } from '../core/runner.js';
import type { BridgeConfig } from '../core/types.js';

export interface BridgeServerOptions {
  config?: BridgeConfig;
  host?: string;
  port?: number;
}

export interface ServerEvent {
  id: string;
  type: string;
  at: number;
  payload: unknown;
}

interface Client {
  id: string;
  res: ServerResponse;
}

/**
 * The bridge hub: a tiny local HTTP server that exposes every tool and
 * operation so other programs (AI agents, scripts, IDEs) can use them.
 */
export class BridgeServer {
  private server: Server | undefined;
  private clients = new Map<string, Client>();
  private policy: Policy;
  private config: BridgeConfig;
  private host: string;
  private port: number;

  constructor(options: BridgeServerOptions = {}) {
    this.config = options.config ?? loadConfig();
    this.host = options.host ?? this.config.server.host;
    this.port = options.port ?? this.config.server.port;
    this.policy = new Policy(this.config.policy);
  }

  get address(): { host: string; port: number } {
    return { host: this.host, port: this.port };
  }

  async listen(): Promise<{ host: string; port: number }> {
    await registry.load({ includeSystem: this.config.discovery.includeSystem });

    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.server?.once('error', rejectPromise);
      this.server?.listen(this.port, this.host, () => resolvePromise());
    });

    const address = this.server.address();
    if (address && typeof address === 'object') {
      this.port = address.port;
    }
    return { host: this.host, port: this.port };
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) {
      client.res.end();
    }
    this.clients.clear();
    await new Promise<void>((resolvePromise) => {
      if (!this.server) return resolvePromise();
      this.server.close(() => resolvePromise());
    });
  }

  /** Broadcast an event to every connected SSE client. */
  emit(type: string, payload: unknown): void {
    const event: ServerEvent = { id: randomUUID(), type, at: Date.now(), payload };
    const data = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients.values()) {
      try {
        client.res.write(data);
      } catch {
        this.clients.delete(client.id);
      }
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const token = this.config.server.token;
    if (!token) return true;
    const header = req.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-bridge-token'] as string | undefined);
    return provided === token;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-bridge-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (!this.authorized(req)) {
      this.json(res, 401, { error: 'unauthorized' });
      return;
    }

    try {
      if (req.method === 'GET' && (path === '/' || path === '/health')) {
        this.json(res, 200, {
          ok: true,
          name: 'cli-bridge',
          version: '0.1.0',
          tools: registry.list({ includeSystem: true }).length,
          operations: listOperations().length,
          uptimeSeconds: Math.round(process.uptime()),
        });
        return;
      }

      if (req.method === 'GET' && path === '/v1/tools') {
        const query = url.searchParams.get('q') ?? '';
        const category = url.searchParams.get('category') ?? undefined;
        const includeSystem = url.searchParams.get('system') === '1';
        const tools = query
          ? registry.search(query, 200)
          : registry.list({ includeSystem, category });
        this.json(res, 200, { tools });
        return;
      }

      if (req.method === 'GET' && path.startsWith('/v1/tools/')) {
        const id = decodeURIComponent(path.slice('/v1/tools/'.length));
        const tool = registry.get(id);
        if (!tool) {
          this.json(res, 404, { error: `unknown tool "${id}"` });
          return;
        }
        const installed = registry.isInstalled(tool);
        const version = installed ? await registry.probeVersion(tool) : undefined;
        this.json(res, 200, { tool: { ...tool, installed, version } });
        return;
      }

      if (req.method === 'GET' && path === '/v1/ops') {
        const ops = listOperations().map((op) => ({
          ...op,
          backends: operationBackends(op),
        }));
        this.json(res, 200, { operations: ops });
        return;
      }

      if (req.method === 'GET' && path.startsWith('/v1/ops/')) {
        const id = decodeURIComponent(path.slice('/v1/ops/'.length));
        const op = OPERATION_BY_ID.get(id);
        if (!op) {
          this.json(res, 404, { error: `unknown operation "${id}"` });
          return;
        }
        this.json(res, 200, { operation: { ...op, backends: operationBackends(op) } });
        return;
      }

      if (req.method === 'GET' && path === '/v1/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`event: ready\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
        const client: Client = { id: randomUUID(), res };
        this.clients.set(client.id, client);
        req.on('close', () => {
          this.clients.delete(client.id);
        });
        return;
      }

      if (req.method === 'POST' && path === '/v1/call') {
        const body = await this.body(req);
        const result = await callTool(
          {
            tool: String(body.tool ?? ''),
            args: Array.isArray(body.args) ? body.args.map(String) : [],
            stdin: typeof body.stdin === 'string' ? body.stdin : undefined,
            cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
            env: body.env && typeof body.env === 'object' ? (body.env as Record<string, string>) : undefined,
            timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
            shell: body.shell === true ? true : undefined,
          },
          this.policy,
        );
        this.emit('call', { tool: body.tool, ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs });
        this.json(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === 'POST' && path === '/v1/op') {
        const body = await this.body(req);
        const result = await runOperation(String(body.op ?? ''), {
          input: body.input && typeof body.input === 'object' ? (body.input as Record<string, unknown>) : {},
          cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
          stdin: typeof body.stdin === 'string' ? body.stdin : undefined,
          timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
        });
        this.emit('op', { op: body.op, ok: result.ok, impl: result.impl, durationMs: result.result.durationMs });
        this.json(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === 'POST' && path === '/v1/chain') {
        const body = await this.body(req);
        const result = await runChain(
          {
            steps: Array.isArray(body.steps) ? (body.steps as never) : [],
            input: body.input && typeof body.input === 'object' ? (body.input as Record<string, unknown>) : {},
            cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
            env: body.env && typeof body.env === 'object' ? (body.env as Record<string, string>) : undefined,
          },
          { policy: this.policy },
        );
        this.emit('chain', { ok: result.ok, steps: result.steps.length, durationMs: result.durationMs });
        this.json(res, result.ok ? 200 : 400, result);
        return;
      }

      this.json(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (error) {
      this.json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error('request body is not valid JSON');
    }
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    const data = JSON.stringify(payload, null, 2);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(data);
  }
}

/** Convenience helper: start a server and return it. */
export async function startServer(options: BridgeServerOptions = {}): Promise<BridgeServer> {
  const server = new BridgeServer(options);
  await server.listen();
  return server;
}
