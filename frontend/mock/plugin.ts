/**
 * Vite 插件：在开发服务器内挂载 mock 后端（npm run dev:mock）。
 * 端点、错误格式、SSE 语义与 docs/api-contract.md 完全一致，可作为后端实现的行为参考。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type { RunEvent } from '../src/api/types.ts';
import { isTerminal } from '../src/lib/fold.ts';
import { buildExperiments } from './experiments.ts';
import { exportMarkdown } from './export.ts';
import {
  CONFIG,
  HttpError,
  SEEDED,
  answerClarification,
  cancelRun,
  createRun,
  deleteRun,
  getRun,
  listRuns,
  resumeRun,
  seedRuns,
  subscribe,
} from './store.ts';

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  res.statusCode = status;
  if (body === undefined) {
    res.end();
    return;
  }
  const isText = typeof body === 'string';
  res.setHeader('Content-Type', isText ? headers['Content-Type'] ?? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(isText ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(422, 'validation_error', 'invalid JSON body');
  }
}

function sse(req: IncomingMessage, res: ServerResponse, runId: string, after: number) {
  const rec = getRun(runId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (ev: RunEvent) => res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  const end = () => {
    res.write('event: end\ndata: {}\n\n');
    res.end();
  };
  for (const ev of rec.events) if (ev.seq > after) write(ev);
  if (isTerminal(rec.detail.status)) {
    end();
    return;
  }
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  const unsub = subscribe(runId, (ev) => {
    write(ev);
    if (ev.type === 'run.finished') {
      cleanup();
      end();
    }
  });
  const cleanup = () => {
    clearInterval(ping);
    unsub();
  };
  req.on('close', cleanup);
}

export function mockApiPlugin(): Plugin {
  return {
    name: 'news-agent-mock-api',
    configureServer(server) {
      seedRuns();
      const experiments = buildExperiments(SEEDED);
      server.middlewares.use('/api', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://mock');
        const parts = url.pathname.split('/').filter(Boolean);
        const method = req.method ?? 'GET';
        try {
          // 模拟网络延迟，便于观察加载态
          await new Promise((r) => setTimeout(r, 120));
          if (parts[0] === 'health' && method === 'GET') {
            return send(res, 200, {
              status: 'ok',
              checks: {
                database: { ok: true, detail: 'in-memory (mock)' },
                llm: { ok: true, detail: 'mock' },
                tavily: { ok: true, detail: 'mock' },
                exa: { ok: true, detail: 'mock' },
              },
            });
          }
          if (parts[0] === 'config' && method === 'GET') return send(res, 200, CONFIG);
          if (parts[0] === 'experiments') {
            if (parts.length === 1) return send(res, 200, experiments.map(({ metric_defs: _m, results: _r, tasks: _t, budget_levels: _b, ...s }) => s));
            const exp = experiments.find((e) => e.id === parts[1]);
            if (!exp) throw new HttpError(404, 'not_found', `experiment ${parts[1]} not found`);
            return send(res, 200, exp);
          }
          if (parts[0] === 'runs') {
            if (parts.length === 1) {
              if (method === 'GET') {
                const status = url.searchParams.get('status')?.split(',').filter(Boolean);
                const q = url.searchParams.get('q') ?? undefined;
                return send(res, 200, { items: listRuns(status, q), next_cursor: null });
              }
              if (method === 'POST') return send(res, 201, createRun((await readJson(req)) as never));
            }
            const id = parts[1];
            if (parts.length === 2) {
              if (method === 'GET') return send(res, 200, getRun(id).detail);
              if (method === 'DELETE') {
                deleteRun(id);
                return send(res, 204);
              }
            }
            const sub = parts[2];
            if (sub === 'events' && method === 'GET') return sse(req, res, id, Number(url.searchParams.get('after') ?? '0'));
            if (sub === 'clarification' && method === 'POST') return send(res, 200, answerClarification(id, (await readJson(req)) as never));
            if (sub === 'cancel' && method === 'POST') return send(res, 200, cancelRun(id));
            if (sub === 'resume' && method === 'POST') return send(res, 200, resumeRun(id));
            if (sub === 'export' && method === 'GET') {
              const d = getRun(id).detail;
              if (url.searchParams.get('format') === 'json') return send(res, 200, d);
              return send(res, 200, exportMarkdown(d), {
                'Content-Type': 'text/markdown; charset=utf-8',
                'Content-Disposition': `attachment; filename="report-${id}.md"`,
              });
            }
          }
          throw new HttpError(404, 'not_found', `no route for ${method} ${url.pathname}`);
        } catch (e) {
          if (e instanceof HttpError) return send(res, e.status, { error: { type: e.type, message: e.message, details: null } });
          console.error('[mock]', e);
          return send(res, 500, { error: { type: 'internal_error', message: String(e), details: null } });
        }
      });
    },
  };
}
