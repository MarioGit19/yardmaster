import { useState } from 'react';
import { CrewMascot, type CrewMascotProps } from '../crew/CrewMascot.js';
import { MASCOT_STATES, type MascotState } from '../crew/model.js';

const SIZES = [120, 56, 24] as const;

/** Sheet extras per state, so each one shows its full acting. */
const EXTRA: Partial<Record<MascotState, Partial<CrewMascotProps>>> = {
  watching: { activity: 0.6 },
  typing: { tool: 'Edit' },
  reading: { tool: 'Grep' },
  running: { tool: 'Bash' },
  delegating: { tool: 'Task', subagents: 1 },
  error: { settle: false },
  done: { settle: false },
};

const STRESS_STATES: readonly MascotState[] = [
  'typing',
  'reading',
  'running',
  'thinking',
  'watching',
  'waiting',
  'idle',
  'delegating',
  'sleeping',
  'typing',
];

const STRESS = Array.from({ length: 30 }, (_, i) => ({
  id: `crew-${i}`,
  i,
  state: STRESS_STATES[i % STRESS_STATES.length] ?? 'idle',
}));

const accent = (i: number) => `var(--accent-${i % 10})`;

function StateCard({ state, index }: { state: MascotState; index: number }) {
  return (
    <figure className="flex min-w-0 flex-col gap-2 rounded-control border border-line bg-bg-0 p-3">
      <div className="flex items-end gap-6 pr-14">
        {SIZES.map((size) => (
          <CrewMascot
            key={size}
            state={state}
            size={size}
            color={accent(index)}
            {...EXTRA[state]}
          />
        ))}
      </div>
      <figcaption className="truncate font-mono text-meta text-text-3">{state}</figcaption>
    </figure>
  );
}

/**
 * The crew mascot's character sheet (DESIGN.md §4.11): every state at every size, a live
 * switcher to see the blends, and a 30-mascot stress grid for the FPS check.
 */
export function CrewSheet() {
  const [live, setLive] = useState<MascotState>('idle');
  const [subagents, setSubagents] = useState(0);
  const [stress, setStress] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-control border border-line bg-bg-0 p-4">
        <div className="flex items-end gap-6">
          {SIZES.map((size) => (
            // Room for up to three mini crew members beside each size.
            <span key={size} style={{ paddingRight: size * 1.4 }}>
              <CrewMascot
                state={live}
                size={size}
                color="var(--accent-6)"
                subagents={subagents}
                activity={0.5}
              />
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <fieldset className="flex flex-wrap gap-1.5">
            <legend className="sr-only">Crew state</legend>
            {MASCOT_STATES.map((state) => (
              <button
                key={state}
                type="button"
                aria-pressed={state === live}
                onClick={() => setLive(state)}
                className="rounded-chip border border-line px-2.5 py-1 font-mono text-label text-text-2 transition-colors duration-150 hover:border-line-strong hover:text-text-1 aria-pressed:border-line-strong aria-pressed:bg-bg-2 aria-pressed:text-text-1"
              >
                {state}
              </button>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-meta text-text-3">subagents</span>
            {[0, 1, 2, 3].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={n === subagents}
                aria-label={`${n} subagents`}
                onClick={() => setSubagents(n)}
                className="size-7 rounded-chip border border-line font-mono text-label tabular text-text-2 hover:border-line-strong aria-pressed:border-line-strong aria-pressed:bg-bg-2 aria-pressed:text-text-1"
              >
                {n}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={stress}
              onClick={() => setStress((on) => !on)}
              className="ml-auto rounded-control border border-line px-3 py-1.5 text-body-sm text-text-2 hover:border-line-strong aria-pressed:border-line-strong aria-pressed:text-text-1"
            >
              30 on screen
            </button>
          </div>
        </div>
      </div>

      {stress && (
        <div
          data-crew-stress
          className="grid grid-cols-6 gap-2 rounded-control border border-line bg-bg-0 p-3 sm:grid-cols-10"
        >
          {STRESS.map(({ id, i, state }) => (
            <div key={id} className="grid h-16 place-items-center">
              <CrewMascot state={state} size={56} color={accent(i)} {...EXTRA[state]} />
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {MASCOT_STATES.map((state, i) => (
          <StateCard key={state} state={state} index={i} />
        ))}
      </div>
    </div>
  );
}
