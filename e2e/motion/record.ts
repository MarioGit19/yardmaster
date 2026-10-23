/**
 * `pnpm motion:record [scenario] [--reduced] [--no-ffmpeg]`: records a scripted walkthrough of the demo
 * board at motion Full and turns each moment into a contact sheet in `artifacts/motion/`.
 * See `README.md` next to this file for how to read the sheets.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type Browser, type BrowserContextOptions, chromium, type Page } from '@playwright/test';
import { startBoard } from '../board.js';
import { signedInState } from '../fixtures.js';

const run = promisify(execFile);
const OUT_DIR = fileURLToPath(new URL('../../artifacts/motion/', import.meta.url));
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
/** The video starts a beat before our clock does: open each window early, close it just late. */
const LEAD_S = 0.3;
const TAIL_S = 0.1;
const MAX_TILES = 60;

type Kind = 'transition' | 'activity';
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Moment {
  name: string;
  kind: Kind;
  note: string;
  start: number;
  end: number;
  clip?: Box;
}

const FPS: Record<Kind, number> = { transition: 12, activity: 2 };

class Recorder {
  readonly moments: Moment[] = [];
  private readonly t0 = performance.now();

  constructor(
    readonly page: Page,
    private readonly scenario: string,
    private readonly ffmpeg: boolean,
  ) {}

  private now(): number {
    return (performance.now() - this.t0) / 1000;
  }

  /**
   * Runs `action` and records its time window as one moment. Without ffmpeg, screenshots are
   * taken in a burst while it runs (as fast as they come for transitions, every 500 ms for
   * activity).
   */
  async moment(
    name: string,
    kind: Kind,
    note: string,
    action: () => Promise<void>,
    clip?: Box,
  ): Promise<void> {
    const start = this.now();
    let done = false;
    const burst = this.ffmpeg ? Promise.resolve() : this.burst(name, kind, () => done, clip);
    try {
      await action();
    } finally {
      done = true;
      await burst;
    }
    this.moments.push({ name, kind, note, start, end: this.now(), clip });
  }

  private async burst(name: string, kind: Kind, done: () => boolean, clip?: Box) {
    const every = kind === 'transition' ? 0 : 500;
    for (let i = 0; i < MAX_TILES && !done(); i++) {
      const file = `${this.scenario}-${name}-${String(i).padStart(2, '0')}.png`;
      await this.page.screenshot({ path: join(OUT_DIR, file), clip }).catch(() => {});
      if (every) await this.page.waitForTimeout(every);
    }
  }
}

const hold = (page: Page, ms: number) => () => page.waitForTimeout(ms);

/**
 * Waits up to `timeout` for `selector` (something the demo does on its own timing), then records
 * `ms` around it, reaching back `leadMs` to the start of what was detected. Warns and skips when
 * the demo doesn't get there in time.
 */
async function catchMoment(
  r: Recorder,
  name: string,
  note: string,
  selector: string,
  {
    timeout = 45_000,
    ms = 1200,
    leadMs = 500,
    clip,
  }: {
    timeout?: number;
    ms?: number;
    leadMs?: number;
    clip?: Box;
  } = {},
): Promise<boolean> {
  const seen = await r.page
    .locator(selector)
    .first()
    .waitFor({ state: 'attached', timeout })
    .then(
      () => true,
      () => false,
    );
  if (!seen) {
    console.warn(
      `motion:record: ${selector} did not show within ${timeout / 1000} s; skipping ${name}`,
    );
    return false;
  }
  const index = r.moments.length;
  await r.moment(name, 'transition', note, hold(r.page, ms), clip);
  const m = r.moments[index];
  if (m) m.start = Math.max(0, m.start - leadMs / 1000);
  return true;
}

/** Opens the overview and waits for the first pod, the way the e2e suite does. */
async function openOverview(page: Page, route = '/') {
  await page.goto(`/#${route}`);
  await page.locator('a[href^="#/p/"], [data-pod]').first().waitFor();
}

