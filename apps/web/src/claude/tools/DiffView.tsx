import { memo } from 'react';
import { createPreference, usePreference } from '../../prefs.js';
import { cx } from '../../ui/cx.js';
import { type Lang, type TokenLine, useHighlight } from '../highlight.js';
import { type DiffLine, type Hunk, type Segment, segments, splitRows } from './diff.js';
import { useStickyFlag } from './viewState.js';

export const DIFF_LAYOUTS = ['unified', 'split'] as const;
export type DiffLayout = (typeof DIFF_LAYOUTS)[number];
export const diffLayoutPreference = createPreference<DiffLayout>(
  'cboard.diff.layout',
  DIFF_LAYOUTS,
  'unified',
);

/** Rows shown before "Show all". */
const CLAMP_ROWS = 18;
/** Never render more rows than this, even expanded. */
const MAX_ROWS = 800;

const FONT_ITALIC = 1;
const FONT_BOLD = 2;

function Code({ parts }: { parts: Segment[] }) {
  return parts.map((s, i) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
      key={i}
      className={s.mark ? 'diff-mark' : undefined}
      style={
        s.color || s.fontStyle
          ? {
              color: s.color,
              fontStyle: s.fontStyle && s.fontStyle & FONT_ITALIC ? 'italic' : undefined,
              fontWeight: s.fontStyle && s.fontStyle & FONT_BOLD ? 600 : undefined,
            }
          : undefined
      }
    >
      {s.text}
    </span>
  ));
}

const SIGN = { add: '+', del: '−', ctx: ' ' } as const;

function tokensFor(line: DiffLine, oldTokens: TokenLine[] | null, newTokens: TokenLine[] | null) {
  if (line.type === 'del') return line.oldIdx === null ? null : oldTokens?.[line.oldIdx];
  return line.newIdx === null ? null : newTokens?.[line.newIdx];
}

interface HunkProps {
  hunk: Hunk;
  lang: Lang | null;
  /** How many of the hunk's lines to show. */
  limit: number;
  numbers: boolean;
  /** Line-number column width, in ch. */
  gutter: number;
  layout: DiffLayout;
}

const ctxCount = (hunk: Hunk) => hunk.lines.length - hunk.added - hunk.removed;

