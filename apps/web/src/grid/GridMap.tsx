import { useState } from 'react';
import type { SceneProject } from '../layouts/scene.js';
import { Core } from './Core.js';
import { GridNode } from './GridNode.js';
import {
  boardEnergy,
  CORE_R,
  HEX_R,
  hexCenter,
  NODE_H,
  NODE_W,
  planMap,
  projectTool,
} from './map.js';
import { Pipeline } from './Pipeline.js';

export interface GridMapProps {
  projects: readonly SceneProject[];
  width: number;
  onEnter(projectId: string): void;
}

/**
 * The flat network (DESIGN.md §10.4 "2D map"): the core in the middle, every project a node on a
 * ring around it, attention first and clockwise from the top, each fed by a straight pipeline.
 * Pipelines and packets are one SVG under the nodes; nodes are DOM, so their text stays crisp.
 * A reorder moves a node and its pipeline together in one step, so the line never trails it.
 */
export function GridMap({ projects, width, onEnter }: GridMapProps) {
  const plan = planMap(projects.length, width);
  const [hot, setHot] = useState<string | null>(null);
  const energy = boardEnergy(projects);

  return (
    <div
      data-grid-map
      className="relative mx-auto"
      style={{ width: plan.width, height: plan.height }}
    >
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-visible"
        width={plan.width}
        height={plan.height}
        viewBox={`0 0 ${plan.width} ${plan.height}`}
      >
        {projects.map((project, i) => {
          const node = plan.nodes[i];
          if (!node) return null;
          return (
            <Pipeline
              key={project.id}
              projectId={project.id}
              from={plan.core}
              to={hexCenter(node)}
              trimFrom={CORE_R + 4}
              trimTo={HEX_R + 3}
              tone={project.tone}
              tool={projectTool(project)}
              hot={hot === project.id}
              leaving={project.leaving}
            />
          );
        })}
      </svg>
      <Core
        energy={energy}
        count={projects.length}
        style={{ left: plan.core.x, top: plan.core.y }}
      />
      <ul aria-label="Projects" className="contents">
        {projects.map((project, i) => {
          const node = plan.nodes[i];
          if (!node) return null;
          return (
            <li
              key={project.id}
              data-scene-leaving={project.leaving}
              inert={project.leaving}
              className="absolute"
              style={{ left: node.x - NODE_W / 2, top: node.y - NODE_H / 2 }}
            >
              <GridNode
                project={project}
                variant="map"
                style={{ width: NODE_W, height: NODE_H }}
                onEnter={() => onEnter(project.id)}
                onHover={(on) =>
                  setHot((current) => (on ? project.id : current === project.id ? null : current))
                }
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
