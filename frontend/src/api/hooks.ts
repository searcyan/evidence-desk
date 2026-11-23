/** 数据获取 hooks：配置、列表用 react-query；运行详情 = 快照 + 实时事件折叠 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { streamRunEvents } from './stream.ts';
import type { ClarificationAnswer, RunDetail, RunEvent, RunRequest, RunStatus } from './types.ts';
import { applyEvent, isTerminal } from '../lib/fold.ts';

export const qk = {
  config: ['config'] as const,
  health: ['health'] as const,
  runs: (filter: object) => ['runs', filter] as const,
  run: (id: string) => ['run', id] as const,
  experiments: ['experiments'] as const,
  experiment: (id: string) => ['experiment', id] as const,
};

export function useConfig() {
  return useQuery({ queryKey: qk.config, queryFn: api.config, staleTime: 60_000, retry: 1 });
}

export function useHealth() {
  return useQuery({ queryKey: qk.health, queryFn: api.health, refetchInterval: 30_000, retry: 0 });
}

export function useRuns(filter: { status?: RunStatus[]; q?: string } = {}) {
  return useQuery({
    queryKey: qk.runs(filter),
    queryFn: () => api.listRuns({ ...filter, limit: 100 }),
    // 有运行中的任务时定期刷新列表
    refetchInterval: (q) =>
      q.state.data?.items.some((r) => !isTerminal(r.status)) ? 3000 : false,
  });
}

export function useExperiments() {
  return useQuery({ queryKey: qk.experiments, queryFn: api.listExperiments });
}

export function useExperiment(id: string) {
  return useQuery({ queryKey: qk.experiment(id), queryFn: () => api.getExperiment(id) });
}

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'retrying' | 'closed';

/**
 * 运行详情实时视图：
 * 1. 取快照立即渲染；
 * 2. 从 seq=0 订阅事件流：历史事件只进入活动日志，seq 大于快照的事件同时折叠进状态。
 */
export function useLiveRun(runId: string) {
  const qc = useQueryClient();
  const snapshot = useQuery({
    queryKey: qk.run(runId),
    queryFn: () => api.getRun(runId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const runRef = useRef<RunDetail | null>(null);

  useEffect(() => {
    if (!snapshot.data) return;
    runRef.current = snapshot.data;
    setRun(snapshot.data);
    setEvents([]);
    const buffer: RunEvent[] = [];
    let raf = 0;
    // 事件可能密集到达，按帧合并刷新
    const flush = () => {
      raf = 0;
      if (!buffer.length) return;
      const batch = buffer.splice(0);
      let cur = runRef.current!;
      for (const ev of batch) cur = applyEvent(cur, ev);
      runRef.current = cur;
      setRun(cur);
      setEvents((prev) => prev.concat(batch));
      if (batch.some((e) => e.type === 'run.finished')) {
        void qc.invalidateQueries({ queryKey: ['runs'] });
      }
    };
    const stop = streamRunEvents(runId, 0, {
      onEvent: (ev) => {
        buffer.push(ev);
        if (!raf) raf = requestAnimationFrame(flush);
      },
      onConnectionChange: setConnection,
    });
    return () => {
      stop();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [snapshot.data, runId, qc]);

  return { run, events, connection, isLoading: snapshot.isLoading, error: snapshot.error };
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: RunRequest) => api.createRun(req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['runs'] }),
  });
}

export function useRunActions(runId: string) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['runs'] });
  return {
    cancel: useMutation({ mutationFn: () => api.cancelRun(runId), onSuccess: refresh }),
    resume: useMutation({
      mutationFn: () => api.resumeRun(runId),
      onSuccess: () => {
        refresh();
        void qc.invalidateQueries({ queryKey: qk.run(runId) });
      },
    }),
    remove: useMutation({ mutationFn: () => api.deleteRun(runId), onSuccess: refresh }),
    clarify: useMutation({
      mutationFn: (body: ClarificationAnswer) => api.answerClarification(runId, body),
    }),
  };
}
