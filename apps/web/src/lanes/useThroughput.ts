import { useEffect, useRef } from 'react';
import { useBoardStore } from '../data/index.js';
import type { BoardStore } from '../data/store.js';
import { type ThroughputListener, ThroughputSampler } from './throughput.js';

const samplers = new WeakMap<BoardStore, ThroughputSampler>();

export function throughputSampler(store: BoardStore): ThroughputSampler {
  let sampler = samplers.get(store);
  if (!sampler) {
    sampler = new ThroughputSampler({
      getBoard: () => store.getState().board,
      now: () => Date.now(),
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });
    samplers.set(store, sampler);
  }
  return sampler;
}

/** Calls `listener` with the terminal's sample ring on watch and after every sample. */
export function useThroughput(terminalId: string, listener: ThroughputListener): void {
  const store = useBoardStore();
  const callback = useRef(listener);
  callback.current = listener;
  useEffect(
    () => throughputSampler(store).watch(terminalId, (ring) => callback.current(ring)),
    [store, terminalId],
  );
}
