import type { BoardState, Project } from '@c-board/protocol';

type ProjectId = Project['id'];

// Pure inputs for the ambient field, DESIGN.md §4.1: `uEnergy` from working sessions and
// output throughput, `uAttention` toward the project that is waiting for the user.

const ACTIVE_KINDS = new Set(['working', 'tool', 'compacting']);
const WAITING_KINDS = new Set(['waiting_permission', 'waiting_input']);

/** Sessions that are working, using a tool or compacting. */
export function activeSessionCount(board: BoardState): number {
  let count = 0;
  for (const session of Object.values(board.sessions)) {
    if (ACTIVE_KINDS.has(session.status.kind)) count++;
  }
  return count;
}

/** Commands still running in a terminal. */
export function runningExecutionCount(board: BoardState): number {
  let count = 0;
  for (const execution of Object.values(board.executions)) {
    if (execution.endedAt === null) count++;
  }
  return count;
}

/** Total output bytes the board has seen, the input to `ThroughputMeter`. */
export function totalOutputBytes(board: BoardState): number {
  let total = 0;
  for (const execution of Object.values(board.executions)) total += execution.outputBytes;
  return total;
}

/**
 * The project the room turns toward: the one with the oldest pending approval, else the one
 * whose session has waited longest. Null when nothing needs the user.
 */
export function attentionProjectId(board: BoardState): ProjectId | null {
  let approvalProject: ProjectId | null = null;
  let approvalSince = Number.POSITIVE_INFINITY;
  for (const approval of Object.values(board.approvals)) {
    const projectId = board.sessions[approval.sessionId]?.projectId ?? null;
    if (approval.state !== 'pending' || projectId === null) continue;
    if (approval.createdAt < approvalSince) {
      approvalProject = projectId;
      approvalSince = approval.createdAt;
    }
  }
  if (approvalProject !== null) return approvalProject;

  let waitingProject: ProjectId | null = null;
  let waitingSince = Number.POSITIVE_INFINITY;
  for (const session of Object.values(board.sessions)) {
    if (!WAITING_KINDS.has(session.status.kind) || session.projectId === null) continue;
    if (session.updatedAt < waitingSince) {
      waitingProject = session.projectId;
      waitingSince = session.updatedAt;
    }
  }
  return waitingProject;
}

/**
 * 0..1. Each active session adds a lot, running commands a little, and throughput adds on a
 * log scale, so a chatty build brightens the room without blowing it out.
 */
export function energyFrom(active: number, running: number, bytesPerSecond: number): number {
  const drive =
    0.45 * Math.max(0, active) +
    0.12 * Math.max(0, running) +
    0.25 * Math.log1p(Math.max(0, bytesPerSecond) / 1024);
  return 1 - Math.exp(-drive);
}

/** Smoothed output rate from a growing byte counter. Drops in the counter (pruning) count as 0. */
export class ThroughputMeter {
  private last: { bytes: number; at: number } | null = null;
  private rate = 0;

  constructor(private readonly tauMs = 1500) {}

  /** Feeds the current total; returns bytes per second. */
  sample(totalBytes: number, now: number): number {
    if (this.last === null) {
      this.last = { bytes: totalBytes, at: now };
      return this.rate;
    }
    const dt = now - this.last.at;
    if (dt <= 0) return this.rate;
    const delta = Math.max(0, totalBytes - this.last.bytes);
    this.rate = approach(this.rate, (delta * 1000) / dt, dt, this.tauMs);
    this.last = { bytes: totalBytes, at: now };
    return this.rate;
  }
}

/** Frame-rate-independent exponential approach of `current` toward `target`. */
export function approach(current: number, target: number, dtMs: number, tauMs: number): number {
  if (tauMs <= 0) return target;
  return target + (current - target) * Math.exp(-Math.max(0, dtMs) / tauMs);
}

/**
 * Whether a frame should render at `now` under an fps cap. A small slack keeps a 60 Hz display
 * on a steady every-other-frame cadence instead of jittering between one and three.
 */
export function frameDue(lastFrameAt: number | null, now: number, fps: number): boolean {
  if (lastFrameAt === null) return true;
  return now - lastFrameAt >= 1000 / fps - 2;
}

export interface Point {
  x: number;
  y: number;
}

/** Where the bloom sits when the waiting project has no element on screen: top right. */
export const DEFAULT_ATTENTION_POINT: Point = { x: 0.85, y: 0.12 };

/** A rect's center in 0..1 viewport coordinates (y down), clamped to the viewport. */
export function viewportPoint(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  viewport: { width: number; height: number },
): Point {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  if (viewport.width <= 0 || viewport.height <= 0) return DEFAULT_ATTENTION_POINT;
  return {
    x: clamp((rect.left + rect.width / 2) / viewport.width),
    y: clamp((rect.top + rect.height / 2) / viewport.height),
  };
}
