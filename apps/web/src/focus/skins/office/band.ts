import { actorRank, type SceneActor } from '../../../layouts/scene.js';

/** The header band seats at most this many characters (DESIGN.md §10.8, like a room's 8). */
export const BAND_CREW = 8;
/** The phone hub's app bar: up to 3 (§10.8 "Phones"). */
export const HUB_CREW = 3;

export interface BandCrew {
  shown: SceneActor[];
  /** Characters left out, for the "+N" by the door. */
  hidden: number;
}

/**
 * Who stands in the band: the project's sessions and terminals (subagents and background tasks
 * stay with their session). When there are more than `max`, the ones that need attention win;
 * the chosen keep a stable order (sessions, then terminals, oldest first), so a state change
 * never reshuffles the row.
 */
export function bandCrew(actors: readonly SceneActor[], max = BAND_CREW): BandCrew {
  const seated = actors.filter((a) => a.kind === 'claude' || a.kind === 'terminal');
  const stable = (a: SceneActor, b: SceneActor) =>
    Number(a.kind === 'terminal') - Number(b.kind === 'terminal') ||
    a.since - b.since ||
    a.id.localeCompare(b.id);
  const chosen = new Set(
    [...seated]
      .sort((a, b) => actorRank(b.state) - actorRank(a.state) || stable(a, b))
      .slice(0, max),
  );
  return {
    shown: seated.filter((a) => chosen.has(a)).sort(stable),
    hidden: Math.max(0, seated.length - max),
  };
}

/** What a click on a band character selects: its session (the route) or its terminal tab. */
export type BandSelection =
  | { kind: 'session'; href: string }
  | { kind: 'terminal'; terminalId: string };

export function bandSelection(actor: SceneActor): BandSelection | null {
  if (actor.kind === 'claude' && actor.links.sessionId) {
    return { kind: 'session', href: actor.links.href };
  }
  if (actor.kind === 'terminal' && actor.links.terminalId) {
    return { kind: 'terminal', terminalId: actor.links.terminalId };
  }
  return null;
}
