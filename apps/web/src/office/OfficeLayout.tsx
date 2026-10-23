import { motion } from 'motion/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useOwnBackdrop } from '../ambient/backdrop.js';
import { useNow } from '../anim/clock.js';
import { SCENE_TICK_MS, useSceneModel } from '../layouts/useScene.js';
import { spring } from '../motion.js';
import { OfficeRoom } from './OfficeRoom.js';
import { buildingColumns, MIN_ROOM_WIDTH, ROOM_HEIGHT } from './room.js';

/**
 * DESIGN.md §10.3: the board as a cut-away building. One room per project on floors of 1–5
 * (by the width the building gets), attention first; a reorder glides the rooms on `smooth`.
 * The building draws its own sky, so the ambient field steps out while it's shown.
 */
const EAVE = 8;

export default function OfficeLayout() {
  useOwnBackdrop();
  const scene = useSceneModel();
  const now = useNow(SCENE_TICK_MS);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The roof and ground overhang the walls by `EAVE` px on each side; one px for the right wall.
  const { columns, room } = buildingColumns(width - 2 * EAVE - 1);
  const roomWidth = Math.floor(room);
  // A phone's room is narrower than a crew needs: draw it at the minimum width, scaled to fit.
  const fit = Math.min(1, roomWidth / MIN_ROOM_WIDTH);
  const units = Math.max(roomWidth, MIN_ROOM_WIDTH);
  const count = scene.projects.length;
  const vacant = (columns - (count % columns)) % columns;
  const order = scene.projects.map((p) => p.id).join('|');

  return (
    <>
      <OfficeSky />
      <div ref={ref} data-office className="w-full">
        {width > 0 && (
          <div
            data-office-building
            data-columns={columns}
            className="office-building mx-auto"
            style={{ width: roomWidth * columns }}
          >
            <div aria-hidden className="office-roof" />
            <ul
              aria-label="Projects"
              className="office-floors grid"
              style={{ gridTemplateColumns: `repeat(${columns}, ${roomWidth}px)` }}
            >
              {scene.projects.map((project) => (
                <motion.li
                  key={project.id}
                  layout="position"
                  layoutDependency={order}
                  transition={{ layout: spring.smooth }}
                  className="office-cell"
                  style={{ height: ROOM_HEIGHT * fit }}
                >
                  <div
                    className="origin-top-left"
                    style={fit < 1 ? { width: units, transform: `scale(${fit})` } : undefined}
                  >
                    <OfficeRoom project={project} width={units} now={now} />
                  </div>
                </motion.li>
              ))}
              {Array.from({ length: vacant }, (_, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: empty rooms are positional.
                  key={`vacant-${i}`}
                  aria-hidden
                  data-office-vacant
                  className="office-cell office-vacant"
                  style={{ height: ROOM_HEIGHT * fit }}
                />
              ))}
            </ul>
            <div aria-hidden className="office-ground" />
          </div>
        )}
      </div>
    </>
  );
}

/** The sky behind the building: a starry night or a bright day, still (it encodes nothing). */
function OfficeSky() {
  return (
    <div
      aria-hidden
      data-office-sky
      className="office-sky pointer-events-none fixed inset-0 -z-10"
    />
  );
}
