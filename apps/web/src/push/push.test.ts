import { describe, expect, it } from 'vitest';
import { applicationServerKey, type PushEnvironment, pushSupport } from './push.js';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const env = (fields: Partial<PushEnvironment>): PushEnvironment => ({
  isSecureContext: true,
  userAgent: CHROME_MAC,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  standalone: false,
  ...fields,
});

describe('pushSupport', () => {
  it('is on in a secure context with a service worker, push and notifications', () => {
    expect(pushSupport(env({}))).toBe('ok');
  });

  it('needs HTTPS or localhost', () => {
    expect(pushSupport(env({ isSecureContext: false }))).toBe('insecure');
  });

  it('asks iPhone users to add the board to the home screen first', () => {
    const safari = env({ userAgent: IPHONE, hasPushManager: false, hasNotification: false });
    expect(pushSupport(safari)).toBe('ios_home_screen');
    expect(pushSupport({ ...safari, standalone: true })).toBe('unsupported');
    expect(pushSupport(env({ userAgent: IPHONE, standalone: true }))).toBe('ok');
  });

  it('says so for a browser without push', () => {
    expect(pushSupport(env({ hasPushManager: false }))).toBe('unsupported');
  });
});

describe('applicationServerKey', () => {
  it('decodes the base64url VAPID key', () => {
    expect([...applicationServerKey('AQID_-8')]).toEqual([1, 2, 3, 255, 239]);
  });
});
