import { Check, Copy } from 'lucide-react';
import {
  type ComponentPropsWithoutRef,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useEffect,
  useState,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cx } from '../ui/cx.js';
import { langFor, type TokenLine, useHighlight } from './highlight.js';

const FONT_ITALIC = 1;
const FONT_BOLD = 2;
const FONT_UNDERLINE = 4;

function Tokens({ lines }: { lines: TokenLine[] }) {
  return lines.map((line, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
    <span key={i} className="block">
      {line.length === 0
        ? '\n'
        : line.map(([content, color, style = 0], j) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
              key={j}
              style={{
                color,
                fontStyle: style & FONT_ITALIC ? 'italic' : undefined,
                fontWeight: style & FONT_BOLD ? 600 : undefined,
                textDecoration: style & FONT_UNDERLINE ? 'underline' : undefined,
              }}
            >
              {content}
            </span>
          ))}
    </span>
  ));
}

/** A fenced code block: plain at once, highlighted when the worker answers. */
export function CodeBlock({ code, lang: info }: { code: string; lang: string | null }) {
  const lang = langFor(info);
  const lines = useHighlight(code, lang);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_400);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(
      () => setCopied(true),
      () => {},
    );
  };

  return (
    <div className="md-code group relative my-3 rounded-control border border-line bg-bg-0/60">
      <div className="flex h-7 items-center justify-between gap-2 border-line border-b pr-1 pl-3">
        <span className="font-mono text-meta text-text-3">{info || 'text'}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className="flex size-6 items-center justify-center rounded-chip text-text-3 opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-bg-2 hover:text-text-1 focus-visible:opacity-100 group-hover:opacity-100"
        >
          {copied ? (
            <Check className="size-3.5 text-st-ok-ink" strokeWidth={1.75} />
          ) : (
            <Copy className="size-3.5" strokeWidth={1.5} />
          )}
        </button>
      </div>
      <pre
        data-highlighted={lines ? '' : undefined}
        className="overflow-x-auto px-3 py-2.5 font-mono text-label leading-5 text-text-1"
      >
        <code>{lines ? <Tokens lines={lines} /> : code}</code>
      </pre>
    </div>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

const COMPONENTS: Components = {
  pre({ children }) {
    const code = Array.isArray(children) ? children[0] : children;
    const props = isValidElement(code)
      ? (code as ReactElement<{ className?: string; children?: ReactNode }>).props
      : { children };
    const lang = /language-([\w+-]+)/.exec(props.className ?? '')?.[1] ?? null;
    return <CodeBlock code={textOf(props.children).replace(/\n$/, '')} lang={lang} />;
  },
  a({ href, children, node: _node, ...rest }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
    return (
      <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  img({ alt }) {
    // Remote images would be fetched from the transcript's URLs; show the alt text instead.
    return <span className="text-text-3">[{alt || 'image'}]</span>;
  },
};

const PLUGINS = [remarkGfm];

/** Assistant markdown. Raw HTML is dropped, links open in a new tab. */
export const Markdown = memo(function Markdown({
  text,
  className,
  streaming,
}: {
  text: string;
  className?: string;
  /** Adds the glowing caret after the last block. */
  streaming?: boolean;
}) {
  return (
    <div className={cx('md', className)} data-streaming={streaming ? '' : undefined}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
