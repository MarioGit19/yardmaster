import { type ReactNode, useState } from 'react';
import { CrewMascot } from '../crew/CrewMascot.js';
import {
  Bookshelf,
  Couch,
  Desk,
  Plant,
  ServerRack,
  SideDesk,
  Workbench,
} from '../office/kit/furniture.js';
import { PortSign } from '../office/kit/PortSign.js';
import { type DoorLight, RoomShell } from '../office/kit/RoomShell.js';
import { Whiteboard, type WhiteboardItem } from '../office/kit/Whiteboard.js';
import { OpsMascot, type OpsMascotProps } from '../office/OpsMascot.js';
import { OPS_STATES, type OpsMascotState } from '../office/ops.js';

const SIZES = [120, 56, 24] as const;

/** Sheet extras per state, so each one shows its full acting. */
const EXTRA: Partial<Record<OpsMascotState, Partial<OpsMascotProps>>> = {
  running: { activity: 0.6 },
  serving: { activity: 0.7 },
  error: { exit: 1, settle: false },
  done: { settle: false },
};

const TODOS: WhiteboardItem[] = [
  { text: 'Split the cart totals', done: true },
  { text: 'Round prices per line', done: false },
  { text: 'Update the checkout tests', done: false },
];

const ROOMS: { name: string; accent: number; door: DoorLight; light: number; dim?: boolean }[] = [
  { name: 'pixel-notes', accent: 4, door: 'off', light: 0.8 },
  { name: 'orbit-docs', accent: 2, door: 'wait', light: 0.4 },
  { name: 'ledger-api', accent: 8, door: 'err', light: 0, dim: true },
];

function Figure({ name, children }: { name: string; children: ReactNode }) {
  return (
    <figure className="flex min-w-0 flex-col justify-between gap-3 rounded-control border border-line bg-bg-0 p-3">
      <div className="flex min-h-24 flex-wrap items-end gap-4 pt-4">{children}</div>
      <figcaption className="truncate font-mono text-meta text-text-3">{name}</figcaption>
    </figure>
  );
}

function OpsCard({ state }: { state: OpsMascotState }) {
  return (
    <figure
      data-ops-card={state}
      className="flex min-w-0 flex-col gap-2 rounded-control border border-line bg-bg-0 p-3 pt-5"
    >
      <div className="flex items-end gap-6 pr-6">
        {SIZES.map((size) => (
          <OpsMascot key={size} state={state} size={size} {...EXTRA[state]} />
        ))}
      </div>
      <figcaption className="truncate font-mono text-meta text-text-3">{state}</figcaption>
    </figure>
  );
}

/** One room furnished with every station, the way the Office layout will draw it. */
function DemoRoom() {
  return (
    <RoomShell
      project={{ name: 'acme-shop', accent: 6 }}
      branch="feat/cart-totals"
      dirty={3}
      light={0.7}
    >
      <div className="absolute" style={{ left: 60, top: 160 }}>
        <PortSign ports={[3000]} />
      </div>
      <div className="absolute" style={{ left: 104, top: 56 }}>
        <Whiteboard items={TODOS} scale={0.9} />
      </div>
      <div className="absolute" style={{ left: 300, top: 92 }}>
        <ServerRack rate={0.7} ports={[3000]} />
      </div>
      <div className="absolute" style={{ left: 258, top: 128 }}>
        <OpsMascot state="serving" activity={0.7} />
      </div>
      <div className="absolute" style={{ left: 120, top: 134 }}>
        <Desk screen="var(--orb-edit)" glyph="✎" />
      </div>
      <div className="absolute" style={{ left: 190, top: 112 }}>
        <CrewMascot state="typing" tool="Edit" color="var(--accent-6)" />
      </div>
    </RoomShell>
  );
}

/**
 * The Office layout's art kit (DESIGN.md §10.3): the ops crew in every state at every size with
 * a live switcher for the blends, every prop, and the room shell with each door light.
 */
