import type { CSSProperties } from 'react';
import { cx } from '../ui/cx.js';

/** Characters typed one by one (10 ms apart, ~300 ms in all); the rest appear with the last. */
const TYPED_CHARS = 28;

/**
 * Text that types itself in when it changes (key the caller on the text). Each character
 * fades in on a CSS delay, so there's no per-frame JS; Reduced cross-fades the whole line.
 */
export function Typewriter({ text, className }: { text: string; className?: string }) {
  const chars = Array.from(text);
  const head = chars.slice(0, TYPED_CHARS);
  const tail = chars.slice(TYPED_CHARS).join('');
  return (
    <span className={cx('typewriter', className)}>
      <span className="sr-only">{text}</span>
      {head.map((char, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: characters are positional and never reorder.
          key={i}
          aria-hidden
          style={{ '--i': i } as CSSProperties}
        >
          {char}
        </span>
      ))}
      {tail && (
        <span aria-hidden style={{ '--i': TYPED_CHARS } as CSSProperties}>
          {tail}
        </span>
      )}
    </span>
  );
}
