import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { boardSettings } from '../settings/boardSettings.js';

const NONE: readonly string[] = [];

/** A project's push notifications (`notify.mutedProjects`), for its menus. */
export function useMute(projectId: string): { muted: boolean; toggle: () => void } {
  const settings = useSyncExternalStore(boardSettings.subscribe, boardSettings.get);
  const loaded = settings !== null;
  useEffect(() => {
    if (!loaded) void boardSettings.load();
  }, [loaded]);
  const list = settings?.notifyMutedProjects ?? NONE;
  const muted = list.includes(projectId);
  const toggle = useCallback(() => {
    // Never write a list that wasn't read: it would unmute every other project.
    if (!loaded) return;
    const next = muted ? list.filter((id) => id !== projectId) : [...list, projectId];
    void boardSettings.update({ notifyMutedProjects: next }).then((ok) => {
      if (!ok) toast.error(muted ? 'Could not unmute it' : 'Could not mute it');
    });
  }, [loaded, muted, list, projectId]);
  return { muted, toggle };
}
