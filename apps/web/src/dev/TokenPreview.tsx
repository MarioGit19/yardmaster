import { motion } from 'motion/react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import {
  dur,
  MOTION_SETTINGS,
  type MotionSetting,
  motionPreference,
  spring,
  useMotionLevel,
} from '../motion.js';
import { usePreference } from '../prefs.js';
import { ACCENT_HUES } from '../theme/accents.js';
import { THEME_SETTINGS, type Theme, useTheme } from '../theme/theme.js';

const SURFACES = ['bg-0', 'bg-1', 'bg-2', 'glass'] as const;
const LINES = ['line', 'line-strong'] as const;
const TEXTS = ['text-1', 'text-2', 'text-3'] as const;

// Literal glow classes so Tailwind's scanner picks them up.
const STATUSES = [
  { token: 'work', label: 'Working', glow: 'glow-st-work' },
  { token: 'tool', label: 'Tool active', glow: 'glow-st-tool' },
  { token: 'wait', label: 'Waiting for you', glow: 'glow-st-wait' },
  { token: 'ok', label: 'Done', glow: 'glow-st-ok' },
  { token: 'err', label: 'Crashed', glow: 'glow-st-err' },
  { token: 'idle', label: 'Idle', glow: 'glow-st-idle' },
] as const;

const TYPE_SCALE = [
  { cls: 'text-hero', name: 'hero-number', px: 44, sample: '128.4k', mono: true },
  { cls: 'text-display', name: 'display', px: 28, sample: 'Five projects, two need you' },
  { cls: 'text-title', name: 'title', px: 20, sample: 'acme-shop' },
  { cls: 'text-title-sm', name: 'title-sm', px: 16, sample: 'Attention Center' },
  {
    cls: 'text-body',
    name: 'body',
    px: 14,
    sample: 'Refactoring the cart totals to use integer cents.',
  },
  { cls: 'text-body-sm', name: 'body-sm', px: 13, sample: 'Editing src/cart.ts' },
  { cls: 'text-label', name: 'label', px: 12, sample: 'feat/checkout' },
  { cls: 'text-meta', name: 'meta', px: 11, sample: 'Updated 2m ago' },
] as const;

const RADII = [
  { cls: 'rounded-chip', name: 'chip', px: 6 },
  { cls: 'rounded-control', name: 'control', px: 10 },
  { cls: 'rounded-panel', name: 'panel', px: 16 },
  { cls: 'rounded-modal', name: 'modal', px: 24 },
] as const;

/** Reads a token's computed value, refreshed whenever the theme changes. */
function useTokenValue(name: string, theme: Theme): string {
  const [value, setValue] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme switches the token set.
  useLayoutEffect(() => {
    setValue(getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim());
  }, [name, theme]);
  return value;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-panel border border-line bg-bg-1 p-5 shadow-raised">
      <h2 className="mb-4 text-title-sm font-medium text-text-1">{title}</h2>
      {children}
    </section>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange(value: T): void;
}) {
  return (
    <fieldset className="flex rounded-control border border-line bg-bg-1 p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
          className="relative rounded-chip px-3 py-1 text-label capitalize text-text-2 transition-colors duration-150 hover:text-text-1 aria-pressed:text-text-1"
        >
          {option === value && (
            <motion.span
              layoutId={`seg-${label}`}
              transition={spring.snappy}
              className="absolute inset-0 rounded-chip bg-bg-2 shadow-raised"
            />
          )}
          <span className="relative">{option}</span>
        </button>
      ))}
    </fieldset>
  );
}

function Swatch({ token, theme, children }: { token: string; theme: Theme; children?: ReactNode }) {
  const value = useTokenValue(token, theme);
  return (
    <figure className="min-w-0">
      <div
        className="h-14 rounded-control border border-line"
        style={{ background: `var(--${token})` }}
      >
        {children}
      </div>
      <figcaption className="mt-2 truncate font-mono text-meta text-text-2">--{token}</figcaption>
      <p className="truncate font-mono text-meta text-text-3" title={value}>
        {value || ' '}
      </p>
    </figure>
  );
}

function StatusSample({ token, label, theme }: { token: string; label: string; theme: Theme }) {
  const value = useTokenValue(`st-${token}`, theme);
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-control border border-line bg-bg-0 px-3 py-2.5">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{
          background: `var(--st-${token})`,
          boxShadow: `0 0 0 3px var(--st-${token}-glow)`,
        }}
      />
      <span
        className="min-w-0 flex-1 truncate text-body-sm"
        style={{ color: `var(--st-${token})` }}
      >
        {label}
      </span>
      <span className="font-mono text-meta text-text-3">--st-{token}</span>
      <span className="w-16 text-right font-mono text-meta tabular text-text-3">{value}</span>
    </div>
  );
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function SpringDemo({ name }: { name: keyof typeof spring }) {
  const [on, setOn] = useState(false);
  const [track, width] = useWidth<HTMLSpanElement>();
  return (
    <button
      type="button"
      onClick={() => setOn((v) => !v)}
      className="flex w-full items-center gap-4 rounded-control border border-line bg-bg-0 px-3 py-2.5 text-left hover:border-line-strong"
    >
      <span className="w-16 font-mono text-label text-text-2">{name}</span>
      <span ref={track} className="relative h-6 flex-1">
        <span className="absolute inset-x-0 top-1/2 h-px bg-line" />
        <motion.span
          className="absolute top-1 left-0 size-4 rounded-full bg-st-work"
          style={{ boxShadow: '0 0 12px var(--st-work-glow)' }}
          animate={{ x: on ? Math.max(0, width - 16) : 0 }}
          transition={spring[name]}
        />
      </span>
      <span className="font-mono text-meta tabular text-text-3">
        {spring[name].stiffness}/{spring[name].damping}
      </span>
    </button>
  );
}

