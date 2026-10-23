import {
  type Approval,
  type ApprovalState,
  parseToolCall,
  sessionDisplayName,
  sessionSubtitle,
  toolInputDetail,
} from '@c-board/protocol';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { langFor, type TokenLine, useHighlight } from '../claude/highlight.js';
import { DiffView } from '../claude/tools/DiffView.js';
import { buildHunk } from '../claude/tools/diff.js';
import { extensionOf, prettyJson } from '../claude/tools/results.js';
import { selectProject, selectSession, useBoard } from '../data/index.js';
import { dur, ease, slide, spring, useMotionLevel } from '../motion.js';
import { ClaudeOrb } from '../orb/ClaudeOrb.js';
import { finishCountdown, orbStateFor } from '../orb/model.js';
import { redactDeep } from '../redact/redact.js';
import { reveal, useMasked, useRedactOn } from '../redact/reveal.js';
import { ProjectAvatar } from '../shell/ProjectAvatar.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { DrawnCheck } from '../ui/DrawnCheck.js';
import { Kbd } from '../ui/Kbd.js';
import {
  type AttentionDecision,
  COLLAPSE_AT_MS,
  canAlwaysAllow,
  EXPIRE_FINISH_MS,
  RESOLVED_LABEL,
  relativeToProject,
} from './attention.js';

/** The protocol's limit on a deny reason. */
const MAX_REASON = 1_000;
const MAX_JSON_CHARS = 2_000;

export interface ApprovalCardProps {
  approval: Approval;
  /** Set once decided: the card shows the outcome, then collapses. */
  resolved: ApprovalState | null;
  selected: boolean;
  denying: boolean;
  busy: boolean;
  onSelect(): void;
  onDecide(decision: AttentionDecision, reason?: string): void;
  onDenyStart(): void;
  onDenyCancel(): void;
}

/**
 * One permission request, DESIGN.md §4.5: project chip, session orb, tool name and the exact
 * payload, with Allow (A), Always allow (⇧A) and Deny… (D, with an optional reason).
 */
