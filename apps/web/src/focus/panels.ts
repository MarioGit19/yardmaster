import { createPreference } from '../prefs.js';

export const RAIL_STATES = ['open', 'closed'] as const;
/** The session list beside the chat: the full column, or a slim rail of its sessions. */
export const railPreference = createPreference('yardmaster.focus.rail', RAIL_STATES, 'open');

export const SIDE_PANELS = ['terminals', 'changes', 'closed'] as const;
export type SidePanelState = (typeof SIDE_PANELS)[number];
export type SideTab = Exclude<SidePanelState, 'closed'>;
/** What the side panel shows on this device, or that it is folded to its rail. */
export const sidePanelPreference = createPreference(
  'yardmaster.focus.panel',
  SIDE_PANELS,
  'terminals',
);

/** The tab a side panel shows; a closed one keeps its terminals mounted behind the rail. */
export const sideTab = (state: SidePanelState): SideTab =>
  state === 'closed' ? 'terminals' : state;
