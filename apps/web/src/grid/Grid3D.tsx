import { type RefObject, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { OffstageContext } from '../anim/useFrame.js';
import { useBoardStore } from '../data/index.js';
import type { SceneProject } from '../layouts/scene.js';
import { useTheme } from '../theme/theme.js';
import { FlatCockpit } from './FlatCockpit.js';
import { GridNode } from './GridNode.js';
import { type DiveState, GridRenderer, readPalette } from './GridRenderer.js';

/** The 3D stage never gets shorter than this; a shorter window scrolls. */
const MIN_HEIGHT = 460;
/** The page's bottom padding, kept below the stage. */
const PAGE_BOTTOM = 24;

export interface Grid3DProps {
  projects: readonly SceneProject[];
  /** The node the camera dives into (its cockpit shows once it's there), or none. */
  entered: SceneProject | undefined;
  now: number;
  onEnter(projectId: string): void;
  /** The cockpit's Back button: the layout steps out, and the camera rises back to its orbit. */
  onBack(): void;
  /** WebGL is unavailable or its context was lost: the layout shows the 2D map. */
  onLost(): void;
}

/**
 * The Grid's 3D overview (DESIGN.md §10.4): `GridRenderer` draws the network on one WebGL canvas,
 * and each node's label is a DOM card the renderer floats above its monolith, with the node's
 * satellite buttons placed over the 3D satellites. So text stays crisp, every node and actor is
 * a real focusable element, and a click on a satellite opens the Actor inspector right there.
 * This chunk carries `three`; the layout loads it only when the 3D view is shown.
 */
export default function Grid3D({ projects, entered, now, onEnter, onBack, onLost }: Grid3DProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLUListElement>(null);
  const rendererRef = useRef<GridRenderer | null>(null);
  const [ready, setReady] = useState(false);
  const store = useBoardStore();
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const offstage = useContext(OffstageContext);
  const height = useStageHeight(stageRef);
  const handlers = useRef({ onEnter, onLost });
  handlers.current = { onEnter, onLost };
  const dive = useDive(rendererRef, ready, entered?.id ?? null);
  const shown = entered && entered.id === dive.arrivedId ? entered : undefined;
  const touch = useRef(window.matchMedia?.('(pointer: coarse)').matches ?? false).current;

  useEffect(() => {
    const stage = stageRef.current;
    const labels = labelsRef.current;
    if (!stage || !labels) return;
    const renderer = GridRenderer.create(
      {
        stage,
        labels,
        getPulses: () => store.getState().pulses,
        subscribe: (listener) => store.subscribe(listener),
        touch: window.matchMedia?.('(pointer: coarse)').matches ?? false,
        onEnter: (id) => handlers.current.onEnter(id),
        onLost: () => handlers.current.onLost(),
      },
      readPalette(themeRef.current),
    );
    if (!renderer) {
      handlers.current.onLost();
      return;
    }
    rendererRef.current = renderer;
    setReady(true);
    return () => {
      rendererRef.current = null;
      renderer.dispose();
    };
  }, [store]);

  // After React has committed the labels, so the renderer finds every one of them.
  useEffect(() => {
    if (ready) rendererRef.current?.setScene(projects);
  }, [projects, ready]);

  // The theme's tokens are on the root once its effect has run: read them on the next frame.
  useEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(() => rendererRef.current?.setPalette(readPalette(theme)));
    return () => cancelAnimationFrame(frame);
  }, [theme, ready]);

  useEffect(() => {
    if (ready) rendererRef.current?.setPaused(offstage);
  }, [offstage, ready]);

  return (
    <div
      ref={stageRef}
      data-grid-3d
      data-ready={ready || undefined}
      data-grid-dive={dive.state}
      className="grid-stage relative w-full overflow-hidden"
      style={{ height: height || MIN_HEIGHT }}
    >
      <div aria-hidden className="grid-floor-scan pointer-events-none absolute inset-0" />
      <span
        role="img"
        aria-label={`You, ${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`}
        data-grid-core
        className="sr-only"
      />
      <ul
        ref={labelsRef}
        aria-label="Projects"
        inert={dive.state !== 'out' ? true : undefined}
        className="grid-labels pointer-events-none absolute inset-0"
      >
        {projects.map((project) => (
          <li
            key={project.id}
            data-grid-label={project.id}
            data-scene-leaving={project.leaving}
            inert={project.leaving}
            className="grid-float"
          >
            <GridNode
              project={project}
              variant="float"
              onEnter={() => onEnter(project.id)}
              onHover={(on) => rendererRef.current?.setHot(on ? project.id : null)}
            />
          </li>
        ))}
      </ul>
      {shown && (
        <div data-grid-deck className="grid-deck absolute inset-0 overflow-y-auto">
          {/* The phase-in's scanline: one sweep down the view as the screens resolve. */}
          <div aria-hidden className="grid-phase-scan pointer-events-none absolute inset-0" />
          <div className="relative px-4 py-4 md:px-6">
            <FlatCockpit
              key={shown.id}
              project={shown}
              now={now}
              narrow={touch}
              deep
              onBack={onBack}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The dive's steps for the stage: the renderer flies the camera into the entered node, then the
 * cockpit phases in; leaving hides the cockpit and flies back out, and focus lands on the node.
 */
function useDive(
  rendererRef: RefObject<GridRenderer | null>,
  ready: boolean,
  enteredId: string | null,
) {
  const [state, setState] = useState<DiveState>('out');
  // The project whose cockpit is up (kept by id; its data is read fresh from the scene).
  const [arrivedId, setArrivedId] = useState<string | null>(null);
  const projects = useRef<string | null>(null);
  projects.current = enteredId;
  const last = useRef<string | null>(null);
  if (enteredId) last.current = enteredId;

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!ready || !renderer) return;
    if (enteredId) {
      setArrivedId(null);
      const flying = renderer.dive(enteredId, () => {
        if (projects.current !== enteredId) return;
        setState('in');
        setArrivedId(enteredId);
      });
      if (!flying) {
        setState('in');
        setArrivedId(enteredId);
        return;
      }
      setState(renderer.diveState());
      return;
    }
    setArrivedId(null);
    if (renderer.diveState() === 'out') return;
    const id = last.current;
    setState('rising');
    renderer.rise(() => {
      setState('out');
      // Back on the network: focus the node we came out of, once its label is reachable again.
      requestAnimationFrame(() => {
        const node = id
          ? document.querySelector<HTMLElement>(`[data-grid-node="${CSS.escape(id)}"]`)
          : null;
        if (node && (document.activeElement === document.body || !document.activeElement))
          node.focus({ preventScroll: true });
      });
    });
  }, [enteredId, ready, rendererRef]);

  return { state, arrivedId };
}

/** Fills the main column from the stage's top down to the page's bottom padding. */
function useStageHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    const main = element?.closest('main');
    if (!element || !main) return;
    const measure = () => {
      const top =
        element.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      setHeight(Math.max(MIN_HEIGHT, Math.floor(main.clientHeight - top - PAGE_BOTTOM)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}
