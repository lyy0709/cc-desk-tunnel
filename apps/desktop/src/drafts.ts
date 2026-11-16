import { useCallback, useEffect, useRef, useState } from 'react';
import { fileAttachmentSchema, pathKey } from '@cc-desk-tunnel/protocol';
import type { FileAttachment } from '@cc-desk-tunnel/protocol';

// Unsent text is the user's work: it is kept per session and written to disk shortly after every edit,
// so switching sessions, closing the window or a crash does not lose it.
export type Draft = {
  text: string;
  attachments: FileAttachment[];
  // In-flight local reads belong to the draft's session, but do not survive a window restart.
  adding?: number;
  attachmentError?: string;
  insertions?: { id: string; offset: number }[];
  cursor?: number;
};
export type Drafts = Record<string, Draft>;
export const emptyDraft: Draft = { text: '', attachments: [] };
const storageKey = 'proxy-drafts';
const delay = 300;

// Keep a pending file pick at its place while the user edits, including after switching sessions.
export function changeDraftText(draft: Draft, text: string): Draft {
  if (!draft.insertions?.length) return { ...draft, text, cursor: undefined };
  let start = 0;
  while (start < draft.text.length && start < text.length && draft.text[start] === text[start])
    start++;
  let oldEnd = draft.text.length,
    newEnd = text.length;
  while (oldEnd > start && newEnd > start && draft.text[oldEnd - 1] === text[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return {
    ...draft,
    text,
    cursor: undefined,
    insertions: draft.insertions.map((point) => ({
      ...point,
      offset:
        point.offset <= start
          ? point.offset
          : point.offset >= oldEnd
            ? point.offset + newEnd - oldEnd
            : newEnd,
    })),
  };
}

export function insertDraftFiles(draft: Draft, files: FileAttachment[], offset: number): Draft {
  const key = (file: FileAttachment) => `${file.deviceId}:${pathKey(file.path)}`;
  const attachments = new Map(draft.attachments.map((file) => [key(file), file]));
  const used = new Set(draft.attachments.map((file) => file.reference));
  let number = 1;
  const references = new Set<string>();
  for (const added of files) {
    const existing = attachments.get(key(added)) ?? added;
    while (used.has(number) || draft.text.includes(`[文件 #${number}]`)) number++;
    const file = existing.reference ? existing : { ...existing, reference: number };
    used.add(file.reference);
    attachments.set(key(file), file);
    references.add(`[文件 #${file.reference}]`);
  }
  const text = [...references].join(' ');
  return {
    ...changeDraftText(draft, draft.text.slice(0, offset) + text + draft.text.slice(offset)),
    attachments: [...attachments.values()],
    cursor: offset + text.length,
  };
}

export function cleanDrafts(value: unknown): Drafts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, saved]) => {
      if (typeof saved === 'string') return [[id, { text: saved, attachments: [] }]];
      if (
        !saved ||
        typeof saved !== 'object' ||
        !('text' in saved) ||
        typeof saved.text !== 'string'
      )
        return [];
      const files = fileAttachmentSchema
        .array()
        .safeParse('attachments' in saved ? saved.attachments : []);
      return [[id, { text: saved.text, attachments: files.success ? files.data : [] }]];
    }),
  );
}
export function withoutSentDraft(current: Draft, sent: Draft): Draft {
  return {
    ...current,
    text: current.text === sent.text ? '' : current.text,
    attachments: current.attachments.filter((file) => !sent.attachments.includes(file)),
    ...(sent.attachmentError && current.attachmentError === sent.attachmentError
      ? { attachmentError: '' }
      : {}),
  };
}
async function load(): Promise<Drafts> {
  try {
    if (window.desktop) return cleanDrafts(await window.desktop.loadDrafts());
    return cleanDrafts(JSON.parse(localStorage.getItem(storageKey) ?? '{}'));
  } catch {
    return {};
  }
}
function store(drafts: Drafts) {
  const saved = Object.fromEntries(
    Object.entries(drafts)
      .filter(([, draft]) => draft.text || draft.attachments.length)
      .map(([id, { text, attachments }]) => [id, { text, attachments }]),
  );
  if (window.desktop) void window.desktop.saveDrafts(saved).catch(() => {});
  else localStorage.setItem(storageKey, JSON.stringify(saved));
}

export function useDrafts() {
  const [drafts, setDrafts] = useState<Drafts>({});
  const latest = useRef(drafts);
  const loaded = useRef(false);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(() => {
    if (pending.current === undefined) return;
    clearTimeout(pending.current);
    pending.current = undefined;
    store(latest.current);
  }, []);
  const change = useCallback(
    (update: (drafts: Drafts) => Drafts) => {
      setDrafts((current) => {
        const next = update(current);
        latest.current = next;
        return next;
      });
      // Nothing is written before the saved drafts are read, or they would be replaced by a partial set.
      if (!loaded.current) return;
      clearTimeout(pending.current);
      pending.current = setTimeout(flush, delay);
    },
    [flush],
  );
  useEffect(() => {
    void load().then((saved) => {
      loaded.current = true;
      // Text typed while the saved drafts were being read wins over what was saved.
      change((current) => ({ ...saved, ...current }));
    });
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [change, flush]);
  const updateDraft = useCallback(
    (sessionId: string, update: (draft: Draft) => Draft) =>
      change((current) => ({
        ...current,
        [sessionId]: update(current[sessionId] ?? emptyDraft),
      })),
    [change],
  );
  const setDraft = useCallback(
    (sessionId: string, text: string, attachments?: FileAttachment[]) =>
      updateDraft(sessionId, (current) => ({
        ...changeDraftText(current, text),
        attachments: attachments ?? current.attachments,
      })),
    [updateDraft],
  );
  return [drafts, setDraft, updateDraft] as const;
}
