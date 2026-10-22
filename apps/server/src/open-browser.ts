import { execFile } from 'node:child_process';

/** The platform's "open this URL" command, as an argument array (never a shell string). */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  // Not `cmd /c start`: cmd would re-parse the URL as a command line.
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

/** Opens `url` in the default browser. Resolves false when the opener fails. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform) {
  const [file, args] = browserCommand(url, platform);
  return new Promise<boolean>((done) => {
    const child = execFile(file, args, { windowsHide: true }, (err) => done(!err));
    child.unref();
  });
}
