import './retro-skin.css';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { selectApproval, useBoard } from '../../../data/index.js';
import { sessionCaption } from '../../../pod/model.js';
import { NUMBER_WAIT_MS, pickNumber, projectTag } from '../../../retro/console.js';
import { routes } from '../../../routes.js';
import { isTypingTarget } from '../../../shell/railNav.js';
import { sessionStatusView, type Tone } from '../../../status.js';
import { FocusCaption } from '../../FocusCaption.js';
import type {
  EntryTransitionProps,
  HeaderBandProps,
  PanelFrameProps,
  WorkspaceSkin,
} from '../types.js';

/**
 * What the number shortcuts pick in the workspace (DESIGN.md §10.8): the session rows, then the
 * terminal tabs, in the order they're on screen. The numbers they show come from a CSS counter
 * over the same elements.
 */
export const KEY_TARGETS = 'a[data-session], [role="tab"][data-tab]';

/** Bands the entry reveals, top to bottom, like a console drawing its lines. */
export const ENTRY_BANDS = 12;

/**
 * Retro's header band: a console status line. `[ ESC ]` back, the project's name, its path and
 * branch, then the focused session's status as a tag with its live caption (and Allow / Deny when
 * it waits), the block cursor after it while Claude works.
 */
function RetroHeaderBand({ project, session, headingRef }: HeaderBandProps) {
  useNumberKeys(headingRef);
  const approvalId =
    session?.status.kind === 'waiting_permission' ? session.status.approvalId : null;
  const approval = useBoard(selectApproval(approvalId ?? ''));
  const status = session ? sessionStatusView(session.status) : null;
  const live = session !== null && session.status.kind !== 'ended';
  const caption = session && live ? sessionCaption(session, approval) : null;
  return (
    <header data-retro-band className="rs-band">
      <div className="rs-band-line">
        <Link href={routes.overview} aria-label="Back to the overview" className="rs-key">
          ESC
        </Link>
        <h1
          ref={headingRef}
          tabIndex={-1}
          title={project.name}
          className="rs-band-name truncate outline-none focus-visible:shadow-none"
        >
          {project.name}
        </h1>
        <p className="rs-dim min-w-0 flex-1 truncate" title={project.path}>
          {project.path}
        </p>
        {project.git?.branch && (
          <span data-chip className="min-w-0 max-w-60 truncate" title={project.git.branch}>
            {project.git.branch}
          </span>
        )}
      </div>
      <div className="rs-band-line" data-tone={status?.tone ?? 'idle'}>
        <span aria-hidden className="rs-dim">
          {'>'}
        </span>
        {status && (
          <span className="rs-tag shrink-0" data-tone={status.tone} title={status.label}>
            {projectTag(status.tone)}
          </span>
        )}
        {session && caption ? (
          <div className="flex min-w-0 flex-1 items-center">
            <div className="min-w-0">
              <FocusCaption session={session} />
            </div>
            {isWorking(status?.tone) && (
              <span aria-hidden className="retro-cursor shrink-0" data-blink>
                █
              </span>
            )}
          </div>
        ) : (
          <p className="rs-dim min-w-0 flex-1 truncate">
            {session ? 'SESSION ENDED. READY.' : 'READY.'}
          </p>
        )}
      </div>
    </header>
  );
}

const isWorking = (tone: Tone | undefined) => tone === 'work' || tone === 'tool';

/** A box-drawing frame around a panel, its name set into the top rule: `┌─ CLAUDE ──┐`. */
function RetroPanelFrame({ title, children }: PanelFrameProps) {
  return (
    <div className="rs-frame" data-retro-panel={title}>
      <span aria-hidden className="rs-frame-title">
        {title.toUpperCase()}
      </span>
      <div className="rs-frame-body">{children}</div>
    </div>
  );
}

/**
 * The frame's text "opens" into the workspace (§10.8): the card is drawn line by line from the top,
 * over `dur.base`, as each band of the dark screen lifts. Full only; the view cross-fades at
 * Reduced and appears at Off.
 */
function RetroEntry(_props: EntryTransitionProps) {
  const [done, setDone] = useState(false);
  if (done) return null;
  return (
    <div aria-hidden data-retro-entry className="rs-entry">
      {Array.from({ length: ENTRY_BANDS }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed bands
          key={i}
          style={{
            animationDelay: `calc((var(--dur-base) - var(--dur-fast)) * ${i / (ENTRY_BANDS - 1)})`,
          }}
          onAnimationEnd={i === ENTRY_BANDS - 1 ? () => setDone(true) : undefined}
        />
      ))}
    </div>
  );
}

/**
 * Number shortcuts (§10.6, §10.8): typing a row's or tab's number opens it, as on the overview;
 * "1" of 12 waits a moment for "12". Not while typing, and not while something covers the view.
 */
function useNumberKeys(headingRef: RefObject<HTMLElement | null>) {
  const buffer = useRef({ text: '', at: 0 });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!/^\d$/.test(event.key) || isTypingTarget(event.target)) return;
      const view = headingRef.current?.closest<HTMLElement>('.focus');
      if (!view || view.closest('[inert]')) return;
      const target = event.target as Node | null;
      if (target !== document.body && !(target && view.contains(target))) return;
      const targets = numberTargets(view);
      const state = buffer.current;
      const continues = state.text !== '' && event.timeStamp - state.at < NUMBER_WAIT_MS;
      let text = (continues ? state.text : '') + event.key;
      let pick = pickNumber(text, targets.length);
      if (pick.index === null && !pick.pending && text.length > 1) {
        text = event.key;
        pick = pickNumber(text, targets.length);
      }
      buffer.current = { text: pick.pending ? text : '', at: event.timeStamp };
      if (pick.index === null) return;
      event.preventDefault();
      const element = targets[pick.index];
      element?.focus();
      element?.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [headingRef]);
}

/** The shortcut targets on screen, numbered from 1 in document order. */
export function numberTargets(view: ParentNode): HTMLElement[] {
  return [...view.querySelectorAll<HTMLElement>(KEY_TARGETS)].filter(
    (el) => el.checkVisibility?.() ?? true,
  );
}

const retroSkin: WorkspaceSkin = {
  HeaderBand: RetroHeaderBand,
  PanelFrame: RetroPanelFrame,
  EntryTransition: RetroEntry,
};

export default retroSkin;
