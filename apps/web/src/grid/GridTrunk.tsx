import { useLayoutEffect, useRef, useState } from 'react';
import type { SceneProject } from '../layouts/scene.js';
import { Core } from './Core.js';
import { GridNode } from './GridNode.js';
import { boardEnergy, CORE_R, HEX_AT, HEX_R, projectTool } from './map.js';
import { Pipeline } from './Pipeline.js';

/** The trunk runs through every node's hexagon, so it sits at the hexagon's x. */
const TRUNK_X = HEX_AT.x;
const TOP = CORE_R * 2 + 20;

export interface GridTrunkProps {
  projects: readonly SceneProject[];
  onEnter(projectId: string): void;
}

/**
 * The phone's Grid (DESIGN.md §10.1, §10.4): the core on top and one trunk pipeline down through
 * every node, attention first. Each run of the trunk carries the packets of the node below it.
 */
export function GridTrunk({ projects, onEnter }: GridTrunkProps) {
  const list = useRef<HTMLUListElement>(null);
  const [ys, setYs] = useState<number[]>([]);
  const order = projects.map((p) => p.id).join('|');

  // Where each hexagon is: rows grow and shrink with their satellites.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the order changes.
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const next = [...element.children].map(
        (child) => (child as HTMLElement).offsetTop + HEX_AT.y,
      );
      setYs((current) =>
        current.length === next.length && current.every((y, i) => y === next[i]) ? current : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [order]);

  const height = (ys.at(-1) ?? TOP) + HEX_R;
  const energy = boardEnergy(projects);

  return (
    <div data-grid-trunk className="relative">
      <svg
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 overflow-visible"
        width={TRUNK_X * 2}
        height={height}
      >
        {projects.map((project, i) => {
          const y = ys[i];
          if (y === undefined) return null;
          const above = i === 0 ? CORE_R : (ys[i - 1] ?? CORE_R);
          return (
            <Pipeline
              key={project.id}
              projectId={project.id}
              from={{ x: TRUNK_X, y: above }}
              to={{ x: TRUNK_X, y }}
              trimFrom={i === 0 ? CORE_R - 2 : HEX_R + 3}
              trimTo={HEX_R + 3}
              tone={project.tone}
              tool={projectTool(project)}
              leaving={project.leaving}
            />
          );
        })}
      </svg>
      <Core energy={energy} count={projects.length} style={{ left: TRUNK_X, top: CORE_R }} />
      <ul
        ref={list}
        aria-label="Projects"
        className="relative flex flex-col gap-4"
        style={{ paddingTop: TOP }}
      >
        {projects.map((project) => (
          <li key={project.id} data-scene-leaving={project.leaving} inert={project.leaving}>
            <GridNode project={project} variant="trunk" onEnter={() => onEnter(project.id)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
