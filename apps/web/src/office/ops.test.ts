import { describe, expect, it } from 'vitest';
import { OPS_COLOR, OPS_STATES, opsLabel, opsMascotState, opsStation } from './ops.js';

describe('opsMascotState', () => {
  it('maps a terminal state to the ops crew', () => {
    expect(opsMascotState('running')).toBe('running');
    expect(opsMascotState('serving')).toBe('serving');
    expect(opsMascotState('error')).toBe('error');
    expect(opsMascotState('done')).toBe('done');
    expect(opsMascotState('sleeping')).toBe('sleeping');
    expect(opsMascotState('exited')).toBe('sleeping');
  });

  it('lets a waiting Claude prompt in the terminal win', () => {
    expect(opsMascotState('running', { waiting: true })).toBe('waiting');
    expect(opsMascotState('error', { waiting: true })).toBe('waiting');
  });
});

describe('ops colors', () => {
  it('use the status colors, so the visor means what a dot means', () => {
    expect(OPS_COLOR.running).toBe('var(--st-tool)');
    expect(OPS_COLOR.serving).toBe('var(--st-tool)');
    expect(OPS_COLOR.error).toBe('var(--st-err)');
    expect(OPS_COLOR.waiting).toBe('var(--st-wait)');
  });

  it('give the attention states their own color', () => {
    const others = OPS_STATES.filter((s) => s !== 'error' && s !== 'waiting');
    for (const state of others) {
      expect(OPS_COLOR[state]).not.toBe(OPS_COLOR.error);
      expect(OPS_COLOR[state]).not.toBe(OPS_COLOR.waiting);
    }
  });
});

describe('opsLabel', () => {
  it('names the exit code of a failure', () => {
    expect(opsLabel('error', 2)).toBe('Failed with exit 2');
    expect(opsLabel('error')).toBe('Failed');
    expect(opsLabel('serving')).toBe('Serving');
  });
});

describe('opsStation', () => {
  it('sends work to its station and rest to the couch', () => {
    expect(opsStation('running')).toBe('bench');
    expect(opsStation('serving', 'couch')).toBe('rack');
    expect(opsStation('idle', 'rack')).toBe('couch');
    expect(opsStation('sleeping', 'bench')).toBe('couch');
  });

  it('plays done, error and waiting where the command ran', () => {
    expect(opsStation('done', 'bench')).toBe('bench');
    expect(opsStation('error', 'rack')).toBe('rack');
    expect(opsStation('waiting', 'bench')).toBe('bench');
  });
});