const SCENARIOS = {
  async overview(r: Recorder) {
    const { page } = r;
    await r.moment('entrance', 'transition', 'first paint and the board entrance', async () => {
      await openOverview(page);
      await page.waitForTimeout(2200);
    });
    await r.moment('activity', 'activity', '8 s of live activity', hold(page, 8000));
    await r.moment('pod-hover', 'transition', 'pointer onto the first pod and off', async () => {
      await page.locator('[data-pod]').first().hover();
      await page.waitForTimeout(900);
      await page.mouse.move(4, DESKTOP.height - 4);
      await page.waitForTimeout(600);
    });
    const lane = page.locator('[data-lane][data-streaming], [data-lane]').first();
    await lane.waitFor();
    await r.moment(
      'lane-peek',
      'transition',
      'hover a lane: the peek opens, then closes',
      async () => {
        await lane.locator('[aria-expanded]').first().hover();
        await page.locator('[data-peek]').waitFor({ timeout: 5000 });
        await page.waitForTimeout(900);
        await page.mouse.move(4, 4);
        await page.waitForTimeout(700);
      },
    );
    await r.moment('route', 'transition', 'overview → settings → overview cross-fade', async () => {
      await page.goto('/#/settings');
      await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
      await page.waitForTimeout(600);
      await page.goto('/#/');
      await page.locator('[data-pod]').first().waitFor();
      await page.waitForTimeout(600);
    });
  },

  /** A fresh board's first attention change reorders the pods within seconds. */
  async reorder(r: Recorder) {
    await openOverview(r.page);
    await catchMoment(
      r,
      'pods',
      'attention reorders the pods: the riser flies over the others',
      '[data-pod-slot][data-rising]',
      { ms: 900, leadMs: 300 },
    );
  },

  /** The stress board: compare with `overview-activity` for how much louder a busy board reads. */
  async busy(r: Recorder) {
    const { page } = r;
    await openOverview(page);
    await page.waitForTimeout(2500);
    await r.moment(
      'activity',
      'activity',
      '8 s of the stress board at full tilt',
      hold(page, 8000),
    );
  },

  async focus(r: Recorder) {
    const { page } = r;
    await openOverview(page);
    await page.waitForTimeout(1500);
    // A pod with two sessions, so the switch between them can be recorded.
    const pods = page.locator('[data-pod]');
    const pair = pods.filter({ has: page.locator('li[data-session] + li[data-session]') });
    const id = await ((await pair.count()) > 0 ? pair : pods).first().getAttribute('data-pod');
    if (!id) throw new Error('no pod on the overview');
    await r.moment('open', 'transition', 'pod morphs into the focus view', async () => {
      await page.locator(`[data-pod="${id}"] header a`).click();
      await page.locator(`[data-focus="${id}"]`).waitFor();
      await page.waitForTimeout(1200);
    });
    const rows = page.locator(`[data-focus="${id}"] a[data-session]`);
    if ((await rows.count()) > 1) {
      await r.moment(
        'session-switch',
        'transition',
        'pick another session: the pill slides, the transcript cross-fades',
        async () => {
          await rows.nth(1).click();
          await page.waitForTimeout(1000);
          await rows.nth(0).click();
          await page.waitForTimeout(1000);
        },
      );
    } else {
      console.warn('motion:record: one session in the focused pod; skipping focus-session-switch');
    }
    const center = await page
      .locator(`[data-focus="${id}"] section[aria-label="Claude"]`)
      .boundingBox();
    await catchMoment(
      r,
      'tool-finish',
      'a running tool card finishes (check pop or glitch)',
      `[data-focus="${id}"] [data-tool][data-state="running"]`,
      { ms: 4000, leadMs: 200, ...(center ? { clip: visible(center, DESKTOP) } : {}) },
    );
    await catchMoment(
      r,
      'done',
      'the focused session finishes its turn: header sweep and the crew’s done',
      `[data-focus="${id}"] header [data-done-sweep]`,
      { ms: 1200, leadMs: 300 },
    );
    const stack = page.locator(`[data-focus="${id}"] [data-terminal-stack]`);
    const stackBox = await stack.boundingBox();
    const stackClip = stackBox ? visible(stackBox, DESKTOP) : undefined;
    const claudeTab = stack.locator('[data-claude-tab]').first();
    if ((await claudeTab.count()) > 0) {
      await r.moment(
        'claude-tab',
        'transition',
        "pick the Claude terminal's tab: the tab pill glides, its chat fades in the stack (or points to the Claude column)",
        async () => {
          await claudeTab.click();
          await page.waitForTimeout(900);
        },
        stackClip,
      );
      await r.moment(
        'claude-raw',
        'transition',
        'chat → raw terminal → chat: the pane cross-fades (dur.base in, dur.fast out)',
        async () => {
          await stack.getByRole('button', { name: 'Raw terminal' }).click();
          await page.waitForTimeout(700);
          await stack.getByRole('button', { name: 'Chat' }).click();
          await page.waitForTimeout(700);
        },
        stackClip,
      );
    } else {
      console.warn('motion:record: no Claude terminal in the focused pod; skipping claude-tab');
    }
    await r.moment(
      'new-terminal',
      'transition',
      'New terminal: the popover scales in, a chip opens one, its tab rises in and is selected',
      async () => {
        await stack.getByRole('button', { name: 'New terminal' }).click();
        await page.locator('[data-new-terminal-popover]').waitFor();
        await page.waitForTimeout(500);
        await page.locator('[data-new-terminal-popover] [data-command-chip]').last().click();
        await page.waitForTimeout(1400);
      },
      stackClip,
    );
    await r.moment('close', 'transition', 'Esc morphs it back into the pod', async () => {
      await page.keyboard.press('Escape');
      await page.locator(`[data-focus="${id}"]`).waitFor({ state: 'detached' });
      await page.waitForTimeout(900);
    });
  },

  async chrome(r: Recorder) {
    const { page } = r;
    await openOverview(page);
    await page.waitForTimeout(1200);
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await r.moment(
      'palette-open',
      'transition',
      '⌘K opens the palette, typing filters',
      async () => {
        await page.keyboard.press('ControlOrMeta+K');
        await palette.waitFor();
        await page.waitForTimeout(500);
        await page.keyboard.type('orb', { delay: 90 });
        await page.waitForTimeout(600);
      },
    );
    await r.moment('palette-close', 'transition', 'Esc closes the palette', async () => {
      await page.keyboard.press('Escape');
      await palette.waitFor({ state: 'hidden' });
      await page.waitForTimeout(500);
    });

    // The demo raises its first toast (a failed run or a permission request) within seconds.
    const toast = page.locator('[data-sonner-toast]').first();
    const arrived = await toast.waitFor({ timeout: 30_000 }).then(
      () => true,
      () => false,
    );
    if (arrived) {
      const seen = r.moments.length;
      await r.moment('toast', 'transition', 'the first toast arrives', hold(page, 1200));
      // Reach back to the arrival: the toast was already entering when it was detected.
      const m = r.moments[seen];
      if (m) m.start = Math.max(0, m.start - 0.6);
    } else {
      console.warn('motion:record: no toast within 30 s; skipping chrome-toast');
    }

    // Wait for a permission request, so the sheet has a card to allow and deny.
    await page
      .locator('[data-attention-live]', { hasText: 'Approval needed' })
      .waitFor({ state: 'attached', timeout: 30_000 })
      .catch(() => {});
    const sheet = page.getByRole('complementary', { name: /Needs you/ });
    await r.moment('attention-open', 'transition', 'the Attention Center slides in', async () => {
      const review = toast.getByRole('button', { name: 'Review' });
      if (arrived && (await review.isVisible())) await review.click();
      else await page.locator('[data-hud="waiting"]').click();
      await sheet.waitFor();
      await page.waitForTimeout(900);
    });
    const card = sheet.locator('article[data-approval]:not([data-resolved])').first();
    if (await card.isVisible()) {
      const box = await sheet.boundingBox();
      const clip = box ? visible(box, DESKTOP) : undefined;
      await r.moment(
        'approval-allow',
        'transition',
        'Allow: outcome slides in, check draws, the card collapses and leaves',
        async () => {
          await card.getByRole('button', { name: /^Allow/ }).click();
          await page.waitForTimeout(1600);
        },
        clip,
      );
      const next = sheet.locator('article[data-approval]:not([data-resolved])').first();
      if (await next.isVisible()) {
        await r.moment(
          'approval-deny',
          'transition',
          'Deny: the outcome slides in, then a short fade',
          async () => {
            await next.getByRole('button', { name: /^Deny/ }).click();
            await next.getByRole('button', { name: 'Deny', exact: true }).click();
            await page.waitForTimeout(1100);
          },
          clip,
        );
      }
    } else {
      console.warn('motion:record: no approval in the Attention Center; skipping approvals');
    }
    await r.moment('attention-close', 'transition', 'Esc closes the Attention Center', async () => {
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'hidden' });
      await page.waitForTimeout(500);
    });

    const rail = page.locator('[data-pulse]');
    const toggle = rail.getByRole('button', { name: /Pulse/ });
    if ((await rail.getAttribute('data-pulse')) === 'expanded') {
      await toggle.click();
      await page.waitForTimeout(800);
    }
    await r.moment('pulse-expand', 'transition', 'the Pulse rail expands', async () => {
      await toggle.click();
      await page.locator('[data-pulse="expanded"]').waitFor();
      await page.waitForTimeout(1000);
    });
    await r.moment('pulse-collapse', 'transition', 'the Pulse rail collapses', async () => {
      await toggle.click();
      await page.locator('[data-pulse="collapsed"]').waitFor();
      await page.waitForTimeout(700);
    });
  },

  async crew(r: Recorder) {
    const { page } = r;
    await page.goto('/#/_tokens');
    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'Crew mascot' }),
    });
    await section.scrollIntoViewIfNeeded();
    await section.locator('[data-crew]').nth(35).waitFor();
    await page.waitForTimeout(800);
    const box = await section.boundingBox();
    const clip = box ? visible(box, DESKTOP) : undefined;
    await r.moment('loop', 'transition', 'every state, 2 s up close', hold(page, 2000), clip);
    await r.moment('idle', 'activity', 'every state, 10 s of idle life', hold(page, 10_000), clip);
  },

  async fx(r: Recorder) {
    const { page } = r;
    await page.goto('/#/_tokens');
    const section = (name: string) =>
      page.locator('section', { has: page.getByRole('heading', { name }) });
    const clipOf = async (name: string) => {
      const box = await section(name).boundingBox();
      return box ? visible(box, DESKTOP) : undefined;
    };

    const text = section('Text effects');
    await text.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    let clip = await clipOf('Text effects');
    await r.moment(
      'text',
      'transition',
      'a caption resolves, an error glitches, a status board flips',
      async () => {
        await text.getByRole('button', { name: 'Next caption' }).click();
        await page.waitForTimeout(600);
        await text.getByRole('button', { name: 'Raise an error' }).click();
        await page.waitForTimeout(500);
        await text.getByRole('button', { name: 'Next status' }).click();
        await page.waitForTimeout(900);
      },
      clip,
    );

    const backgrounds = section('Backgrounds');
    await backgrounds.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    clip = await clipOf('Backgrounds');
    const pick = (name: string) => backgrounds.getByRole('button', { name, exact: true }).click();
    const energy = backgrounds.getByLabel('Effect energy');
    for (const [name, note] of [
      ['DarkVeil', 'the Veil field, energy 0.1 → 1'],
      ['SoftAurora', 'the Aurora field, energy 0.1 → 1'],
      ['FaultyTerminal', 'the Retro backdrop, energy 0.1 → 1'],
    ] as const) {
      await pick(name);
      await energy.fill('0.1');
      await page.waitForTimeout(800);
      await r.moment(
        name.toLowerCase(),
        'activity',
        note,
        async () => {
          await page.waitForTimeout(3000);
          await energy.fill('1');
          await page.waitForTimeout(4000);
        },
        clip,
      );
    }
    await pick('RippleGrid');
    await energy.fill('0.5');
    await page.waitForTimeout(800);
    await r.moment(
      'ripplegrid',
      'transition',
      'two ripples cross the Grid floor',
      async () => {
        await backgrounds.getByRole('button', { name: 'Ripple', exact: true }).click();
        await page.waitForTimeout(500);
        await backgrounds.getByRole('button', { name: 'Ripple', exact: true }).click();
        await page.waitForTimeout(1600);
      },
      clip,
    );
    await pick('LightTunnel');
    await page.waitForTimeout(800);
    await r.moment(
      'lighttunnel',
      'transition',
      'a dive (900 ms) and a surge down the tunnel',
      async () => {
        await backgrounds.getByRole('button', { name: 'Dive', exact: true }).click();
        await page.waitForTimeout(1500);
        await backgrounds.getByRole('button', { name: 'Surge', exact: true }).click();
        await page.waitForTimeout(1200);
      },
      clip,
    );

    const phone = section('Phone interactions');
    await phone.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    clip = await clipOf('Phone interactions');
    await r.moment(
      'phone',
      'transition',
      'a short swipe springs back, a long one allows; a hold completes',
      async () => {
        const card = await phone.getByText('pnpm db:migrate').boundingBox();
        if (card) {
          const y = card.y + card.height / 2;
          await page.mouse.move(card.x + 10, y);
          await page.mouse.down();
          await page.mouse.move(card.x + 80, y, { steps: 10 });
          await page.mouse.up();
          await page.waitForTimeout(500);
          await page.mouse.down();
          await page.mouse.move(card.x + 280, y, { steps: 14 });
          await page.mouse.up();
          await page.waitForTimeout(700);
        }
        await phone.getByRole('button', { name: /Hold to stop/ }).hover();
        await page.mouse.down();
        await page.waitForTimeout(1500);
        await page.mouse.up();
        await page.waitForTimeout(500);
      },
      clip,
    );
  },

  async phone(r: Recorder) {
    const { page } = r;
    await r.moment('entrance', 'transition', 'first paint and the entrance at 390 px', async () => {
      await openOverview(page);
      await page.waitForTimeout(2000);
    });
    await r.moment('scroll', 'transition', 'a flick down the overview and back', async () => {
      await page.evaluate(() => window.scrollBy({ top: 600, behavior: 'smooth' }));
      await page.waitForTimeout(900);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await page.waitForTimeout(900);
    });
    const id = await page.locator('[data-pod]').first().getAttribute('data-pod');
    if (!id) throw new Error('no pod on the overview');
    await r.moment('focus-open', 'transition', 'tap a pod: the focus view opens', async () => {
      await page.locator(`[data-pod="${id}"] header a`).tap();
      await page.locator(`[data-focus="${id}"]`).waitFor();
      await page.waitForTimeout(1200);
    });
    await r.moment('focus-close', 'transition', 'back: the focus view closes', async () => {
      await page.goBack();
      await page.locator(`[data-focus="${id}"]`).waitFor({ state: 'detached' });
      await page.waitForTimeout(900);
    });
  },
} satisfies Record<string, (r: Recorder) => Promise<void>>;

