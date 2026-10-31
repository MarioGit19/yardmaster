import type { SearchHit, SearchIndexStatus, SearchResponse } from '@yardmaster/protocol';
import { SEARCH_STATUSES } from '@yardmaster/protocol';
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { selectProjects, useBoardList } from '../data/index.js';
import { useRedactOn } from '../redact/reveal.js';
import { searchSessionHref } from '../routes.js';
import { api } from '../settings/api.js';
import { formatDateTime, formatWhen } from '../time.js';
import { Skeleton } from '../ui/Skeleton.js';
import { EmptyState, Page, PageHeader } from '../views/Page.js';
import { Segmented } from '../views/SettingsView.js';
import {
  maskedSnippet,
  SEARCH_DATE_LABEL,
  SEARCH_DATES,
  SEARCH_STATUS_LABEL,
  type SearchDraft,
  searchDraft,
  searchParams,
} from './model.js';

const TYPING_MS = 200;
const PAGE = 40;
const STATUS_POLL_MS = 2_000;

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  user: 'You',
  assistant: 'Claude',
  tool_use: 'Tool call',
  tool_result: 'Tool output',
};

type Results =
  | { status: 'idle' }
  | { status: 'loading'; previous: SearchResponse | null }
  | { status: 'error' }
  | { status: 'ready'; response: SearchResponse };

/** Runs the search as filters change, after a pause in the typing. */
function useSearch(filters: SearchDraft, limit: number): Results {
  const [results, setResults] = useState<Results>({ status: 'idle' });
  useEffect(() => {
    const params = searchParams(filters, limit, Date.now());
    if (params === null) {
      setResults({ status: 'idle' });
      return;
    }
    setResults((prev) => ({
      status: 'loading',
      previous:
        prev.status === 'ready' ? prev.response : prev.status === 'loading' ? prev.previous : null,
    }));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.search(params, controller.signal).then(
        (response) => setResults({ status: 'ready', response }),
        () => {
          if (!controller.signal.aborted) setResults({ status: 'error' });
        },
      );
    }, TYPING_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filters, limit]);
  return results;
}

/** The index's own state, followed while it's working. */
export function useSearchIndex(): SearchIndexStatus | null {
  const [status, setStatus] = useState<SearchIndexStatus | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = () => {
      api.searchIndex(controller.signal).then(
        (next) => {
          setStatus(next);
          if (next.indexing) timer = setTimeout(load, STATUS_POLL_MS);
        },
        () => {},
      );
    };
    load();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);
  return status;
}

