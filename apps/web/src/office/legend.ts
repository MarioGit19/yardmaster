import type { LegendLines } from '../layouts/StatusLegend.js';

/** The building's legend: how a character acts out each status token (DESIGN.md §10.3). */
export const OFFICE_LEGEND: LegendLines = {
  needs_you: 'hand up, amber door light',
  failed: 'worried, rose exit badge',
  running: 'working at a station',
  stale: 'stopped, standing idle',
  done_unseen: 'green check',
  quiet: 'at rest',
};
