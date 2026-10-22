import { useEffect, useState } from 'react';
import { ClaudeOrb, type ClaudeOrbProps } from '../orb/ClaudeOrb.js';
import { ORB_STATES, type OrbState } from '../orb/model.js';

interface Sample {
  name: string;
  props: ClaudeOrbProps;
  /** Entered from this state, so the one-shot effect plays on mount and on replay. */
  from?: OrbState;
}

const COUNTDOWN_MS = 20_000;

const SAMPLES: readonly Sample[] = [
  { name: 'idle', props: { state: 'idle', accent: 'var(--accent-6)' } },
  { name: 'working', props: { state: 'working' } },
  { name: 'tool · Bash', props: { state: 'tool', tool: 'Bash' } },
  { name: 'tool · Edit', props: { state: 'tool', tool: 'Edit' } },
  { name: 'tool · Grep', props: { state: 'tool', tool: 'Grep' } },
  { name: 'tool · WebFetch', props: { state: 'tool', tool: 'WebFetch' } },
  { name: 'tool · Task', props: { state: 'tool', tool: 'Task', subagents: 1 } },
  { name: 'subagents', props: { state: 'working', subagents: 3 } },
  { name: 'waiting', props: { state: 'waiting' }, from: 'working' },
  { name: 'waiting · timeout', props: { state: 'waiting', countdown: null }, from: 'working' },
  { name: 'error', props: { state: 'error' }, from: 'working' },
  { name: 'compacting', props: { state: 'compacting' }, from: 'working' },
  { name: 'done', props: { state: 'idle', accent: 'var(--accent-2)' }, from: 'working' },
  { name: 'ended', props: { state: 'ended', accent: 'var(--accent-6)' } },
];

const SIZES = [28, 40, 52, 64] as const;

function OrbCard({ sample, replay }: { sample: Sample; replay: number }) {
  const [state, setState] = useState<OrbState>(sample.from ?? sample.props.state);
  const [countdown, setCountdown] = useState<ClaudeOrbProps['countdown']>(null);
  const timed = sample.name === 'waiting · timeout';

  // biome-ignore lint/correctness/useExhaustiveDependencies: `replay` restarts the entrance.
  useEffect(() => {
    if (!sample.from) return;
    setState(sample.from);
    const timer = setTimeout(() => setState(sample.props.state), 450);
    return () => clearTimeout(timer);
  }, [replay, sample]);

  // A looping countdown that starts a third of the way through, so the ring reads in a still.
  useEffect(() => {
    if (!timed) return;
    const start = () => {
      const now = Date.now() - COUNTDOWN_MS / 3;
      setCountdown({ startedAt: now, endsAt: now + COUNTDOWN_MS });
    };
    start();
    const timer = setInterval(start, COUNTDOWN_MS);
    return () => clearInterval(timer);
  }, [timed]);

  return (
    <figure className="flex min-w-0 flex-col rounded-control border border-line bg-bg-0 p-3">
      <div className="flex h-20 items-center pl-5">
        <ClaudeOrb {...sample.props} state={state} countdown={timed ? countdown : null} size={56} />
      </div>
      <figcaption className="truncate font-mono text-meta text-text-3">{sample.name}</figcaption>
    </figure>
  );
}

/** Every orb state side by side (DESIGN.md §4.2), plus the size range. */
export function OrbShowcase() {
  const [replay, setReplay] = useState(0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {SAMPLES.map((sample) => (
          <OrbCard key={sample.name} sample={sample} replay={replay} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-6 border-t border-line pt-4">
        {SIZES.map((size) => (
          <span key={size} className="flex items-center gap-3">
            <ClaudeOrb state="working" size={size} accent="var(--accent-7)" />
            <span className="font-mono text-meta tabular text-text-3">{size}px</span>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setReplay((n) => n + 1)}
          className="ml-auto rounded-control border border-line bg-bg-0 px-3 py-1.5 text-body-sm text-text-2 hover:border-line-strong"
        >
          Replay effects
        </button>
        <span className="font-mono text-meta text-text-3">{ORB_STATES.length} states</span>
      </div>
    </div>
  );
}
