import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Link } from 'wouter';
import { useOwnBackdrop } from '../ambient/backdrop.js';
import { OffstageContext } from '../anim/useFrame.js';
import { useBoardStore } from '../data/index.js';
import { throughputSampler } from '../lanes/useThroughput.js';
import { ActorInspector } from '../layouts/ActorInspector.js';
import type { SceneActor, SceneProject } from '../layouts/scene.js';
import { useOverviewScene } from '../layouts/useScene.js';
import { countOf } from '../plural.js';
import type { CaptionTone } from '../pod/model.js';
import { usePreference } from '../prefs.js';
import { projectHref } from '../routes.js';
import { isTypingTarget } from '../shell/railNav.js';
import { toneLabel } from '../status.js';
import { cx } from '../ui/cx.js';
import {
  actorTag,
  asciiSpark,
  bodyLines,
  consoleGrid,
  FLAT_SPARK,
  fit,
  GAP,
  isBusy,
  KIND_GLYPH,
  NUMBER_WAIT_MS,
  PROJECT_SPARK,
  pickNumber,
  projectTag,
  type RowColumns,
  rowColumns,
  type Samples,
  STACK_BELOW_PX,
} from './console.js';
import { phosphorPreference } from './phosphor.js';
import { TypedText } from './TypedText.js';

/** Where the console starts when it can't measure (no layout engine): an 80-column terminal. */
const FALLBACK = { chars: 80, lines: 50 };
/** The page's bottom padding, kept clear when fitting the frames to the screen. */
const BOTTOM_PX = 24;
/** Stacked (phone) frames show at most this many actors, then "+N more". */
const STACKED_BODY = 8;

interface Metrics {
  chars: number;
  lines: number;
  stacked: boolean;
}

/**
 * DESIGN.md §10.6: the board as a green-phosphor text console. Each project is a box-drawing
 * frame on one character grid with its status tag, branch, ports and an ASCII sparkline; each
 * actor is a line with its tag and its live caption, typed out as it changes, and a blinking
 * block cursor while it works. Number keys jump to a project, then to an actor in it. On a phone
 * it reflows to one frame per row, each actor on two lines so it is a full tap target.
 */
