import type { ClaudeSession, Project, SessionStatus } from '@yardmaster/protocol';
import type { ComponentType, ReactNode, RefObject } from 'react';
import type { CrewView } from '../../pod/SessionCrew.js';
import type { Tone } from '../../status.js';

/** What the focus view hands its header band: the same facts in every skin. */
export interface HeaderBandProps {
  project: Project;
  /** The session in the Claude column; null while composing a new one or with none. */
  session: ClaudeSession | null;
  /** The Claude column holds a blank composer for a new session. */
  composing: boolean;
  accent: string;
  crew: CrewView;
  now: number;
  /** The project name's heading, focused when the view opens. */
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** Taking part in the pod morph (Minimal only). */
  shared: boolean;
}

export interface PanelFrameProps {
  /** The panel's name, as its column or tab is labelled. */
  title: string;
  /** Activity keys (`activityKey.*`) of what the panel shows, for frames that light with work. */
  activity: readonly string[];
  /** The panel's own status when it needs attention (waiting, failed), else undefined. */
  tone?: Tone;
  children: ReactNode;
}

export interface HubCrewProps {
  projectId: string;
}

/** What a status reads as, for skins that word it their own way (Transit's departures board). */
export type StatusWordInput =
  | { kind: 'session'; status: SessionStatus }
  | { kind: 'terminal'; running: boolean; exit: number | null; closed: boolean };

export interface EntryTransitionProps {
  projectId: string;
}

/**
 * A layout's workspace skin (DESIGN.md §10.8): its CSS (a token override scoped to
 * `[data-layout="…"].focus`, shipped with the skin's chunk) and a few slots the focus view renders
 * by layout. Everything else in the workspace is the same component in every skin.
 */
export interface WorkspaceSkin {
  /** The desktop header: back, the project's name, its live state. */
  HeaderBand: ComponentType<HeaderBandProps>;
  /** Wraps each column's content (or tab panel). Null: the column as it is. */
  PanelFrame: ComponentType<PanelFrameProps> | null;
  /**
   * Plays over the card when it opens from this layout's overview at motion Full, instead of the
   * cross-fade. Null: the standard entry (the pod morph, or the cross-fade).
   */
  EntryTransition: ComponentType<EntryTransitionProps> | null;
  /** Beside the project's name in the phone hub's app bar (Office's crew), when the skin has one. */
  HubCrew?: ComponentType<HubCrewProps>;
  /**
   * The words a session row or a hub card shows for its status, when the skin has its own. The
   * tone (color and mark) never changes, only the words.
   */
  statusWord?: (input: StatusWordInput) => string;
}
