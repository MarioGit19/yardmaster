/** True when this page itself came in over Tailscale (a phone), not from the Mac. */
export const onRemoteHost = () =>
  typeof location !== 'undefined' && location.hostname.toLowerCase().endsWith('.ts.net');
