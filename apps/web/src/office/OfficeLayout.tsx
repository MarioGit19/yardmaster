import { AnimatePresence, animate, motion, useMotionValue } from 'motion/react';
import {
  type MouseEvent,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useOwnBackdrop } from '../ambient/backdrop.js';
import { useNow } from '../anim/clock.js';
import { OffstageContext } from '../anim/useFrame.js';
import { attentionOpen } from '../attention/attention.js';
import { SCENE_TICK_MS, useSceneModel } from '../layouts/useScene.js';
import { dur, ease, spring, useMotionLevel } from '../motion.js';
import { useMediaQuery } from '../prefs.js';
import { isTypingTarget } from '../shell/railNav.js';
import { OfficeRoom } from './OfficeRoom.js';
import { RoomPanel } from './RoomPanel.js';
import { buildingColumns, MIN_ROOM_WIDTH, ROOM_HEIGHT } from './room.js';
import { type Box, offsetWithin, type RoomView, roomView } from './zoom.js';

/**
 * DESIGN.md §10.3: the board as a cut-away building. One room per project on floors of 1–5
 * (by the width the building gets), attention first; a reorder glides the rooms on `smooth`.
 * The building draws its own sky, so the ambient field steps out while it's shown.
 *
 * Entering a room (a click or Enter on it) zooms the building layer into it: a transform on
 * `smooth` at Full, a cross-fade at Reduced, a cut at Off. Esc, the Back button or the browser's
 * back step out again, and keyboard focus lands back on the room.
 */
const EAVE = 8;
/** The phone's room view: the actor list is a bottom sheet (not the inspector's touch rule). */
const PHONE_QUERY = '(max-width: 767px)';
/** The history entry a room view pushes, so the back gesture leaves it like Esc. */
const HISTORY_KEY = 'cboardOfficeRoom';