export default function RetroLayout() {
  useOwnBackdrop();
  const scene = useOverviewScene();
  const phosphor = usePreference(phosphorPreference);
  const offstage = useContext(OffstageContext);
  const root = useRef<HTMLElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      // Touch screens get the stacked console at any width: two-line actors are 44 px targets.
      const stacked =
        width > 0 && (width < STACK_BELOW_PX || matchMedia('(pointer: coarse)').matches);
      element.toggleAttribute('data-stacked', stacked);
      const ch = (probe.current?.getBoundingClientRect().width ?? 0) / 100;
      const line = Number.parseFloat(getComputedStyle(element).lineHeight);
      if (!(ch > 0) || !(line > 0)) {
        setMetrics((m) => m ?? { ...FALLBACK, stacked });
        return;
      }
      // The frames fit the visible part of the scrolling main area below the console's top.
      const main = element.closest('main');
      const top = element.getBoundingClientRect().top;
      const view = main
        ? main.getBoundingClientRect().top + main.clientHeight
        : globalThis.innerHeight;
      const lines = Math.floor((view - top - (main?.scrollTop ?? 0) - BOTTOM_PX) / line);
      const next = { chars: Math.floor(width / ch), lines: Math.max(1, lines), stacked };
      setMetrics((m) =>
        m && m.chars === next.chars && m.lines === next.lines && m.stacked === next.stacked
          ? m
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    globalThis.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      globalThis.removeEventListener('resize', measure);
    };
  }, []);

  const projects = scene.projects;
  const stacked = metrics?.stacked ?? false;
  const grid = consoleGrid(metrics?.chars ?? FALLBACK.chars, projects.length, stacked);
  const rows = Math.ceil(projects.length / grid.cols);
  const busiest = Math.max(0, ...projects.map((p) => p.actors.length));
  const body = stacked ? STACKED_BODY : bodyLines(busiest, rows, metrics?.lines ?? FALLBACK.lines);
  const fresh = useFreshActors(projects);
  useNumberKeys(root, projects.length, offstage);

  return (
    <>
      <div
        aria-hidden
        data-retro-ground
        data-phosphor={phosphor}
        className="retro-ground pointer-events-none fixed inset-0 -z-10"
      />
      <section
        ref={root}
        tabIndex={-1}
        data-retro
        data-phosphor={phosphor}
        data-retro-cols={grid.cols}
        data-paused={offstage || undefined}
        aria-label="Retro console. Type a project's number to jump to it, then an actor's number."
        className="retro relative w-full outline-none"
      >
        <span ref={probe} aria-hidden className="retro-probe">
          0
        </span>
        {projects.length === 0 ? (
          <p className="retro-line retro-dim">NO PROJECTS. READY.</p>
        ) : (
          <ul
            aria-label="Projects"
            className="retro-grid"
            style={{
              gridTemplateColumns: `repeat(${grid.cols}, ${grid.width}ch)`,
              columnGap: `${GAP}ch`,
            }}
          >
            {projects.map((project, index) => (
              <RetroFrame
                key={project.id}
                project={project}
                number={index + 1}
                width={grid.width}
                body={body}
                stacked={stacked}
                fresh={fresh}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Actors that appeared after the console was first drawn: their line scrolls in once (§10.6). */
function useFreshActors(projects: readonly SceneProject[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  const ids = projects.flatMap((p) => p.actors.map((a) => a.id));
  if (seen.current === null) {
    seen.current = new Set(ids);
  } else {
    for (const id of ids) {
      if (!seen.current.has(id)) {
        seen.current.add(id);
        fresh.current.add(id);
      }
    }
  }
  return fresh.current;
}

/**
 * Number shortcuts (§10.6): on the board a number focuses that project's frame; inside a frame
 * it focuses that actor. "1" of 20 projects focuses the first and waits a moment for "12".
 */
function useNumberKeys(
  root: React.RefObject<HTMLElement | null>,
  projects: number,
  offstage: boolean,
) {
  const buffer = useRef({ text: '', scope: '', at: 0 });
  const count = useRef(projects);
  count.current = projects;

  useEffect(() => {
    if (offstage) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!/^\d$/.test(event.key) || isTypingTarget(event.target)) return;
      const console = root.current;
      const target = event.target as Node | null;
      if (!console || console.closest('[inert]')) return;
      if (target !== document.body && !(target && console.contains(target))) return;

      // A number still waiting for its next digit keeps its scope: "1" then "2" is project 12,
      // even though "1" already moved focus into the first frame.
      const state = buffer.current;
      const now = event.timeStamp;
      const continues = state.text !== '' && now - state.at < NUMBER_WAIT_MS;
      const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
        '[data-retro-frame]',
      );
      const here = focused && console.contains(focused) ? (focused.dataset.retroFrame ?? '') : '';
      const scope = continues ? state.scope : here;
      const frame = scope
        ? console.querySelector<HTMLElement>(`[data-retro-frame="${CSS.escape(scope)}"]`)
        : null;
      const targets = scope
        ? [...(frame?.querySelectorAll<HTMLElement>('[data-retro-key]') ?? [])]
        : [...console.querySelectorAll<HTMLElement>('[data-retro-name]')];
      const total = scope ? targets.length : count.current;
      let text = (continues ? state.text : '') + event.key;
      let pick = pickNumber(text, total);
      if (pick.index === null && !pick.pending && text.length > 1) {
        text = event.key;
        pick = pickNumber(text, total);
      }
      buffer.current = { text: pick.pending ? text : '', scope, at: now };
      if (pick.index === null) return;
      event.preventDefault();
      targets[pick.index]?.focus();
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [root, offstage]);
}

interface FrameProps {
  project: SceneProject;
  number: number;
  /** Characters, borders included. */
  width: number;
  /** Actor lines (desktop) or actors (stacked). */
  body: number;
  stacked: boolean;
  fresh: ReadonlySet<string>;
}

function RetroFrame({ project, number, width, body, stacked, fresh }: FrameProps) {
  const inner = width - 4;
  const actors = project.actors;
  const shown = actors.length > body ? actors.slice(0, body - 1) : actors;
  const hidden = actors.length - shown.length;
  const columns = rowColumns(inner, shown.length);
  const pads = stacked ? 0 : body - shown.length - (hidden > 0 ? 1 : 0) - (actors.length ? 0 : 1);
  const terminals = actors.filter((a) => a.links.terminalId).map((a) => a.links.terminalId ?? '');

  // Arrows move through the frame's lines, Esc steps back: actor → frame → board.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const frame = event.currentTarget;
    const name = frame.querySelector<HTMLElement>('[data-retro-name]');
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      if (event.target === name) frame.closest<HTMLElement>('[data-retro]')?.focus();
      else name?.focus();
      return;
    }
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const items = [name, ...frame.querySelectorAll<HTMLElement>('[data-retro-item]')].filter(
      (item): item is HTMLElement => item !== null,
    );
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    items[(current + step + items.length) % items.length]?.focus();
  };

  const count = countOf(actors.length, 'actor');

  return (
    <li
      data-retro-frame={project.id}
      data-tone={project.tone}
      data-dim={project.dim || undefined}
      data-scene-leaving={project.leaving}
      inert={project.leaving}
      onKeyDown={onKeyDown}
      className="retro-frame"
    >
      <Link
        href={projectHref(project.id)}
        data-retro-name={project.id}
        data-focus-return={project.id}
        aria-label={`[${number}] ${project.name}, ${toneLabel(project.tone)}, ${count}. Open with Enter, or type an actor's number.`}
        className="retro-hit block"
      >
        <TopBorder project={project} number={number} width={width} />
        {stacked && (
          <Line>
            <Bar /> <MetaLine project={project} width={inner} terminals={terminals} /> <Bar />
          </Line>
        )}
      </Link>

      {actors.length === 0 && (
        <Line>
          <Bar /> <span className="retro-dim">{fit('nothing running', inner)}</span> <Bar />
        </Line>
      )}
      {shown.map((actor, index) => (
        <ActorLine
          key={actor.id}
          actor={actor}
          index={index + 1}
          projectName={project.name}
          columns={columns}
          inner={inner}
          stacked={stacked}
          fresh={fresh.has(actor.id)}
        />
      ))}
      {hidden > 0 && (
        <Sides lines={stacked ? 2 : 1}>
          <Link
            href={projectHref(project.id)}
            tabIndex={-1}
            data-retro-item
            data-retro-more={hidden}
            aria-label={`${hidden} more in ${project.name}: open the project`}
            className="retro-hit retro-dim block"
            style={{ width: `${inner + 2}ch` }}
          >
            {stacked ? (
              <>
                <span className="block">{fit(` +${hidden} more`, inner + 2)}</span>
                <span className="block">{fit(`     open ${project.name} →`, inner + 2)}</span>
              </>
            ) : (
              fit(` +${hidden} more · open →`, inner + 2)
            )}
          </Link>
        </Sides>
      )}
      {Array.from({ length: Math.max(0, pads) }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blank filler lines
        <Line key={i}>
          <Bar />
          {' '.repeat(inner + 2)}
          <Bar />
        </Line>
      ))}

      {stacked ? (
        <Line>
          <Corner at="bl" />
          <Rule width={width - 2} />
          <Corner at="br" />
        </Line>
      ) : (
        <BottomBorder project={project} width={width} terminals={terminals} />
      )}
    </li>
  );
}

function Line({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('retro-line', className)}>{children}</div>;
}

function Border({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="retro-dim">
      {children}
    </span>
  );
}

/** A run of frame border `width` characters long. */
function Rule({ width }: { width: number }) {
  return <span aria-hidden className="retro-rule" style={{ width: `${width}ch` }} />;
}

/** A frame corner in one character cell. */
function Corner({ at }: { at: 'tl' | 'tr' | 'bl' | 'br' }) {
  return <span aria-hidden className="retro-corner" data-corner={at} />;
}

/**
 * A frame's side, one character cell wide. The frame's lines are drawn on the character grid
 * rather than typed: box-drawing glyphs are shorter than the line, so they would not join.
 */
function Bar() {
  return <span aria-hidden className="retro-bar" />;
}

/** A frame line `lines` tall, with its sides down both edges. */
function Sides({
  lines,
  children,
  className,
}: {
  lines: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx('retro-row', className)}
      style={{ height: `calc(var(--retro-line) * ${lines})` }}
    >
      <Bar />
      {children}
      <Bar />
    </div>
  );
}

/** A field exactly `width` characters wide, whatever glyphs the text holds. */
function Cell({
  width,
  className,
  title,
  children,
}: {
  width: number;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx('retro-cell', className)} style={{ width: `${width}ch` }} title={title}>
      {children}
    </span>
  );
}

/** `┌─[3] acme-shop ─────────── [WAIT]─┐`, every piece a whole number of characters. */
function TopBorder({
  project,
  number,
  width,
}: {
  project: SceneProject;
  number: number;
  width: number;
}) {
  const key = `[${number}]`;
  const tag = projectTag(project.tone);
  // ┌─ key ␠ name ␠ fill ␠ tag ─┐
  const fixed = 2 + key.length + 1 + 1 + 1 + tag.length + 2;
  const nameWidth = Math.max(1, Math.min(Array.from(project.name).length, width - fixed - 1));
  const fill = width - fixed - nameWidth;
  return (
    <Line>
      <Corner at="tl" />
      <Rule width={1} />
      <span aria-hidden className="retro-key">
        {key}
      </span>
      <Border> </Border>
      <Cell width={nameWidth} className="retro-name" title={project.name}>
        {fit(project.name, nameWidth)}
      </Cell>
      <Border> </Border>
      <Rule width={fill} />
      <Border> </Border>
      <span aria-hidden className="retro-tag" data-tone={project.tone}>
        {tag}
      </span>
      <Rule width={1} />
      <Corner at="tr" />
    </Line>
  );
}

/** Branch, uncommitted files and ports: `main *3 :3000 :5173`. */
function metaText(project: SceneProject): string {
  const parts = [
    project.branch ? `${project.branch}${project.dirty ? ` *${project.dirty}` : ''}` : null,
    ...project.ports.map((port) => `:${port}`),
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : 'no branch';
}

/** `└─ main *3 :3000 ──────── ▁▂▃▅▇▆▃▁ ─┘` */
function BottomBorder({
  project,
  width,
  terminals,
}: {
  project: SceneProject;
  width: number;
  terminals: readonly string[];
}) {
  const meta = metaText(project);
  // └─ ␠ meta ␠ fill ␠ spark ␠ ─┘
  const fixed = 2 + 1 + 1 + 1 + PROJECT_SPARK + 1 + 2;
  const metaWidth = Math.max(1, Math.min(Array.from(meta).length, width - fixed - 1));
  const fill = width - fixed - metaWidth;
  return (
    <Line>
      <Corner at="bl" />
      <Rule width={1} />
      <Border> </Border>
      <Cell width={metaWidth} className="retro-dim" title={meta}>
        {fit(meta, metaWidth)}
      </Cell>
      <Border> </Border>
      <Rule width={fill} />
      <Border> </Border>
      <Spark terminals={terminals} width={PROJECT_SPARK} />
      <Border> </Border>
      <Rule width={1} />
      <Corner at="br" />
    </Line>
  );
}

/** The phone's second header line: meta on the left, the project's sparkline on the right. */
function MetaLine({
  project,
  width,
  terminals,
}: {
  project: SceneProject;
  width: number;
  terminals: readonly string[];
}) {
  const meta = metaText(project);
  return (
    <>
      <Cell width={width - PROJECT_SPARK - 1} className="retro-dim" title={meta}>
        {fit(meta, width - PROJECT_SPARK - 1)}
      </Cell>
      <span aria-hidden> </span>
      <Spark terminals={terminals} width={PROJECT_SPARK} />
    </>
  );
}

/** An ASCII sparkline of the terminals' output, repainted once a sample without re-rendering. */
function Spark({ terminals, width }: { terminals: readonly string[]; width: number }) {
  const store = useBoardStore();
  const ref = useRef<HTMLSpanElement>(null);
  const key = terminals.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `terminals`.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rings = new Map<string, Samples>();
    const paint = () => {
      element.textContent = asciiSpark([...rings.values()], width);
    };
    element.textContent = FLAT_SPARK(width);
    const sampler = throughputSampler(store);
    const stops = terminals.map((id) =>
      sampler.watch(id, (ring) => {
        rings.set(id, ring);
        paint();
      }),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [store, key, width]);
  return <span ref={ref} aria-hidden data-retro-spark className="retro-spark" />;
}

const CAPTION_CLASS: Record<CaptionTone, string> = {
  active: 'retro-bright',
  wait: 'retro-tone-wait',
  err: 'retro-tone-err',
  rest: 'retro-dim',
};

function ActorLine({
  actor,
  index,
  projectName,
  columns,
  inner,
  stacked,
  fresh,
}: {
  actor: SceneActor;
  index: number;
  projectName: string;
  columns: RowColumns;
  inner: number;
  stacked: boolean;
  fresh: boolean;
}) {
  const busy = isBusy(actor.tone);
  const key = fit(`[${index}]`, columns.num);
  const label = `${actor.parentId ? '└ ' : ''}${actor.label}`;
  // Stacked, the label takes the whole first line up to the tag: ␠[n]␠»␠label␠[TAG]␠.
  const labelWidth = stacked ? inner - columns.num - 10 : columns.label;
  const tag = (
    <span className="retro-tag" data-tone={actor.tone}>
      {actorTag(actor.state)}
    </span>
  );
  // `width` cells: the text (clipped one short) and the cursor right after it.
  const caption = (width: number) => (
    <span
      className={cx('retro-caption', CAPTION_CLASS[actor.caption.tone])}
      style={{ width: `${width}ch` }}
    >
      <TypedText
        text={fit(actor.caption.text, width - 1).trimEnd()}
        title={actor.caption.text}
        className="retro-caption-text"
        style={{ maxWidth: `${width - 1}ch` }}
      />
      {busy && (
        <span className="retro-cursor" data-blink="">
          █
        </span>
      )}
    </span>
  );

  return (
    <Sides lines={stacked ? 2 : 1} className={cx(fresh && 'retro-line-in')}>
      <ActorInspector
        projectId={actor.projectId}
        actorId={actor.id}
        label={`${projectName}, ${actor.label}`}
        trigger={
          <button
            type="button"
            tabIndex={-1}
            aria-label={`[${index}] ${actor.name}`}
            data-retro-item
            data-retro-key={index}
            data-scene-actor={actor.id}
            data-actor-state={actor.state}
            data-actor-kind={actor.kind}
            data-tone={actor.tone}
            className="retro-hit retro-actor"
            style={{ width: `${inner + 2}ch` } as CSSProperties}
          >
            <span aria-hidden className="retro-actor-line">
              {' '}
              <span className="retro-key">{key}</span> {KIND_GLYPH[actor.kind]}{' '}
              <Cell width={labelWidth} className="retro-bright" title={label}>
                {fit(label, labelWidth)}
              </Cell>{' '}
              {tag}
              {!stacked && (
                <>
                  {' '}
                  {columns.spark > 0 && (
                    <>
                      {actor.links.terminalId ? (
                        <Spark terminals={[actor.links.terminalId]} width={columns.spark} />
                      ) : (
                        <span className="retro-dim">{' '.repeat(columns.spark)}</span>
                      )}{' '}
                    </>
                  )}
                  {caption(columns.caption + 1)}
                </>
              )}{' '}
            </span>
            {stacked && (
              <span aria-hidden className="retro-actor-line">
                {' '.repeat(columns.num + 4)}
                {caption(inner - columns.num - 3)}{' '}
              </span>
            )}
          </button>
        }
      />
    </Sides>
  );
}
