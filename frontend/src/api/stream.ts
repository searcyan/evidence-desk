/**
 * SSE 事件流读取（基于 fetch，而非 EventSource）：
 * - 可精确控制 after 参数，断线后从最后收到的 seq 继续；
 * - 收到 `event: end` 即停止，不会像 EventSource 那样无限重连。
 */
import type { RunEvent } from './types.ts';

export interface StreamHandlers {
  onEvent: (ev: RunEvent) => void;
  onEnd?: () => void;
  onConnectionChange?: (state: 'connecting' | 'open' | 'retrying' | 'closed') => void;
}

export function streamRunEvents(runId: string, after: number, h: StreamHandlers): () => void {
  const ctrl = new AbortController();
  let lastSeq = after;
  let stopped = false;
  let attempt = 0;

  const run = async () => {
    while (!stopped) {
      h.onConnectionChange?.(attempt === 0 ? 'connecting' : 'retrying');
      try {
        const res = await fetch(
          `/api/runs/${encodeURIComponent(runId)}/events?after=${lastSeq}`,
          { signal: ctrl.signal, headers: { Accept: 'text/event-stream' } },
        );
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        h.onConnectionChange?.('open');
        attempt = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        let ended = false;
        while (!ended) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value.replace(/\r\n/g, '\n');
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = 'message';
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) continue; // 心跳
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            if (event === 'end') {
              ended = true;
              break;
            }
            if (!data.length) continue;
            try {
              const ev = JSON.parse(data.join('\n')) as RunEvent;
              if (ev.seq > lastSeq) {
                lastSeq = ev.seq;
                h.onEvent(ev);
              }
            } catch {
              // 忽略无法解析的块
            }
          }
        }
        if (ended) {
          stopped = true;
          h.onConnectionChange?.('closed');
          h.onEnd?.();
          return;
        }
        // 连接被服务端关闭但未收到 end：重连
      } catch (e) {
        if (stopped || (e as Error).name === 'AbortError') return;
      }
      attempt += 1;
      h.onConnectionChange?.('retrying');
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 10000)));
    }
  };
  void run();

  return () => {
    stopped = true;
    ctrl.abort();
  };
}
