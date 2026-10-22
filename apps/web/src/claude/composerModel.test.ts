import { describe, expect, it } from 'vitest';
import {
  composerKey,
  isSessionLive,
  isTurnRunning,
  modelLabel,
  modelValue,
  permissionLabel,
  sendButtonMode,
} from './composerModel.js';

describe('composer model', () => {
  it('labels models by family and version', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-haiku-5')).toBe('Haiku 5');
    expect(modelLabel('sonnet')).toBe('Sonnet');
    expect(modelLabel('claude-custom-1')).toBe('custom-1');
    expect(modelLabel(null)).toBe('Default model');
  });

  it('maps a model id to the picker value', () => {
    expect(modelValue('claude-sonnet-5-5')).toBe('sonnet');
    expect(modelValue('opus')).toBe('opus');
    expect(modelValue('claude-custom-1')).toBe('claude-custom-1');
    expect(modelValue(null)).toBe('');
  });

  it('labels permission modes', () => {
    expect(permissionLabel(null)).toBe('Ask first');
    expect(permissionLabel('acceptEdits')).toBe('Accept edits');
    expect(permissionLabel('plan')).toBe('Plan only');
  });

  it('knows when a turn is running and when a session is live', () => {
    expect(isTurnRunning({ kind: 'working' })).toBe(true);
    expect(isTurnRunning({ kind: 'tool', tool: 'Read', toolUseId: null })).toBe(true);
    expect(isTurnRunning({ kind: 'waiting_permission', approvalId: null })).toBe(true);
    expect(isTurnRunning({ kind: 'idle' })).toBe(false);
    expect(isTurnRunning({ kind: 'ended' })).toBe(false);
    expect(isSessionLive({ kind: 'idle' })).toBe(true);
    expect(isSessionLive({ kind: 'ended' })).toBe(false);
    expect(isSessionLive({ kind: 'unknown', alive: false })).toBe(false);
    expect(isSessionLive({ kind: 'unknown', alive: true })).toBe(true);
  });

  it('morphs the send button between send, sending and stop', () => {
    expect(sendButtonMode({ sending: false, running: false, text: '' })).toBe('send');
    expect(sendButtonMode({ sending: true, running: false, text: 'hi' })).toBe('sending');
    expect(sendButtonMode({ sending: false, running: true, text: '  ' })).toBe('stop');
    // A typed follow-up while Claude works is queued, so the button sends.
    expect(sendButtonMode({ sending: false, running: true, text: 'also this' })).toBe('send');
  });

  it('maps keys: Enter sends, Shift+Enter is a newline, Esc interrupts a running turn', () => {
    const key = (k: string, shiftKey = false, isComposing = false) => ({
      key: k,
      shiftKey,
      isComposing,
    });
    expect(composerKey(key('Enter'), false)).toBe('send');
    expect(composerKey(key('Enter', true), false)).toBeNull();
    expect(composerKey(key('Enter', false, true), false)).toBeNull();
    expect(composerKey(key('Escape'), true)).toBe('interrupt');
    expect(composerKey(key('Escape'), false)).toBeNull();
  });
});
