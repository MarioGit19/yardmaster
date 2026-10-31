import { toolInputDetail } from '@yardmaster/protocol';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useBoardClient, useBoardStore } from '../data/index.js';
import { pushIdStore } from '../push/push.js';
import {
  approvalHeadline,
  attentionOpen,
  notificationsPreference,
  openInboxItem,
  relativeToProject,
} from './attention.js';

/**
 * Tells the user about new approvals wherever they are, DESIGN.md §8: a toast (unless the
 * Attention Center is already open), a polite screen-reader announcement, and a browser
 * notification while the tab is in the background, if turned on in Settings.
 */
export function AttentionAlerts() {
  const client = useBoardClient();
  const store = useBoardStore();
  const [announcement, setAnnouncement] = useState('');
  // Approval toasts on screen. Opening the Attention Center puts them away: it lists the same
  // approvals, and on a phone its sheet would sit under them.
  const shown = useRef(new Set<string>());

  useEffect(
    () =>
      attentionOpen.subscribe(() => {
        if (attentionOpen.get() !== 'open') return;
        for (const id of shown.current) toast.dismiss(id);
        shown.current.clear();
      }),
    [],
  );

  useEffect(
    () =>
      client.onMessage((message) => {
        if (message.type === 'approval.resolved') {
          toast.dismiss(message.payload.approvalId);
          shown.current.delete(message.payload.approvalId);
          return;
        }
        if (message.type !== 'approval.new') return;
        const { approval } = message.payload;
        const { board } = store.getState();
        const projectId = board.sessions[approval.sessionId]?.projectId;
        const project = projectId ? board.projects[projectId] : undefined;
        const headline = approvalHeadline(approval, project);
        const raw = toolInputDetail(approval.input)?.trim();
        const detail = raw ? relativeToProject(raw, project?.path) : undefined;

        setAnnouncement(`Approval needed: ${headline}${detail ? `: ${detail}` : ''}`);
        if (attentionOpen.get() !== 'open') {
          toast.warning(headline, {
            id: approval.id,
            description: detail,
            action: { label: 'Review', onClick: () => openInboxItem(approval.id) },
            onDismiss: () => shown.current.delete(approval.id),
            onAutoClose: () => shown.current.delete(approval.id),
          });
          shown.current.add(approval.id);
        }
        notify(approval.id, headline, detail);
      }),
    [client, store],
  );

  return (
    <div aria-live="polite" data-attention-live className="sr-only">
      {announcement}
    </div>
  );
}

function notify(tag: string, title: string, body: string | undefined): void {
  if (notificationsPreference.get() !== 'on') return;
  // With Web Push on, the board's own notification comes from the service worker instead.
  if (pushIdStore.get() !== null) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      window.focus();
      openInboxItem(tag);
      notification.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker; the toast still shows.
  }
}
