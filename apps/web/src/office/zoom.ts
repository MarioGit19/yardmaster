import { CHARACTER_PX } from './room.js';

// The Office room view (DESIGN.md §10.3): the camera zooms the building layer into one room, so
// it fills the stage beside the actor panel (or above the bottom sheet on a phone). Pure, so the
// layout and its tests agree on the geometry.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** In the room view characters stand this tall: the 56 px crew at about 2×. */
export const ROOM_VIEW_PX = 120;
export const MAX_ZOOM = ROOM_VIEW_PX / CHARACTER_PX;
/** Desktop side panel: width range and its inset from the stage's edges. */
const PANEL_MIN = 280;
const PANEL_MAX = 360;
const PANEL_GAP = 16;
/** Breathing room around the zoomed room. */
const PAD = 24;
const PAD_PHONE = 12;
/** On a phone the room takes at most this much of the stage's height; the sheet gets the rest. */
const PHONE_ROOM_SHARE = 0.5;

export interface RoomView {
  /** The building layer's transform, with its origin at the layer's top left. */
  zoom: { x: number; y: number; scale: number };
  /** The side panel, or on a phone the bottom sheet, in the same coordinates as `view`. */
  panel: Box;
}

/**
 * Where the camera goes to show one room. `cell` is the room's box and `origin` the building
 * layer's top left, both untransformed; `view` is the visible stage. All in one coordinate space.
 * `sheet`: a phone, where the actor list is a bottom sheet under the room instead of a panel.
 */
export function roomView(
  cell: Box,
  origin: { x: number; y: number },
  view: Box,
  sheet: boolean,
): RoomView {
  let area: Box;
  let panel: Box;
  if (sheet) {
    area = {
      x: view.x + PAD_PHONE,
      y: view.y + PAD_PHONE,
      w: view.w - 2 * PAD_PHONE,
      h: view.h * PHONE_ROOM_SHARE - PAD_PHONE,
    };
    panel = { x: view.x, y: 0, w: view.w, h: 0 };
  } else {
    const w = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, view.w * 0.3)));
    panel = {
      x: view.x + view.w - PANEL_GAP - w,
      y: view.y + PANEL_GAP,
      w,
      h: view.h - 2 * PANEL_GAP,
    };
    area = {
      x: view.x + PAD,
      y: view.y + PAD,
      w: panel.x - PAD - (view.x + PAD),
      h: view.h - 2 * PAD,
    };
  }
  const scale = Math.max(0.1, Math.min(MAX_ZOOM, area.w / cell.w, Math.max(0, area.h) / cell.h));
  const width = cell.w * scale;
  const height = cell.h * scale;
  // Centered in its area; on a phone it sits at the top and the sheet starts under it.
  const left = area.x + (area.w - width) / 2;
  const top = sheet ? area.y : area.y + (area.h - height) / 2;
  if (sheet) {
    const y = top + height + PAD_PHONE;
    panel = { ...panel, y, h: view.y + view.h - y };
  }
  return {
    zoom: {
      x: left - origin.x - scale * (cell.x - origin.x),
      y: top - origin.y - scale * (cell.y - origin.y),
      scale,
    },
    panel,
  };
}

/** Where `point` (untransformed, in the shared space) lands under the layer's `zoom`. */
export function project(
  point: { x: number; y: number },
  origin: { x: number; y: number },
  zoom: RoomView['zoom'],
): { x: number; y: number } {
  return {
    x: origin.x + zoom.x + zoom.scale * (point.x - origin.x),
    y: origin.y + zoom.y + zoom.scale * (point.y - origin.y),
  };
}

/** An element's untransformed offset from `ancestor` (which must be positioned). */
export function offsetWithin(
  element: HTMLElement,
  ancestor: HTMLElement,
): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = element;
  while (node && node !== ancestor) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y };
}