/** Search across every transcript: words, then project, date and status. */
export function SearchView() {
  const filters = searchDraft.use();
  const projects = useBoardList(selectProjects);
  const [limit, setLimit] = useState(PAGE);
  const results = useSearch(filters, limit);
  const index = useSearchIndex();
  const input = useRef<HTMLInputElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new filters start a new list
  useEffect(() => setLimit(PAGE), [filters]);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);

  const response =
    results.status === 'ready'
      ? results.response
      : results.status === 'loading'
        ? results.previous
        : null;
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Page width="narrow">
      <PageHeader title="Search" meta={<IndexLine index={index} />} />
      <div className="flex flex-col gap-3">
        <label className="flex h-11 items-center gap-2 rounded-control border border-line bg-bg-1 px-3 transition-colors duration-fast focus-within:border-line-strong">
          <Search aria-hidden className="size-4 shrink-0 text-text-3" strokeWidth={1.5} />
          <span className="sr-only">Search every transcript</span>
          <input
            ref={input}
            type="search"
            value={filters.query}
            onChange={(e) => searchDraft.set({ query: e.target.value })}
            placeholder="Search what you and Claude said"
            maxLength={200}
            data-search-input
            className="h-full min-w-0 flex-1 bg-transparent text-body text-text-1 outline-none placeholder:text-text-3 focus-visible:shadow-none"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2" data-search-filters>
          <select
            aria-label="Project"
            data-search-project
            value={filters.projectId}
            onChange={(e) => searchDraft.set({ projectId: e.target.value })}
            className="h-8 min-w-0 max-w-48 cursor-pointer rounded-control border border-line bg-bg-0 px-2 text-label text-text-1 touch:h-11"
          >
            <option value="">All projects</option>
            {sorted.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <Segmented
            label="Date"
            options={SEARCH_DATES}
            labels={SEARCH_DATE_LABEL}
            value={filters.date}
            onChange={(date) => searchDraft.set({ date })}
          />
          <Segmented
            label="Status"
            options={SEARCH_STATUSES}
            labels={SEARCH_STATUS_LABEL}
            value={filters.status}
            onChange={(status) => searchDraft.set({ status })}
          />
        </div>
      </div>
      <div className="mt-6" aria-live="polite" data-search-results>
        {results.status === 'idle' ? (
          <EmptyState title="Search every transcript">
            Your messages and Claude’s replies, across all your projects. This stays on your
            computer.
          </EmptyState>
        ) : results.status === 'error' ? (
          <EmptyState title="Search didn’t work">Try again in a moment.</EmptyState>
        ) : response === null ? (
          <div aria-busy className="flex flex-col gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3.5 w-11/12" />
              </div>
            ))}
          </div>
        ) : response.hits.length === 0 ? (
          results.status === 'ready' && (
            <EmptyState title="Nothing found">
              {index?.indexing
                ? 'Still reading your transcripts, so more may turn up.'
                : 'Try fewer words, or widen the filters.'}
            </EmptyState>
          )
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-line rounded-panel border border-line bg-bg-1">
              {response.hits.map((hit) => (
                <li key={`${hit.sessionId}:${hit.messageId}`}>
                  <HitRow hit={hit} />
                </li>
              ))}
            </ul>
            {response.more && limit < 100 && (
              <button
                type="button"
                onClick={() => setLimit(100)}
                className="mt-2 rounded-control text-meta text-text-2 transition-colors duration-fast hover:text-text-1 touch:min-h-11"
              >
                Show more
              </button>
            )}
          </>
        )}
      </div>
    </Page>
  );
}

function IndexLine({ index }: { index: SearchIndexStatus | null }) {
  if (index === null) return null;
  const sessions = `${index.messages.toLocaleString()} messages in ${index.sessions.toLocaleString()} sessions`;
  return <span data-search-index>{index.indexing ? `Indexing… ${sessions}` : sessions}</span>;
}

function HitRow({ hit }: { hit: SearchHit }) {
  const masked = useRedactOn();
  const now = Date.now();
  return (
    <Link
      href={searchSessionHref(hit.sessionId, hit.messageId)}
      data-search-hit={hit.messageId}
      className="flex min-w-0 flex-col gap-1 px-4 py-3 transition-colors duration-fast first:rounded-t-panel last:rounded-b-panel hover:bg-bg-2 focus-visible:bg-bg-2"
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate font-medium text-body-sm text-text-1" title={hit.title}>
          {hit.title}
        </span>
        {hit.projectName && (
          <span className="min-w-0 shrink-[2] truncate text-meta text-text-2">
            {hit.projectName}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-baseline gap-1.5 text-meta text-text-3">
          {hit.state !== 'finished' && <span>{SEARCH_STATUS_LABEL[hit.state]}</span>}
          {hit.ts !== null && (
            <time
              className="tabular"
              dateTime={new Date(hit.ts).toISOString()}
              title={formatDateTime(hit.ts)}
            >
              {formatWhen(hit.ts, now)}
            </time>
          )}
        </span>
      </span>
      <span dir="auto" className="search-snippet line-clamp-2 text-body-sm text-text-2">
        <span className="text-text-3">{KIND_LABEL[hit.kind]}: </span>
        {maskedSnippet(hit.snippet, masked).map((run, i) =>
          run.hit ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
            <mark key={i}>{run.text}</mark>
          ) : (
            run.text
          ),
        )}
      </span>
    </Link>
  );
}
