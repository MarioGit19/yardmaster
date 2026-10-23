import { type RefObject, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { OffstageContext } from '../anim/useFrame.js';
import { useBoardStore } from '../data/index.js';
import type { SceneProject } from '../layouts/scene.js';
import { useTheme } from '../theme/theme.js';
import { GridNode } from './GridNode.js';
import { GridRenderer, readPalette } from './GridRenderer.js';

/** The 3D stage never gets shorter than this; a shorter window scrolls. */
const MIN_HEIGHT = 460;
/** The page's bottom padding, kept below the stage. */
const PAGE_BOTTOM = 24;

export interface Grid3DProps {
  projects: readonly SceneProject[];
  onEnter(projectId: string): void;
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
export default function Grid3D({ projects, onEnter, onLost }: Grid3DProps) {
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
      <ul ref={labelsRef} aria-label="Projects" className="pointer-events-none absolute inset-0">
        {projects.map((project) => (
          <li key={project.id} data-grid-label={project.id} className="grid-float">
            <GridNode
              project={project}
              variant="float"
              onEnter={() => onEnter(project.id)}
              onHover={(on) => rendererRef.current?.setHot(on ? project.id : null)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
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