export function ApprovalCard({
  approval,
  resolved,
  selected,
  denying,
  busy,
  onSelect,
  onDecide,
  onDenyStart,
  onDenyCancel,
}: ApprovalCardProps) {
  const session = useBoard(selectSession(approval.sessionId));
  const project = useBoard(selectProject(session?.projectId ?? ''));
  const title = session ? sessionDisplayName(session) : null;
  const subtitle = session ? sessionSubtitle(session) : null;
  const always = canAlwaysAllow(approval);
  const accent = project ? `var(--accent-${project.accent})` : undefined;
  const headingId = `approval-${approval.id}`;
  const level = useMotionLevel();
  const still = level !== 'full';

  // Allowed: once the check has drawn, the card collapses to its header and outcome (by
  // `layout`), then leaves. Reduced skips the collapse, which is movement.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (resolved !== 'allowed' || still) return;
    const timer = setTimeout(() => setCollapsed(true), COLLAPSE_AT_MS);
    return () => clearTimeout(timer);
  }, [resolved, still]);

  // The ring counts down while pending; an approval that expires early lets it run out.
  const countdown = useMemo(() => {
    if (approval.expiresAt === null) return null;
    const ring = { startedAt: approval.createdAt, endsAt: approval.expiresAt };
    if (resolved === 'expired') return finishCountdown(ring, Date.now(), EXPIRE_FINISH_MS);
    return resolved ? null : ring;
  }, [approval.createdAt, approval.expiresAt, resolved]);
  const layout = resolved === 'allowed' && !still;

  return (
    <motion.article
      layout={layout}
      transition={spring.smooth}
      style={{ borderRadius: 16 }}
      aria-labelledby={headingId}
      aria-current={selected || undefined}
      data-approval={approval.id}
      data-selected={selected || undefined}
      data-resolved={resolved ?? undefined}
      onClick={onSelect}
      // Selection follows the keyboard (↑↓, j/k), so it moves at once, like the palette's.
      className={cx(
        'relative flex flex-col gap-2.5 overflow-hidden rounded-panel border p-3',
        selected && !resolved ? 'border-line-strong bg-bg-2' : 'border-line bg-bg-1',
      )}
    >
      {resolved === 'allowed' && (
        <div aria-hidden className="pod-sweep">
          <div className="pod-sweep-band" />
        </div>
      )}
      <motion.header
        layout={layout && 'position'}
        transition={spring.smooth}
        className="flex min-w-0 items-center gap-2.5"
      >
        {project && <ProjectAvatar project={project} />}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 text-body-sm">
            <span className="min-w-0 truncate text-text-1" title={project?.name}>
              {project?.name ?? 'No project'}
            </span>
            {title && (
              <span className="min-w-0 truncate text-text-2" title={subtitle ?? title}>
                <span aria-hidden>&nbsp;·&nbsp;</span>
                {title}
              </span>
            )}
          </span>
          <span id={headingId} className="text-label text-st-wait-ink">
            Wants to run <span className="font-mono">{approval.tool}</span>
          </span>
        </span>
        {session && (
          <ClaudeOrb
            state={resolved === 'expired' ? 'waiting' : orbStateFor(session.status)}
            size={24}
            accent={accent}
            countdown={countdown}
            showToolLabel={false}
          />
        )}
      </motion.header>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="body"
            exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.out } }}
            className="flex flex-col gap-2.5"
          >
            <MaskedPayload approval={approval} projectPath={project?.path} />
            {approval.blockedPath && (
              <p className="text-meta text-text-2">
                Outside the allowed folders:{' '}
                <span className="break-all font-mono text-text-1">{approval.blockedPath}</span>
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {resolved ? (
        // The outcome slides in like a session caption.
        <motion.div
          layout={layout && 'position'}
          transition={spring.smooth}
          className="flex h-7 overflow-hidden"
        >
          <motion.p
            data-outcome={resolved}
            initial={{ opacity: 0, transform: slide(still, '80%') }}
            animate={{ opacity: 1, transform: slide(still, '0%'), transition: spring.snappy }}
            className={cx(
              'flex items-center gap-1.5 text-label',
              resolved === 'allowed' ? 'text-st-ok-ink' : 'text-text-2',
            )}
          >
            {resolved === 'allowed' ? (
              <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" strokeWidth={1.5}>
                <DrawnCheck draw />
              </svg>
            ) : (
              <X aria-hidden className="size-3.5" strokeWidth={2} />
            )}
            {RESOLVED_LABEL[resolved]}
          </motion.p>
        </motion.div>
      ) : denying ? (
        <DenyForm
          busy={busy}
          onDeny={(reason) => onDecide('deny', reason)}
          onCancel={onDenyCancel}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onDecide('allow')}>
            Allow
            {selected && <Shortcut keys="A" dark />}
          </Button>
          <Button
            size="sm"
            disabled={busy || !always}
            title={always ? undefined : 'No rule to save for this request'}
            onClick={() => onDecide('allowAlways')}
          >
            Always allow
            {selected && always && <Shortcut keys="⇧A" />}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDenyStart}>
            Deny…
            {selected && <Shortcut keys="D" />}
          </Button>
        </div>
      )}
    </motion.article>
  );
}

function Shortcut({ keys, dark = false }: { keys: string; dark?: boolean }) {
  return (
    <Kbd
      className={cx('ml-0.5 h-4 min-w-4 px-0.5', dark && 'border-transparent bg-bg-0/15 text-bg-0')}
    >
      <span className="sr-only">shortcut </span>
      {keys}
    </Kbd>
  );
}

