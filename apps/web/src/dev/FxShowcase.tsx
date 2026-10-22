import { Check, OctagonX, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useInView } from '../anim/useFrame.js';
import { DarkVeil } from '../fx/DarkVeil.js';
import { DecryptedText } from '../fx/DecryptedText.js';
import { FaultyTerminal, type Phosphor } from '../fx/FaultyTerminal.js';
import { GlitchText } from '../fx/GlitchText.js';
import { HoldButton } from '../fx/HoldButton.js';
import { LightTunnel } from '../fx/LightTunnel.js';
import { RippleGrid, type RippleGridHandle } from '../fx/RippleGrid.js';
import { SoftAurora } from '../fx/SoftAurora.js';
import { SplitFlapText } from '../fx/SplitFlapText.js';
import { SwipeRow } from '../fx/SwipeRow.js';
import { useMotionLevel } from '../motion.js';
import { cx } from '../ui/cx.js';

const CAPTIONS = [
  'Editing src/cart/totals.ts',
  'Running pnpm test --filter cart',
  'Reading docs/checkout.md',
  'Waiting for approval: Bash(pnpm db:migrate)',
] as const;

const BOARD = [
  { project: 'ACME-SHOP', states: ['WORKING', 'WAITING', 'DONE'] },
  { project: 'ORBIT-API', states: ['IDLE', 'WORKING', 'ERROR'] },
] as const;

const STATE_TONE: Record<string, string> = {
  WORKING: 'text-st-work-ink',
  WAITING: 'text-st-wait-ink',
  DONE: 'text-st-ok-ink',
  ERROR: 'text-st-err-ink',
  IDLE: 'text-text-3',
};

const control =
  'rounded-control border border-line bg-bg-0 px-3 py-1.5 text-body-sm text-text-2 hover:border-line-strong hover:text-text-1';

function Demo({ name, use, children }: { name: string; use: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-control border border-line bg-bg-0 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-label text-text-1">{name}</span>
        <span className="truncate text-meta text-text-3">{use}</span>
      </div>
      {children}
    </div>
  );
}

/** DecryptedText, GlitchText and SplitFlapText, each driven by a button so every state is reachable. */
export function TextEffectsShowcase() {
  const [caption, setCaption] = useState(0);
  const [errors, setErrors] = useState(0);
  const [status, setStatus] = useState(0);
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Demo name="DecryptedText" use="Grid and Retro captions">
        <p className="min-h-10 font-mono text-body-sm text-text-1">
          <DecryptedText text={CAPTIONS[caption % CAPTIONS.length] ?? ''} />
        </p>
        <button
          type="button"
          className={cx(control, 'self-start')}
          onClick={() => setCaption((n) => n + 1)}
        >
          Next caption
        </button>
      </Demo>
      <Demo name="GlitchText" use="Grid error titles">
        <p className="min-h-10 text-title-sm font-semibold text-st-err-ink">
          <GlitchText burst={errors === 0 ? undefined : errors}>
            {errors === 0 ? 'Build failed: exit 1' : `Build failed: exit ${errors + 1}`}
          </GlitchText>
        </p>
        <button
          type="button"
          className={cx(control, 'self-start')}
          onClick={() => setErrors((n) => n + 1)}
        >
          Raise an error
        </button>
      </Demo>
      <Demo name="SplitFlapText" use="Transit and Retro status boards">
        <div className="flex min-h-10 flex-col gap-1.5 text-body-sm">
          {BOARD.map(({ project, states }) => {
            const state = states[status % states.length] ?? 'IDLE';
            return (
              <div key={project} className="flex items-center gap-3">
                <SplitFlapText text={project} className="text-text-2" />
                <SplitFlapText text={state} width={7} className={STATE_TONE[state]} />
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className={cx(control, 'self-start')}
          onClick={() => setStatus((n) => n + 1)}
        >
          Next status
        </button>
      </Demo>
    </div>
  );
}

const BACKGROUNDS = ['veil', 'aurora', 'terminal', 'grid', 'tunnel'] as const;
type Background = (typeof BACKGROUNDS)[number];

const BACKGROUND_INFO: Record<Background, { name: string; use: string }> = {
  veil: { name: 'DarkVeil', use: 'Ambient style "Veil"' },
  aurora: { name: 'SoftAurora', use: 'Ambient style "Aurora"' },
  terminal: { name: 'FaultyTerminal', use: 'Retro backdrop' },
  grid: { name: 'RippleGrid', use: 'Grid 2D map floor' },
  tunnel: { name: 'LightTunnel', use: 'Grid dive' },
};

/** The dive's travel, DESIGN.md §10.4 (about 900 ms). */
const DIVE_MS = 900;

/**
 * One background at a time, mounted only while this section is on screen: it holds the page's one
 * WebGL context, so the ambient field steps back to its CSS field meanwhile.
 */
export function BackgroundShowcase() {
  const level = useMotionLevel();
  const sectionRef = useRef<HTMLDivElement>(null);
  const shown = useInView(sectionRef);
  const [background, setBackground] = useState<Background>('veil');
  const [energy, setEnergy] = useState(0.5);
  const [phosphor, setPhosphor] = useState<Phosphor>('green');
  const [speed, setSpeed] = useState(0);
  const [surge, setSurge] = useState(0);
  const grid = useRef<RippleGridHandle>(null);

  useEffect(() => {
    if (speed === 0) return;
    const timer = setTimeout(() => setSpeed(0), DIVE_MS);
    return () => clearTimeout(timer);
  }, [speed]);

  const stage = 'h-80 w-full';
  const effect = !shown ? null : background === 'veil' ? (
    <DarkVeil energy={energy} attention={energy > 0.8 ? 1 : 0} className={stage} />
  ) : background === 'aurora' ? (
    <SoftAurora energy={energy} attention={energy > 0.8 ? 1 : 0} className={stage} />
  ) : background === 'terminal' ? (
    <FaultyTerminal energy={energy} phosphor={phosphor} className={stage} />
  ) : background === 'grid' ? (
    <RippleGrid ref={grid} energy={energy} tilt={58} className={stage} />
  ) : (
    <LightTunnel speed={speed} energy={energy} surge={surge} className={stage} />
  );

  return (
    <div ref={sectionRef} className="space-y-3" data-fx-showcase={background}>
      <div className="flex flex-wrap items-center gap-3">
        <fieldset className="flex rounded-control border border-line bg-bg-0 p-0.5">
          <legend className="sr-only">Background effect</legend>
          {BACKGROUNDS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === background}
              onClick={() => setBackground(option)}
              className="rounded-chip px-3 py-1 text-label text-text-2 transition-colors duration-fast hover:text-text-1 aria-pressed:bg-bg-2 aria-pressed:text-text-1 aria-pressed:shadow-raised"
            >
              {BACKGROUND_INFO[option].name}
            </button>
          ))}
        </fieldset>
        <label className="flex min-w-48 flex-1 items-center gap-3">
          <span className="font-mono text-label text-text-2">energy</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={energy}
            aria-label="Effect energy"
            onChange={(event) => setEnergy(Number(event.target.value))}
            className="h-6 flex-1 accent-[var(--st-work)]"
          />
          <span className="w-8 text-right font-mono text-meta tabular text-text-3">
            {energy.toFixed(2)}
          </span>
        </label>
        {background === 'terminal' && (
          <button
            type="button"
            className={control}
            onClick={() => setPhosphor((p) => (p === 'green' ? 'amber' : 'green'))}
          >
            {phosphor === 'green' ? 'Amber phosphor' : 'Green phosphor'}
          </button>
        )}
        {background === 'grid' && (
          <button
            type="button"
            className={control}
            onClick={() =>
              grid.current?.ripple(0.3 + Math.random() * 0.4, 0.45 + Math.random() * 0.3)
            }
          >
            Ripple
          </button>
        )}
        {background === 'tunnel' && (
          <>
            <button type="button" className={control} onClick={() => setSpeed(1)}>
              Dive
            </button>
            <button type="button" className={control} onClick={() => setSurge((n) => n + 1)}>
              Surge
            </button>
          </>
        )}
      </div>
      <div className="overflow-hidden rounded-control border border-line bg-bg-0">
        {effect ?? <div className={stage} />}
      </div>
      <p className="flex flex-wrap justify-between gap-2 text-meta text-text-3">
        <span>{BACKGROUND_INFO[background].use}</span>
        <span className="font-mono">
          {level === 'full'
            ? 'live · pauses off screen and in hidden tabs'
            : level === 'reduced'
              ? 'still frame'
              : 'static fallback, no WebGL'}
        </span>
      </p>
    </div>
  );
}

