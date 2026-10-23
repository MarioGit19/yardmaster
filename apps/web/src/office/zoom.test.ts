import { describe, expect, it } from 'vitest';
import { CHARACTER_PX } from './room.js';
import { MAX_ZOOM, project, ROOM_VIEW_PX, roomView } from './zoom.js';

const origin = { x: 40, y: 80 };

describe('roomView', () => {
  it('zooms a desktop room so its characters stand about 120 px, beside the panel', () => {
    const cell = { x: 400, y: 300, w: 360, h: 220 };
    const view = { x: 0, y: 0, w: 1440, h: 900 };
    const { zoom, panel } = roomView(cell, origin, view, false);
    expect(zoom.scale).toBeCloseTo(MAX_ZOOM);
    expect(CHARACTER_PX * zoom.scale).toBeCloseTo(ROOM_VIEW_PX);
    // The panel hugs the right edge of the stage.
    expect(panel.x + panel.w).toBe(1440 - 16);
    expect(panel.h).toBe(900 - 32);
    // The room lands left of the panel, centered in the space it leaves.
    const topLeft = project(cell, origin, zoom);
    const right = topLeft.x + cell.w * zoom.scale;
    expect(topLeft.x).toBeGreaterThanOrEqual(24);
    expect(right).toBeLessThanOrEqual(panel.x - 24);
    expect(topLeft.x - 24).toBeCloseTo(panel.x - 24 - right);
    expect(topLeft.y + (cell.h * zoom.scale) / 2).toBeCloseTo(450);
  });

  it('fits a room smaller when the stage is short or narrow', () => {
    const cell = { x: 0, y: 0, w: 360, h: 220 };
    const { zoom } = roomView(cell, { x: 0, y: 0 }, { x: 0, y: 0, w: 1000, h: 400 }, false);
    expect(zoom.scale).toBeCloseTo((400 - 48) / 220);
    expect(zoom.scale).toBeLessThan(MAX_ZOOM);
  });

  it('respects a scrolled stage: the room lands inside the visible box', () => {
    const cell = { x: 20, y: 1400, w: 360, h: 220 };
    const view = { x: 0, y: 1200, w: 1200, h: 800 };
    const { zoom, panel } = roomView(cell, origin, view, false);
    const topLeft = project(cell, origin, zoom);
    expect(topLeft.y).toBeGreaterThanOrEqual(1200);
    expect(topLeft.y + cell.h * zoom.scale).toBeLessThanOrEqual(2000);
    expect(panel.y).toBe(1216);
  });

  it('on a phone the room fills the width and the sheet takes the rest below it', () => {
    const cell = { x: 8, y: 500, w: 374, h: 220 };
    const view = { x: 0, y: 0, w: 390, h: 740 };
    const { zoom, panel } = roomView(cell, { x: 8, y: 20 }, view, true);
    const topLeft = project(cell, { x: 8, y: 20 }, zoom);
    expect(topLeft.x).toBeCloseTo(12);
    expect(cell.w * zoom.scale).toBeCloseTo(390 - 24);
    expect(topLeft.y).toBeCloseTo(12);
    expect(panel).toEqual({
      x: 0,
      y: topLeft.y + cell.h * zoom.scale + 12,
      w: 390,
      h: 740 - (topLeft.y + cell.h * zoom.scale + 12),
    });
  });
});