function DenyForm({
  busy,
  onDeny,
  onCancel,
}: {
  busy: boolean;
  onDeny(reason: string): void;
  onCancel(): void;
}) {
  const [reason, setReason] = useState('');
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    // Leaves the denial, not the sheet.
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onDeny(reason.trim());
      }}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: D opens the field to type the reason straight away
        autoFocus
        value={reason}
        maxLength={MAX_REASON}
        onChange={(event) => setReason(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Reason for denying (optional)"
        placeholder="Reason (optional)"
        className="h-7 min-w-0 flex-1 rounded-control border border-line bg-bg-0 px-2 text-label text-text-1 placeholder:text-text-3 focus:border-line-strong"
      />
      <Button type="submit" size="sm" disabled={busy}>
        Deny
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

/** The payload with its secrets masked while the setting is on, and a reveal to check them. */
function MaskedPayload({ approval, projectPath }: { approval: Approval; projectPath?: string }) {
  const key = `approval:${approval.id}`;
  const on = useRedactOn();
  const masked = useMasked(key);
  const redacted = useMemo(
    () => (on ? redactDeep(approval.input) : approval.input),
    [on, approval.input],
  );
  if (redacted === approval.input) return <Payload approval={approval} projectPath={projectPath} />;
  return (
    <div className="flex flex-col gap-1">
      <Payload
        approval={masked ? { ...approval, input: redacted } : approval}
        projectPath={projectPath}
      />
      <button
        type="button"
        aria-pressed={!masked}
        onClick={() => reveal.toggle(key)}
        className="self-start rounded-chip px-1 text-meta text-text-3 transition-colors duration-fast hover:text-text-1"
      >
        {masked ? 'Secrets hidden · Reveal' : 'Hide secrets'}
      </button>
    </div>
  );
}

/** The exact payload: a highlighted command, a mini diff for edits, or the main argument. */
function Payload({ approval, projectPath }: { approval: Approval; projectPath?: string }) {
  const call = useMemo(() => parseToolCall(approval.tool, approval.input), [approval]);
  if (call.kind === 'bash') return <Command command={call.command} />;
  if (call.kind === 'edit' || call.kind === 'write') {
    const hunks =
      call.kind === 'write'
        ? [buildHunk('', call.content, 1)]
        : call.edits.map((e) => buildHunk(e.oldString, e.newString, null));
    return (
      <div className="overflow-hidden rounded-control border border-line bg-bg-0/60">
        <p className="truncate border-line border-b px-3 py-1 font-mono text-meta text-text-2">
          {relativeToProject(call.filePath, projectPath)}
        </p>
        <div className="max-h-48 overflow-auto">
          <DiffView
            id={`approval:${approval.id}`}
            hunks={hunks}
            lang={langFor(extensionOf(call.filePath))}
            layout="unified"
          />
        </div>
      </div>
    );
  }
  const detail = toolInputDetail(approval.input)?.trim();
  if (detail) {
    return (
      <code
        title={detail}
        className="line-clamp-3 break-all rounded-control bg-bg-0/60 px-2.5 py-1.5 font-mono text-label text-text-1"
      >
        {relativeToProject(detail, projectPath)}
      </code>
    );
  }
  const json = prettyJson(approval.input);
  return (
    <pre className="max-h-40 overflow-auto rounded-control bg-bg-0/60 px-2.5 py-1.5 font-mono text-label text-text-1">
      {json.length > MAX_JSON_CHARS ? `${json.slice(0, MAX_JSON_CHARS)}…` : json}
    </pre>
  );
}

function Command({ command }: { command: string }) {
  const lines = useHighlight(command, 'shellscript');
  return (
    <pre
      data-command
      className="max-h-40 overflow-auto rounded-control bg-bg-0/60 px-2.5 py-1.5 font-mono text-label leading-5 whitespace-pre-wrap break-all text-text-1"
    >
      <span aria-hidden className="select-none text-text-3">
        ${' '}
      </span>
      {command.split('\n').map((line, i, all) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
        <span key={i}>
          <Tokens text={line} tokens={lines?.[i]} />
          {i < all.length - 1 && '\n'}
        </span>
      ))}
    </pre>
  );
}

function Tokens({ text, tokens }: { text: string; tokens: TokenLine | undefined }) {
  if (!tokens || tokens.map((t) => t[0]).join('') !== text) return text;
  return tokens.map(([content, color], i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
    <span key={i} style={color ? { color } : undefined}>
      {content}
    </span>
  ));
}
