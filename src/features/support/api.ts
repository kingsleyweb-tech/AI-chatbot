import { api } from '@/lib/api';
import { compressImage } from '@/lib/image';
import {
  SUPPORT_FILE_TYPES,
  SUPPORT_LIMITS,
  type SupportActivityView,
  type SupportCategory,
  type SupportMessageView,
  type SupportNoteView,
  type SupportPriority,
  type SupportReportAdminView,
  type SupportReportView,
  type SupportStats,
  type SupportStatus,
} from '@shared/support';

export interface NewAttachment {
  name: string;
  dataUrl: string;
}
export interface Thread {
  report: SupportReportView;
  messages: SupportMessageView[];
}
export interface AdminThread {
  report: SupportReportAdminView;
  messages: SupportMessageView[];
  notes: SupportNoteView[];
  activity: SupportActivityView[];
}

const call = <T>(json: object) => api<T>('support', { json });

export const supportApi = {
  create: (b: { title: string; category: SupportCategory; description: string; attachments: NewAttachment[]; submissionId: string }) =>
    call<{ ref: string; duplicate: boolean }>({ action: 'create', ...b }),
  mine: () => call<{ reports: SupportReportView[] }>({ action: 'mine' }),
  get: (ref: string) => call<Thread>({ action: 'get', ref }),
  message: (ref: string, text: string, attachments: NewAttachment[]) => call<Thread>({ action: 'message', ref, text, attachments }),
  confirm: (ref: string) => call<Thread>({ action: 'confirm', ref }),
  reopen: (ref: string) => call<Thread>({ action: 'reopen', ref }),
  attachment: (ref: string, id: string) => call<{ name: string; mime: string; dataUrl: string }>({ action: 'attachment', ref, id }),

  adminList: () => call<{ reports: SupportReportAdminView[]; stats: SupportStats; admins: string[] }>({ action: 'adminList' }),
  adminGet: (ref: string) => call<AdminThread & { admins: string[] }>({ action: 'adminGet', ref }),
  adminReply: (ref: string, text: string, attachments: NewAttachment[], requestInfo: boolean) => call<AdminThread>({ action: 'adminReply', ref, text, attachments, requestInfo }),
  adminStatus: (ref: string, status: SupportStatus) => call<AdminThread>({ action: 'adminStatus', ref, status }),
  adminPriority: (ref: string, priority: SupportPriority) => call<AdminThread>({ action: 'adminPriority', ref, priority }),
  adminAssign: (ref: string, assignee: string | null) => call<AdminThread>({ action: 'adminAssign', ref, assignee }),
  adminNote: (ref: string, text: string) => call<AdminThread>({ action: 'adminNote', ref, text }),
  adminDelete: (ref: string, confirmRef: string) => call<{ ok: true }>({ action: 'adminDelete', ref, confirmRef }),
  adminNotificationsRead: (ids: string[]) => call<{ ok: true }>({ action: 'adminNotificationsRead', ids }),
  helpSave: (a: { id: string; title: string; category: string; summary: string; body: string; keywords?: string[] }) => call<{ ok: true }>({ action: 'helpSave', ...a }),
  helpRemove: (id: string, mode: 'remove' | 'restore') => call<{ ok: true }>({ action: 'helpRemove', id, mode }),
};

/** Check and compress a screenshot in the browser; the server validates it again. */
export async function prepareScreenshot(file: File): Promise<NewAttachment> {
  const typeOk = SUPPORT_FILE_TYPES.includes(file.type) || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(file.name);
  if (!typeOk) throw new Error(`${file.name} is not an image. Attach PNG, JPEG, WebP, GIF or HEIC screenshots.`);
  if (file.size > SUPPORT_LIMITS.fileBytes) throw new Error(`${file.name} is larger than 10 MB.`);
  const img = await compressImage(file, 1400, 0.8);
  if (img.dataUrl.length > SUPPORT_LIMITS.attachmentChars) throw new Error(`${file.name} is too detailed to attach. Try cropping it.`);
  return { name: img.name, dataUrl: img.dataUrl };
}

export function submissionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