/** SwipeRow and HoldButton on a phone-width column. */
export function PhoneShowcase() {
  const [verdict, setVerdict] = useState<'allowed' | 'denied' | null>(null);
  const [round, setRound] = useState(0);
  const [stops, setStops] = useState(0);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Demo name="SwipeRow" use="Approvals on a phone: right to Allow, left to Deny">
        <div className="mx-auto w-full max-w-[390px]">
          {verdict === null ? (
            <SwipeRow
              key={round}
              right={{
                label: 'Allow',
                tone: 'ok',
                icon: <Check className="size-4" strokeWidth={1.5} />,
                onCommit: () => setVerdict('allowed'),
              }}
              left={{
                label: 'Deny',
                tone: 'err',
                icon: <X className="size-4" strokeWidth={1.5} />,
                onCommit: () => setVerdict('denied'),
              }}
            >
              <div className="rounded-panel border border-st-wait/40 bg-bg-1 p-4 shadow-raised">
                <p className="text-meta text-text-3">acme-shop wants to run</p>
                <p className="mt-1 truncate font-mono text-body-sm text-text-1">pnpm db:migrate</p>
                <div className="mt-3 flex gap-2">
                  <button type="button" className={control} onClick={() => setVerdict('allowed')}>
                    Allow
                  </button>
                  <button type="button" className={control} onClick={() => setVerdict('denied')}>
                    Deny
                  </button>
                </div>
              </div>
            </SwipeRow>
          ) : (
            <div className="flex items-center justify-between rounded-panel border border-line bg-bg-1 p-4">
              <span
                className={cx(
                  'text-body-sm font-medium',
                  verdict === 'allowed' ? 'text-st-ok-ink' : 'text-st-err-ink',
                )}
              >
                {verdict === 'allowed' ? 'Allowed' : 'Denied'}
              </span>
              <button
                type="button"
                className={control}
                onClick={() => {
                  setVerdict(null);
                  setRound((n) => n + 1);
                }}
              >
                Reset
              </button>
            </div>
          )}
        </div>
      </Demo>
      <Demo name="HoldButton" use="Kill a terminal or interrupt Claude on a phone">
        <div className="flex flex-wrap items-center gap-4">
          <HoldButton
            icon={<OctagonX className="size-4 text-st-err-ink" strokeWidth={1.5} />}
            doneLabel={
              <>
                <Check className="size-4 text-st-ok-ink" strokeWidth={1.5} />
                Stopped
              </>
            }
            onHold={() => setStops((n) => n + 1)}
          >
            Hold to stop pnpm dev
          </HoldButton>
          <span className="font-mono text-meta tabular text-text-3">stopped {stops}×</span>
        </div>
      </Demo>
    </div>
  );
}
