import { describe, expect, it } from 'vitest';
import { TerminalState } from './domain.js';
import {
  SESSION_SILENT_MS,
  SESSION_STATUS_TOKEN,
  STATUS_TOKEN_META,
  StatusToken,
  sessionSilent,
  sessionStatusToken,
  TOOL_SILENT_MS,
  terminalStatusToken,
} from './status-token.js';

const KINDS = Object.keys(SESSION_STATUS_TOKEN) as (keyof typeof SESSION_STATUS_TOKEN)[];

describe('status tokens', () => {
  it('describes every token', () => {
    expect(Object.keys(STATUS_TOKEN_META).sort()).toEqual([...StatusToken.options].sort());
  });

  it('maps every session status to exactly one token', () => {
    expect(SESSION_STATUS_TOKEN).toEqual({
      idle: 'quiet',
      working: 'running',
      tool: 'running',
      compacting: 'running',
      waiting_permission: 'needs_you',
      waiting_input: 'needs_you',
      error: 'failed',
      unknown: 'quiet',
      ended: 'quiet',
      interrupted: 'quiet',
    });
    for (const kind of KINDS) {
      expect(StatusToken.options).toContain(sessionStatusToken(kind));
    }
  });

  it('maps every terminal state to exactly one token', () => {
    for (const state of TerminalState.options) {
      for (const running of [true, false]) {
        for (const failed of [true, false]) {
          for (const unseen of [true, false]) {
            const token = terminalStatusToken({ state, running, failed, unseen });
            expect(StatusToken.options).toContain(token);
          }
        }
      }
    }
    expect(terminalStatusToken({ state: 'open', running: true, failed: false })).toBe('running');
    expect(terminalStatusToken({ state: 'open', running: false, failed: true })).toBe('failed');
    expect(terminalStatusToken({ state: 'closed', running: false, failed: false })).toBe('quiet');
  });

  it('turns only a Running into Stale', () => {
    expect(sessionStatusToken('working', { stale: true })).toBe('stale');
    expect(sessionStatusToken('waiting_input', { stale: true })).toBe('needs_you');
    expect(sessionStatusToken('error', { stale: true })).toBe('failed');
    expect(sessionStatusToken('idle', { stale: true })).toBe('quiet');
    expect(terminalStatusToken({ state: 'open', running: true, failed: false, stale: true })).toBe(
      'stale',
    );
  });

  it('counts background work as Running, and marks only a settled turn unseen', () => {
    expect(sessionStatusToken('idle', { background: true })).toBe('running');
    expect(sessionStatusToken('ended', { background: true })).toBe('quiet');
    expect(sessionStatusToken('idle', { unseen: true })).toBe('done_unseen');
    expect(sessionStatusToken('working', { unseen: true })).toBe('running');
  });

  it('gives a running tool longer before calling it silent', () => {
    expect(sessionSilent('working', 0, SESSION_SILENT_MS - 1)).toBe(false);
    expect(sessionSilent('working', 0, SESSION_SILENT_MS)).toBe(true);
    expect(sessionSilent('tool', 0, SESSION_SILENT_MS)).toBe(false);
    expect(sessionSilent('tool', 0, TOOL_SILENT_MS)).toBe(true);
    expect(sessionSilent('idle', 0, TOOL_SILENT_MS * 10)).toBe(false);
  });
});
