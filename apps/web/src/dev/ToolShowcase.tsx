import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { ToolCard } from '../claude/tools/ToolCard.js';
import { ToolViewState } from '../claude/tools/viewState.js';
import { cx } from '../ui/cx.js';
import { SAMPLE_CWD, TOOL_SAMPLES } from './toolSamples.js';

/** Every ToolCard variant with synthetic data. Replay remounts them with the enter animation. */
export function ToolShowcase() {
  const [run, setRun] = useState(0);
  const replayed = run > 0;
  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-body-sm text-text-2">
          One card per tool family, plus running and failed states.
        </p>
        <button
          type="button"
          onClick={() => setRun((r) => r + 1)}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-line bg-bg-2 px-2.5 text-label text-text-2 hover:border-line-strong hover:text-text-1"
        >
          <RotateCcw aria-hidden className="size-3.5" strokeWidth={1.5} />
          Replay entrance
        </button>
      </div>
      <ToolViewState key={run}>
        <div className="mx-auto max-w-3xl" data-tool-showcase>
          {TOOL_SAMPLES.map(({ label, row }, i) => (
            <div
              key={row.id}
              className={cx(i > 0 && 'pt-1.5', replayed && 'tool-enter')}
              data-sample={label}
            >
              <ToolCard row={row} cwd={SAMPLE_CWD} entering={replayed} />
            </div>
          ))}
        </div>
      </ToolViewState>
    </div>
  );
}
