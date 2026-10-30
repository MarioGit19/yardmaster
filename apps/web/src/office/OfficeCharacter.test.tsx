// @vitest-environment happy-dom
import { MotionGlobalConfig } from 'motion/react';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneActor } from '../layouts/scene.js';
import { motionPreference } from '../motion.js';
import { OfficeCharacter } from './OfficeCharacter.js';
import type { Placement } from './room.js';

vi.mock('../layouts/ActorInspector.js', () => ({
  ActorInspector: ({ trigger }: { trigger: ReactElement }) => trigger,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // Animations land at once: a walk shows up as its end position.
  MotionGlobalConfig.skipAnimations = true;
});

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  motionPreference.set('full');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  motionPreference.set('system');
});

const actor: SceneActor = {
  id: 't:zsh',
  kind: 'terminal',
  projectId: 'p-acme',
  parentId: null,
  state: 'idle',
  token: 'quiet',
  tone: 'idle',
  activity: 0,
  label: 'zsh',
  caption: { glyph: null, text: 'Idle', tone: 'rest' },
  name: 'acme-shop, zsh, idle',
  links: { href: '/', sessionId: null, terminalId: null, approvalId: null },
  since: 0,
  tool: null,
  toolSince: null,
  planning: false,
  ports: [],
  runningSince: null,
  exit: null,
};

const at = (x: number): Placement => ({
  actorId: actor.id,
  at: 'couch:0',
  x,
  y: 180,
  size: 40,
  front: false,
});

function render(x: number, held: boolean) {
  act(() =>
    root.render(
      <OfficeCharacter actor={actor} placement={at(x)} projectName="acme-shop" held={held} />,
    ),
  );
}

const left = () => {
  const el = container.querySelector<HTMLElement>('[data-office-actor]');
  return Number(/translateX\((-?[\d.]+)px\)/.exec(el?.style.transform ?? '')?.[1] ?? 0);
};

describe('OfficeCharacter', () => {
  it('waits to walk while held, then walks on when let go', async () => {
    render(100, false);
    expect(left()).toBe(80);
    // Its station moves while the pointer is on it: it stays put.
    render(200, true);
    await act(async () => {});
    expect(left()).toBe(80);
    // Let go: it walks to the new spot.
    render(200, false);
    await act(async () => {});
    expect(left()).toBe(180);
  });
});
