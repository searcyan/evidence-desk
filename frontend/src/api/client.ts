/** REST 客户端：所有请求经 /api，开发时由 Vite 代理到后端或 mock */
import type {
  AppConfig,
  ClarificationAnswer,
  ExperimentDetail,
  ExperimentSummary,
  HealthResponse,
  RunDetail,
  RunListResponse,
  RunRequest,
  RunStatus,
  RunSummary,
} from './types.ts';

export class ApiError extends Error {
  status: number;
  type: string;
  constructor(status: number, type: string, message: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Backend unreachable');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: { type?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.type ?? 'http_error', err?.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  config: () => request<AppConfig>('/config'),
  listRuns: (params: { status?: RunStatus[]; q?: string; limit?: number; cursor?: string } = {}) => {
    const sp = new URLSearchParams();
    if (params.status?.length) sp.set('status', params.status.join(','));
    if (params.q) sp.set('q', params.q);
    if (params.limit) sp.set('limit', String(params.limit));
    if (params.cursor) sp.set('cursor', params.cursor);
    const qs = sp.toString();
    return request<RunListResponse>(`/runs${qs ? `?${qs}` : ''}`);
  },
  getRun: (id: string) => request<RunDetail>(`/runs/${encodeURIComponent(id)}`),
  createRun: (req: RunRequest) =>
    request<RunSummary>('/runs', { method: 'POST', body: JSON.stringify(req) }),
  answerClarification: (id: string, body: ClarificationAnswer) =>
    request<RunSummary>(`/runs/${encodeURIComponent(id)}/clarification`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  cancelRun: (id: string) =>
    request<RunSummary>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  resumeRun: (id: string) =>
    request<RunSummary>(`/runs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  deleteRun: (id: string) =>
    request<void>(`/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  exportUrl: (id: string, format: 'md' | 'json') =>
    `/api/runs/${encodeURIComponent(id)}/export?format=${format}`,
  listExperiments: () => request<ExperimentSummary[]>('/experiments'),
  getExperiment: (id: string) =>
    request<ExperimentDetail>(`/experiments/${encodeURIComponent(id)}`),
};