export function OfficeKitSheet() {
  const [live, setLive] = useState<OpsMascotState>('idle');
  const [activity, setActivity] = useState(0.5);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-control border border-line bg-bg-0 p-4 pt-6">
        <div className="flex items-end gap-6">
          {SIZES.map((size) => (
            <OpsMascot
              key={size}
              state={live}
              size={size}
              activity={activity}
              exit={live === 'error' ? 2 : null}
            />
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <fieldset className="flex flex-wrap gap-1.5">
            <legend className="sr-only">Ops state</legend>
            {OPS_STATES.map((state) => (
              <button
                key={state}
                type="button"
                aria-pressed={state === live}
                onClick={() => setLive(state)}
                className="rounded-chip border border-line px-2.5 py-1 font-mono text-label text-text-2 transition-colors duration-fast hover:border-line-strong hover:text-text-1 aria-pressed:border-line-strong aria-pressed:bg-bg-2 aria-pressed:text-text-1"
              >
                {state}
              </button>
            ))}
          </fieldset>
          <label className="flex items-center gap-3 font-mono text-meta text-text-3">
            output rate
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={activity}
              onChange={(e) => setActivity(Number(e.target.value))}
              className="w-40 accent-[var(--st-tool)]"
            />
            <span className="tabular">{activity.toFixed(2)}</span>
          </label>
        </div>
      </div>

      <div data-ops-sheet className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {OPS_STATES.map((state) => (
          <OpsCard key={state} state={state} />
        ))}
      </div>

      <div data-kit-sheet className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure name="desk + monitor">
          <Desk />
          <Desk screen="var(--orb-edit)" glyph="✎" />
        </Figure>
        <Figure name="side desk">
          <SideDesk />
        </Figure>
        <Figure name="server rack · rate 0 / 0.8">
          <ServerRack />
          <ServerRack rate={0.8} ports={[3000, 5173]} />
        </Figure>
        <Figure name="workbench + progress screen">
          <Workbench />
          <Workbench running rate={0.6} progress={0.6} />
        </Figure>
        <Figure name="couch">
          <Couch />
        </Figure>
        <Figure name="bookshelf">
          <Bookshelf />
        </Figure>
        <Figure name="plant · port sign">
          <Plant />
          <PortSign ports={[3000, 5173, 8080, 9229]} />
        </Figure>
        <Figure name="whiteboard · todos / summary">
          <Whiteboard items={TODOS} />
          <Whiteboard summary="Moved totals into the cart service; all 42 tests pass." />
        </Figure>
        <div className="sm:col-span-2 lg:col-span-4">
          <Figure name="whiteboard · drawing pose">
            <span className="flex items-end">
              <CrewMascot state="typing" pose="drawing" color="var(--accent-6)" />
              <Whiteboard items={TODOS.slice(0, 2)} />
            </span>
            <span className="flex items-end">
              <CrewMascot state="thinking" pose="drawing" size={120} color="var(--accent-3)" />
              <Whiteboard items={TODOS} scale={1.4} />
            </span>
          </Figure>
        </div>
      </div>

      <div data-room-sheet className="flex flex-wrap gap-3">
        <DemoRoom />
        {ROOMS.map((room) => (
          <figure key={room.name} className="min-w-0">
            <RoomShell
              project={room}
              branch="main"
              doorLight={room.door}
              light={room.light}
              dim={room.dim}
            >
              <div className="absolute" style={{ left: 150, top: 140 }}>
                <Couch />
              </div>
              <div className="absolute" style={{ left: 180, top: 120 }}>
                <OpsMascot
                  state={room.door === 'err' ? 'error' : room.door === 'wait' ? 'waiting' : 'idle'}
                  exit={room.door === 'err' ? 1 : null}
                  settle={false}
                />
              </div>
            </RoomShell>
            <figcaption className="mt-1 font-mono text-meta text-text-3">
              room · door {room.door}
              {room.dim ? ' · dimmed' : ` · light ${room.light}`}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