type Scenario = keyof typeof SCENARIOS;
const NAMES = Object.keys(SCENARIOS) as Scenario[];
/** Scenarios that run on `--demo-stress` instead of `--demo`. */
const STRESS = new Set<Scenario>(['busy']);

/** `box` cut to the viewport, rounded to even pixels for the video encoder. */
function visible(box: Box, viewport: { width: number; height: number }): Box {
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  return {
    x,
    y,
    width: even(Math.min(box.width, viewport.width - x)),
    height: even(Math.min(box.height, viewport.height - y)),
  };
}

async function hasFfmpeg(): Promise<boolean> {
  try {
    await run('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/** Tiles the frames of one moment into a single PNG, in reading order. */
async function contactSheet(video: string, out: string, m: Moment, phone: boolean) {
  const start = Math.max(0, m.start - LEAD_S);
  const duration = m.end - start + TAIL_S;
  const fps = Math.min(FPS[m.kind], MAX_TILES / duration);
  const frames = Math.max(1, Math.ceil(duration * fps));
  const cols = Math.min(frames, phone ? 8 : 4);
  const rows = Math.ceil(frames / cols);
  const width = m.clip
    ? Math.min(m.clip.width, 480)
    : phone
      ? 240
      : m.kind === 'transition'
        ? 480
        : 360;
  const filters = [
    m.clip && `crop=${m.clip.width}:${m.clip.height}:${m.clip.x}:${m.clip.y}`,
    `fps=${fps.toFixed(3)}`,
    `scale=${width}:-2`,
    `tile=${cols}x${rows}:padding=6:margin=6:color=0x202024`,
  ].filter(Boolean);
  await run('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-ss',
    start.toFixed(2),
    '-t',
    duration.toFixed(2),
    '-i',
    video,
    '-vf',
    filters.join(','),
    '-frames:v',
    '1',
    out,
  ]);
  return { fps };
}

async function record(browser: Browser, scenario: Scenario, ffmpeg: boolean, reduced: boolean) {
  // Reduced runs write `<scenario>-reduced-*`, so a Full run keeps them and vice versa.
  const tag = reduced ? `${scenario}-reduced` : scenario;
  for (const file of await readdir(OUT_DIR)) {
    const ours = file.startsWith(`${tag}-`) || file === `${tag}.webm`;
    if (ours && (reduced || !file.startsWith(`${scenario}-reduced`))) {
      await rm(join(OUT_DIR, file));
    }
  }
  const phone = scenario === 'phone';
  const viewport = phone ? PHONE : DESKTOP;
  const board = await startBoard({ demo: true, stress: STRESS.has(scenario) });
  const videoDir = join(board.home, 'video');
  const options: BrowserContextOptions = {
    baseURL: board.url,
    storageState: signedInState(board.url, board.cookie),
    viewport,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    ...(ffmpeg ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
  };
  try {
    const context = await browser.newContext(options);
    await context.addInitScript(
      (level) => {
        localStorage.setItem('cboard.theme', 'dark');
        localStorage.setItem('cboard.motion', level);
      },
      reduced ? 'reduced' : 'full',
    );
    const page = await context.newPage();
    const recorder = new Recorder(page, tag, ffmpeg);
    try {
      await SCENARIOS[scenario](recorder);
    } finally {
      await context.close();
    }

    console.log(`\n${tag}`);
    if (!ffmpeg) {
      for (const m of recorder.moments) {
        console.log(`  ${tag}-${m.name}-NN.png  ${m.note}`);
      }
      return;
    }
    const webm = join(OUT_DIR, `${tag}.webm`);
    await page.video()?.saveAs(webm);
    for (const m of recorder.moments) {
      const file = `${tag}-${m.name}.png`;
      const { fps } = await contactSheet(webm, join(OUT_DIR, file), m, phone);
      const span = `${m.start.toFixed(1)}–${m.end.toFixed(1)} s`;
      console.log(`  ${file.padEnd(32)} ${span.padEnd(13)} ${fps.toFixed(1)} fps  ${m.note}`);
    }
    console.log(`  ${`${tag}.webm`.padEnd(32)} the full recording`);
  } finally {
    await board.stop();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const wanted = args.find((a) => !a.startsWith('--')) ?? 'all';
  if (wanted !== 'all' && !NAMES.includes(wanted as Scenario)) {
    console.error(`Unknown scenario "${wanted}". Use one of: ${[...NAMES, 'all'].join(', ')}`);
    process.exit(2);
  }
  const scenarios = wanted === 'all' ? NAMES : [wanted as Scenario];
  const ffmpeg = !args.includes('--no-ffmpeg') && (await hasFfmpeg());
  const reduced = args.includes('--reduced');
  if (!ffmpeg) console.warn('motion:record: ffmpeg not found; taking screenshot bursts instead');
  await mkdir(OUT_DIR, { recursive: true });

  // Full Chromium (new headless) renders with the GPU, like the perf-stress project.
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    for (const scenario of scenarios) await record(browser, scenario, ffmpeg, reduced);
  } finally {
    await browser.close();
  }
  console.log(`\nSheets in artifacts/motion/ (see e2e/motion/README.md).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
