import { GripHorizontal } from 'lucide-react';
import { createContext, type KeyboardEvent, type PointerEvent, useContext } from 'react';

export interface PodMove {
  /** Starts dragging the pod from a pointer press. */
  drag(event: PointerEvent): void;
  /** Moves the pod one place along the grid. */
  nudge(by: 1 | -1): void;
}

/** Set by the grid around each pod; a pod anywhere else can't be moved. */
export const PodMoveContext = createContext<PodMove | null>(null);

const NUDGE: Record<string, 1 | -1> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
};

/** The handle that moves a pod: drag it, or focus it and use the arrow keys. */
export function PodGrip({ name }: { name: string }) {
  const move = useContext(PodMoveContext);
  if (!move) return null;
  const onKeyDown = (event: KeyboardEvent) => {
    const by = NUDGE[event.key];
    if (by === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    move.nudge(by);
  };
  return (
    <button
      type="button"
      data-pod-grip=""
      aria-label={`Move ${name}. Use the arrow keys.`}
      title="Drag to reorder"
      onPointerDown={move.drag}
      onKeyDown={onKeyDown}
      className="absolute top-1 left-1/2 z-10 grid h-4 w-8 -translate-x-1/2 cursor-grab touch-none select-none place-items-center rounded-control text-text-3 opacity-0 transition-opacity duration-fast ease-out hover:text-text-2 focus-visible:opacity-100 active:cursor-grabbing group-hover:opacity-100 touch:top-0 touch:size-11 touch:opacity-100"
    >
      <GripHorizontal aria-hidden className="size-4" strokeWidth={1.5} />
    </button>
  );
}