const SPRING_NAMES = Object.keys(spring) as (keyof typeof spring)[];

export default function TokenPreview() {
  const { setting, theme, setTheme } = useTheme();
  const motionSetting = usePreference(motionPreference);
  const level = useMotionLevel();

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-8 sm:px-8">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-label font-medium text-text-3">c-board</p>
          <h1 className="text-display font-semibold">Design tokens</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented label="Theme" options={THEME_SETTINGS} value={setting} onChange={setTheme} />
          <Segmented<MotionSetting>
            label="Motion"
            options={MOTION_SETTINGS}
            value={motionSetting}
            onChange={motionPreference.set}
          />
          <span className="font-mono text-meta text-text-3">
            {theme} · motion {level}
          </span>
        </div>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Section title="Surfaces">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {SURFACES.map((token) => (
              <Swatch key={token} token={token} theme={theme} />
            ))}
          </div>
        </Section>

        <Section title="Lines and text">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {LINES.map((token) => (
              <Swatch key={token} token={token} theme={theme} />
            ))}
            {TEXTS.map((token) => (
              <Swatch key={token} token={token} theme={theme} />
            ))}
          </div>
        </Section>

        <Section title="Status">
          <div className="space-y-2">
            {STATUSES.map(({ token, label }) => (
              <StatusSample key={token} token={token} label={label} theme={theme} />
            ))}
          </div>
        </Section>

        <Section title="Status emphasis">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {STATUSES.map(({ token, label, glow }) => (
              <div
                key={token}
                className={`${glow} flex h-16 items-end rounded-panel bg-bg-0 p-3 text-meta text-text-2`}
              >
                {label}
              </div>
            ))}
          </div>
        </Section>

        <Section title="Project accents">
          <div className="grid grid-cols-5 gap-3">
            {ACCENT_HUES.map((hue, i) => (
              <figure key={hue} className="min-w-0">
                <div
                  className="mx-auto grid size-11 place-items-center rounded-full border-2 bg-bg-0"
                  style={{ borderColor: `var(--accent-${i})` }}
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ background: `var(--accent-${i})` }}
                  />
                </div>
                <figcaption className="mt-2 text-center font-mono text-meta tabular text-text-3">
                  h {hue}
                </figcaption>
              </figure>
            ))}
          </div>
        </Section>

        <Section title="Radius and elevation">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {RADII.map(({ cls, name, px }) => (
              <div key={name}>
                <div className={`${cls} h-14 border border-line bg-bg-2 shadow-raised`} />
                <p className="mt-2 font-mono text-meta text-text-3">
                  {name} · {px}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="glass rounded-panel border border-line p-4 text-body-sm text-text-2 shadow-raised">
              Glass pod surface
            </div>
            <button
              type="button"
              className="rounded-control border border-line bg-bg-2 px-4 text-body-sm text-text-1 hover:border-line-strong"
            >
              Focusable (Tab to me)
            </button>
          </div>
        </Section>

        <Section title="Type">
          <div className="space-y-3">
            {TYPE_SCALE.map((row) => (
              <div key={row.name} className="flex items-baseline gap-4">
                <span className="w-28 shrink-0 font-mono text-meta tabular text-text-3">
                  {row.name} · {row.px}
                </span>
                <span
                  className={`${row.cls} min-w-0 truncate ${'mono' in row ? 'font-mono tabular' : ''}`}
                >
                  {row.sample}
                </span>
              </div>
            ))}
            <div className="flex items-baseline gap-4 border-t border-line pt-3">
              <span className="w-28 shrink-0 font-mono text-meta text-text-3">mono · 13</span>
              <span className="min-w-0 truncate font-mono text-body-sm text-text-2">
                pnpm dev <span className="text-st-ok">✓</span> ready on :3000
              </span>
            </div>
          </div>
        </Section>

        <Section title="Motion">
          <div className="space-y-2">
            {SPRING_NAMES.map((name) => (
              <SpringDemo key={name} name={name} />
            ))}
          </div>
          <p className="mt-3 font-mono text-meta tabular text-text-3">
            fast {dur.fast * 1000}ms · base {dur.base * 1000}ms · slow {dur.slow * 1000}ms
          </p>
        </Section>
      </div>
    </div>
  );
}
