import { describe, expect, it } from 'vitest';
import { StreamId } from './messages.js';
import { decodeChatMessage, sessionIdFromStream, transcriptStreamId } from './transcript.js';

describe('transcript streams', () => {
  it('builds and parses transcript stream ids', () => {
    const id = transcriptStreamId('3f6c1a2e-8b7d-4c5e-9a10-2b3c4d5e6f70');
    expect(StreamId.safeParse(id).success).toBe(true);
    expect(sessionIdFromStream(id)).toBe('3f6c1a2e-8b7d-4c5e-9a10-2b3c4d5e6f70');
    expect(sessionIdFromStream('term:term-1')).toBeNull();
    expect(sessionIdFromStream('transcript:')).toBeNull();
  });

  it('decodes chunks defensively', () => {
    const message = {
      id: 'u-1:0',
      uuid: 'u-1',
      ts: null,
      kind: 'tool_result',
      toolUseId: 'toolu_1',
      text: 'ok',
      isError: false,
    };
    expect(decodeChatMessage(JSON.stringify(message))).toEqual(message);
    expect(decodeChatMessage('{"kind":"tool_result"')).toBeNull();
    expect(decodeChatMessage('{"kind":"nope","id":"x"}')).toBeNull();
  });
});
