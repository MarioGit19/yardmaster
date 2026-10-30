import { useEffect, useMemo, useReducer, useRef } from 'react';
import { useNow } from '../anim/clock.js';
import { useBoard } from '../data/index.js';
import { useActiveProjects } from '../library/useActive.js';
import { dur } from '../motion.js';
import { useSeenItems } from '../seen.js';
import { hearsServer } from '../statusTokens.js';
import {
  buildSceneModel,
  buildSceneProject,
  type LeavingProject,
  lingerProjects,
  type SceneActor,
  type SceneDevice,
  type SceneModel,
  type SceneProject,
  shareScene,
} from './scene.js';

/** How often the scene re-reads activity levels and sleep timers when nothing else changes. */
export const SCENE_TICK_MS = 1_000;

function useSceneDevice(): SceneDevice {
  const seen = useSeenItems();
  const live = hearsServer(useBoard((s) => s.connection.status));
  return useMemo(() => ({ seen, live }), [seen, live]);
}

/**
 * The whole board as a scene (DESIGN.md §10.1), rebuilt on board changes and once a second. A
 * project that didn't change keeps its object (`shareScene`), so layouts can memo per project.
 */
export function useSceneModel(): SceneModel {
  const board = useBoard((s) => s.board);
  const pulses = useBoard((s) => s.pulses);
  const now = useNow(SCENE_TICK_MS);
  const device = useSceneDevice();
  const last = useRef<SceneModel | null>(null);
  return useMemo(() => {
    last.current = shareScene(last.current, buildSceneModel(board, pulses, now, device));
    return last.current;
  }, [board, pulses, now, device]);
}

/** How long a project that went inactive stays drawn for its exit: `dur.fast`, plus a frame. */
export const LEAVE_MS = dur.fast * 1000 + 40;

/**
 * The overview's scene: only active projects (F26). One that goes inactive stays a moment,
 * marked `leaving`, so the layout can fade it out (`data-scene-leaving`) instead of dropping it.
 */
export function useOverviewScene(): SceneModel {
  const scene = useSceneModel();
  const active = useActiveProjects();
  const [tick, wake] = useReducer((n: number) => n + 1, 0);
  const last = useRef<{ shown: SceneModel | null; leaving: Map<string, LeavingProject> }>({
    shown: null,
    leaving: new Map(),
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` drops expired exits
  const shown = useMemo(() => {
    const visible = scene.projects.filter((p) => active.has(p.id));
    const prev = last.current.shown?.projects ?? [];
    const { projects, leaving } = lingerProjects(
      prev,
      visible,
      last.current.leaving,
      Date.now(),
      LEAVE_MS,
    );
    let model: SceneModel;
    if (leaving.size === 0 && projects.length === scene.projects.length) model = scene;
    else {
      const actors = new Map<string, SceneActor>();
      for (const project of projects) {
        for (const actor of project.actors) actors.set(actor.id, actor);
      }
      model = { projects, actors };
    }
    last.current = { shown: model, leaving };
    return model;
  }, [scene, active, tick]);
  const leaving = last.current.leaving;
  useEffect(() => {
    if (leaving.size === 0) return;
    const until = Math.min(...[...leaving.values()].map((l) => l.until));
    const timer = setTimeout(wake, Math.max(0, until - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [leaving]);
  return shown;
}

/** One project's scene, for a view of a single project (the Actor inspector). */
export function useSceneProject(projectId: string): SceneProject | null {
  const board = useBoard((s) => s.board);
  const pulses = useBoard((s) => s.pulses);
  const now = useNow(SCENE_TICK_MS);
  const device = useSceneDevice();
  return useMemo(
    () => buildSceneProject(board, pulses, projectId, now, device),
    [board, pulses, projectId, now, device],
  );
}
