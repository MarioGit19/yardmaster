import { useMemo, useRef } from 'react';
import { useNow } from '../anim/clock.js';
import { useBoard } from '../data/index.js';
import {
  buildSceneModel,
  buildSceneProject,
  type SceneModel,
  type SceneProject,
  shareScene,
} from './scene.js';

/** How often the scene re-reads activity levels and sleep timers when nothing else changes. */
export const SCENE_TICK_MS = 1_000;

/**
 * The whole board as a scene (DESIGN.md §10.1), rebuilt on board changes and once a second. A
 * project that didn't change keeps its object (`shareScene`), so layouts can memo per project.
 */
export function useSceneModel(): SceneModel {
  const board = useBoard((s) => s.board);
  const pulses = useBoard((s) => s.pulses);
  const now = useNow(SCENE_TICK_MS);
  const last = useRef<SceneModel | null>(null);
  return useMemo(() => {
    last.current = shareScene(last.current, buildSceneModel(board, pulses, now));
    return last.current;
  }, [board, pulses, now]);
}

/** One project's scene, for a view of a single project (the Actor inspector). */
export function useSceneProject(projectId: string): SceneProject | null {
  const board = useBoard((s) => s.board);
  const pulses = useBoard((s) => s.pulses);
  const now = useNow(SCENE_TICK_MS);
  return useMemo(
    () => buildSceneProject(board, pulses, projectId, now),
    [board, pulses, projectId, now],
  );
}