const HunkView = memo(function HunkView({ hunk, lang, limit, numbers, gutter, layout }: HunkProps) {
  const oldTokens = useHighlight(
    hunk.oldText,
    hunk.removed > 0 || layout === 'split' ? lang : null,
  );
  const newTokens = useHighlight(hunk.newText, lang);
  const lines = hunk.lines.slice(0, limit);
  const no = (n: number | null) => (
    <span className="diff-no shrink-0 pr-2 text-right" style={{ width: `${gutter}ch` }}>
      {n ?? ''}
    </span>
  );

  // A pure addition or removal has nothing to put beside it: split shows it unified.
  if (layout === 'unified' || hunk.added === 0 || hunk.removed === 0) {
    return (
      <div className="w-max min-w-full">
        {lines.map((line, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            key={i}
            data-diff={line.type}
            className={cx('diff-row flex', `diff-${line.type}`)}
          >
            {numbers && hunk.removed + ctxCount(hunk) > 0 && no(line.oldNo)}
            {numbers && no(line.newNo)}
            <span aria-hidden className="diff-sign w-5 shrink-0 text-center">
              {SIGN[line.type]}
            </span>
            <span className="pr-4 whitespace-pre">
              <Code
                parts={segments(line.text, tokensFor(line, oldTokens, newTokens), line.marks)}
              />
            </span>
          </div>
        ))}
      </div>
    );
  }

  const rows = splitRows(lines);
  const side = (pick: 'left' | 'right') => (
    <div className="min-w-0 overflow-x-auto">
      <div className="w-max min-w-full">
        {rows.map((row, i) => {
          const line = row[pick];
          const shown = line && (pick === 'left' ? line.type !== 'add' : line.type !== 'del');
          if (!line || !shown) {
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            return <div key={i} className="diff-row diff-empty" />;
          }
          const type = line.type === 'ctx' ? 'ctx' : pick === 'left' ? 'del' : 'add';
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <div key={i} data-diff={type} className={cx('diff-row flex', `diff-${type}`)}>
              {numbers && no(pick === 'left' ? line.oldNo : line.newNo)}
              <span aria-hidden className="diff-sign w-5 shrink-0 text-center">
                {SIGN[type]}
              </span>
              <span className="pr-4 whitespace-pre">
                <Code
                  parts={segments(
                    line.text,
                    pick === 'left'
                      ? line.oldIdx === null
                        ? null
                        : oldTokens?.[line.oldIdx]
                      : line.newIdx === null
                        ? null
                        : newTokens?.[line.newIdx],
                    line.marks,
                  )}
                />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
  return (
    <div className="grid grid-cols-2 divide-x divide-line">
      {side('left')}
      {side('right')}
    </div>
  );
});

export interface DiffViewProps {
  /** Keys the "show all" state, so it survives virtualization. */
  id: string;
  hunks: readonly Hunk[];
  lang: Lang | null;
  /** Labels the gaps between hunks (MultiEdit), e.g. "Edit 2". */
  gapLabel?: (index: number) => string;
  /** Overrides the global layout, e.g. unified in a narrow sheet. */
  layout?: DiffLayout;
}

/**
 * A syntax-highlighted line diff, unified or side by side (a global preference). Long diffs show
 * their first lines and a "Show all" button.
 */
export function DiffView({ id, hunks, lang, gapLabel, layout: forced }: DiffViewProps) {
  const preferred = usePreference(diffLayoutPreference);
  const layout = forced ?? preferred;
  const [all, toggleAll] = useStickyFlag(`${id}:all`, false);
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  const numbers = hunks.some((h) => h.lines.some((l) => l.oldNo !== null || l.newNo !== null));
  const maxNo = Math.max(
    0,
    ...hunks.flatMap((h) => h.lines.map((l) => Math.max(l.oldNo ?? 0, l.newNo ?? 0))),
  );
  const gutter = String(maxNo).length + 2;
  const budget = Math.min(all ? total : CLAMP_ROWS, MAX_ROWS);

  let left = budget;
  const shown: { hunk: Hunk; limit: number }[] = [];
  for (const hunk of hunks) {
    if (left <= 0) break;
    const limit = Math.min(left, hunk.lines.length);
    shown.push({ hunk, limit });
    left -= limit;
  }
  const hidden = total - budget;

  return (
    <div data-diff-view={layout} className="diff font-mono text-label leading-5 text-text-1">
      {shown.map(({ hunk, limit }, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hunks are positional
        <div key={i}>
          {i > 0 && (
            <div className="diff-gap flex h-6 items-center px-3 font-sans text-meta text-text-3">
              {gapLabel?.(i) ?? '⋯'}
            </div>
          )}
          <div
            className={
              layout === 'unified' || hunk.added === 0 || hunk.removed === 0
                ? 'overflow-x-auto'
                : undefined
            }
          >
            <HunkView
              hunk={hunk}
              lang={lang}
              limit={limit}
              numbers={numbers}
              gutter={gutter}
              layout={layout}
            />
          </div>
        </div>
      ))}
      {total === 0 && <p className="px-3 py-1.5 font-sans text-meta text-text-2">No changes</p>}
      {(hidden > 0 || (all && total > CLAMP_ROWS)) && (
        <button
          type="button"
          onClick={toggleAll}
          className="diff-more flex h-7 w-full items-center justify-center font-sans text-label text-text-3 transition-colors duration-fast hover:text-text-1"
        >
          {all
            ? `Show less${hidden > 0 ? ` · ${hidden} lines too many to show` : ''}`
            : `Show ${hidden} more ${hidden === 1 ? 'line' : 'lines'}`}
        </button>
      )}
    </div>
  );
}