export default function OfficeLayout() {
  useOwnBackdrop();
  const scene = useSceneModel();
  const now = useNow(SCENE_TICK_MS);
  const ref = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [view, setView] = useState<RoomView | null>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  const offstage = useContext(OffstageContext);
  const level = useMotionLevel();
  // Columns hold still while a room is open, so the zoom doesn't chase a reflow.
  const zoomed = useRef(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      if (!zoomed.current) setWidth(Math.floor(element.clientWidth));
    };
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
  const entered = roomId ? scene.projects.find((p) => p.id === roomId) : undefined;

  // A room whose project left the board closes its view.
  useEffect(() => {
    if (roomId && !entered) setRoomId(null);
  }, [roomId, entered]);

  const enter = useCallback((id: string) => {
    window.history.pushState({ ...window.history.state, [HISTORY_KEY]: id }, '');
    setRoomId(id);
  }, []);
  const leave = useCallback(() => {
    if (!roomId) return;
    document
      .querySelector<HTMLElement>(`[data-room="${CSS.escape(roomId)}"]`)
      ?.focus({ preventScroll: true });
    // Leave the way we came in, so Back doesn't re-open the room later.
    if (window.history.state?.[HISTORY_KEY] === roomId) window.history.back();
    else setRoomId(null);
  }, [roomId]);

  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const id = (event.state?.[HISTORY_KEY] as string | undefined) ?? null;
      setRoomId((current) => {
        if (current && id !== current) {
          document
            .querySelector<HTMLElement>(`[data-room="${CSS.escape(current)}"]`)
            ?.focus({ preventScroll: true });
        }
        return id;
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Esc steps out, unless something on top took it (an inspector, the palette, a dialog).
  const offstageRef = useRef(offstage);
  offstageRef.current = offstage;
  useEffect(() => {
    if (!roomId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || offstageRef.current) return;
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      if (attentionOpen.get() === 'open') return;
      event.preventDefault();
      leave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [roomId, leave]);

  // Where the camera goes: measured from untransformed offsets, again when the window resizes.
  const measureView = useCallback((): RoomView | null => {
    const root = ref.current;
    const layer = layerRef.current;
    if (!root || !layer || !roomId) return null;
    const cell = root.querySelector<HTMLElement>(`[data-office-cell="${CSS.escape(roomId)}"]`);
    const main = root.closest<HTMLElement>('main');
    if (!cell) return null;
    const rootBox = root.getBoundingClientRect();
    const stage = main?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };
    const visible: Box = {
      x: stage.left - rootBox.left,
      y: stage.top - rootBox.top,
      w: main?.clientWidth ?? stage.width,
      h: main?.clientHeight ?? stage.height,
    };
    const origin = offsetWithin(layer, root);
    const at = offsetWithin(cell, root);
    return roomView({ ...at, w: cell.offsetWidth, h: cell.offsetHeight }, origin, visible, phone);
  }, [roomId, phone]);

  useLayoutEffect(() => {
    if (!roomId) {
      setView(null);
      return;
    }
    zoomed.current = true;
    ref.current?.closest('main')?.setAttribute('data-office-zoom', '');
    const update = () => setView(measureView());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [roomId, measureView]);

  // Rooms reorder by attention while one is open: the camera follows it to its new spot.
  const framed = useRef(order);
  useLayoutEffect(() => {
    if (framed.current === order) return;
    framed.current = order;
    if (roomId) setView(measureView());
  }, [order, roomId, measureView]);

  // The camera itself: the building layer's x, y and scale (origin top left).
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(1);
  const opacity = useMotionValue(1);
  const levelRef = useRef(level);
  levelRef.current = level;
  const target = view?.zoom ?? null;
  const tx = target?.x ?? 0;
  const ty = target?.y ?? 0;
  const ts = target?.scale ?? 1;
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (x.get() === tx && y.get() === ty && scale.get() === ts) {
      if (ts === 1 && tx === 0 && ty === 0) release();
      return;
    }
    const settle = () => {
      setMoving(false);
      if (ts === 1 && tx === 0 && ty === 0) release();
    };
    const jump = () => {
      x.set(tx);
      y.set(ty);
      scale.set(ts);
    };
    if (levelRef.current === 'off') {
      jump();
      settle();
      return;
    }
    setMoving(true);
    if (levelRef.current === 'reduced') {
      // Cross-fade: the building fades out where it is and back in at the new framing.
      let back: ReturnType<typeof animate> | null = null;
      const out = animate(opacity, 0, { duration: dur.base, ease: ease.out });
      out.then(() => {
        jump();
        back = animate(opacity, 1, { duration: dur.base, ease: ease.out });
        back.then(settle);
      });
      return () => {
        out.stop();
        back?.stop();
        opacity.set(1);
      };
    }
    const runs = [
      animate(x, tx, spring.smooth),
      animate(y, ty, spring.smooth),
      animate(scale, ts, spring.smooth),
    ];
    Promise.all(runs).then(settle);
    return () => {
      for (const run of runs) run.stop();
    };

    function release() {
      zoomed.current = false;
      ref.current?.closest('main')?.removeAttribute('data-office-zoom');
      const element = ref.current;
      if (element) setWidth(Math.floor(element.clientWidth));
    }
  }, [tx, ty, ts, x, y, scale, opacity]);

  useEffect(
    () => () => {
      ref.current?.closest('main')?.removeAttribute('data-office-zoom');
    },
    [],
  );

  // A click outside the open room and its panel (on the dimmed building) steps out too.
  const onStageClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!roomId) return;
    const target = event.target as Element;
    if (!event.currentTarget.contains(target)) return;
    if (target.closest('[data-room-entered], [data-office-room-panel]')) return;
    leave();
  };

  return (
    <>
      <OfficeSky />
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: Esc does the same from the keyboard. */}
      <div
        ref={ref}
        data-office
        data-office-entered={roomId ?? undefined}
        data-office-moving={moving || undefined}
        onClick={onStageClick}
        className="relative w-full"
      >
        {width > 0 && (
          <motion.div
            ref={layerRef}
            data-office-building
            data-columns={columns}
            className="office-building mx-auto"
            style={{ width: roomWidth * columns, x, y, scale, opacity, originX: 0, originY: 0 }}
          >
            <div aria-hidden className="office-roof" />
            <ul
              aria-label="Projects"
              className="office-floors grid"
              style={{ gridTemplateColumns: `repeat(${columns}, ${roomWidth}px)` }}
            >
              {scene.projects.map((project) => {
                const away = roomId !== null && project.id !== roomId;
                return (
                  <motion.li
                    key={project.id}
                    layout="position"
                    layoutDependency={order}
                    transition={{ layout: spring.smooth }}
                    data-office-cell={project.id}
                    data-away={away || undefined}
                    inert={away || undefined}
                    className="office-cell"
                    style={{ height: ROOM_HEIGHT * fit }}
                  >
                    <div
                      className="origin-top-left"
                      style={fit < 1 ? { width: units, transform: `scale(${fit})` } : undefined}
                    >
                      <OfficeRoom
                        project={project}
                        width={units}
                        now={now}
                        entered={project.id === roomId}
                        onEnter={enter}
                        fit={fit}
                      />
                    </div>
                  </motion.li>
                );
              })}
              {Array.from({ length: vacant }, (_, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: empty rooms are positional.
                  key={`vacant-${i}`}
                  aria-hidden
                  data-office-vacant
                  data-away={roomId !== null || undefined}
                  className="office-cell office-vacant"
                  style={{ height: ROOM_HEIGHT * fit }}
                />
              ))}
            </ul>
            <div aria-hidden className="office-ground" />
          </motion.div>
        )}
        <AnimatePresence>
          {entered && view && (
            <RoomPanel
              key={entered.id}
              project={entered}
              box={view.panel}
              sheet={phone}
              onBack={leave}
            />
          )}
        </AnimatePresence>
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
