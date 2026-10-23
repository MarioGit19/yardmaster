// The `--demo-stress` board (PLAN 10.1, PRD §9): the demo projects scaled up to the performance
// target. Every name and log line here is made up.

import {
  ansi,
  clock,
  DEMO_HOME,
  DEMO_PROJECTS,
  type DemoProject,
  type DemoTerminal,
} from './content.js';
import type { Rng } from './rng.js';

const { dim, green, yellow, red, cyan } = ansi;

export const STRESS_PROJECTS = 10;
/** `--demo-projects` bounds: a bigger board for layout density checks (Retro fits 20). */
export const STRESS_PROJECTS_MAX = 40;
export const STRESS_TERMINALS_PER_PROJECT = 6;
/** Lines per second for each of the two log firehoses. */
export const STRESS_LINES_PER_SECOND = 200;
/** Projects (the first ones) that run a fast Claude session. */
export const STRESS_SESSIONS = 4;
/** Tool calls per second for each stress session. */
export const STRESS_TOOLS_PER_SECOND = 5;

const EXTRA_NAMES = [
  'lumen-docs',
  'harbor-ci',
  'quill-notes',
  'tidal-maps',
  'ember-chat',
  'cobalt-forms',
  'marble-auth',
  'nimbus-queue',
  'sable-mail',
  'willow-cms',
  'copper-pay',
  'drift-metrics',
  'fable-store',
  'garnet-sync',
  'hollow-cli',
];

/**
 * `count` projects (10 by default) × 6 terminals: 2 log firehoses, 4 fast Claude sessions, the
 * rest the usual mix. A bigger board only adds more of the usual mix.
 */
export function stressProjects(count = STRESS_PROJECTS): DemoProject[] {
  const bases = DEMO_PROJECTS.filter((p) => p.scenarios.length > 0);
  return Array.from({ length: count }, (_, index) => {
    const base = bases[index % bases.length] as DemoProject;
    const name =
      index < bases.length ? base.name : (EXTRA_NAMES[index - bases.length] ?? `project-${index}`);
    const terminals: DemoTerminal[] = [
      index < 2
        ? { kind: 'shell', name: 'logs', linesPerSecond: STRESS_LINES_PER_SECOND }
        : { kind: 'vite', name: 'dev', port: 5200 + index },
      { kind: 'jest', name: 'tests' },
      { kind: 'shell', name: 'zsh' },
      { kind: 'shell', name: 'git', quiet: true },
      { kind: 'shell', name: 'scratch', quiet: true },
      index < STRESS_SESSIONS
        ? { kind: 'claude', name: 'claude' }
        : { kind: 'shell', name: 'zsh 2' },
    ];
    // Only the regular demo has an interrupted board session.
    return {
      ...base,
      interrupted: undefined,
      name,
      path: `${DEMO_HOME}/${name}`,
      window: index % 4,
      terminals: terminals.slice(0, STRESS_TERMINALS_PER_PROJECT),
    };
  });
}

const PATHS = [
  '/v1/orbits',
  '/v1/cart',
  '/healthz',
  '/v1/search?q=mug',
  '/static/app.js',
  '/v1/auth',
];

/** `count` lines of a synthetic access log. */
export function firehoseLines(rng: Rng, ts: number, count: number): string {
  let out = '';
  for (let i = 0; i < count; i++) {
    const code = rng.chance(0.03) ? 500 : rng.chance(0.08) ? 404 : 200;
    const color = code >= 500 ? red : code >= 400 ? yellow : green;
    out += `${dim(clock(ts))} ${cyan('GET')} ${rng.pick(PATHS)} ${color(String(code))} ${rng.int(1, 240)}ms\r\n`;
  }
  return out;
}
