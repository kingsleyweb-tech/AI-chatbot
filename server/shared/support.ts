/**
 * Support reports: values shared by the browser and the server.
 * Kept free of Node-only imports so the client can use it.
 */

export const SUPPORT_CATEGORIES = [
  { id: 'bug', label: 'Bug or technical issue' },
  { id: 'login', label: 'Login and authentication' },
  { id: 'ai_response', label: 'AI response or model issue' },
  { id: 'documents', label: 'File upload or document analysis' },
  { id: 'image_generation', label: 'Image generation' },
  { id: 'web_search', label: 'Web search or research' },
  { id: 'memory', label: 'Memory and conversation history' },
  { id: 'account', label: 'Account and security' },
  { id: 'feature_request', label: 'Feature request' },
  { id: 'feedback', label: 'General feedback' },
  { id: 'other', label: 'Other' },
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number]['id'];
export const CATEGORY_IDS = SUPPORT_CATEGORIES.map((c) => c.id) as [SupportCategory, ...SupportCategory[]];

export const SUPPORT_STATUSES = [
  { id: 'new', label: 'New' },
  { id: 'pending', label: 'Pending' },
  { id: 'under_review', label: 'Under review' },
  { id: 'awaiting_user', label: 'Awaiting your response' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'closed', label: 'Closed' },
] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number]['id'];
export const STATUS_IDS = SUPPORT_STATUSES.map((s) => s.id) as [SupportStatus, ...SupportStatus[]];

export const SUPPORT_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUPPORT_LIMITS = {
  title: 120,
  description: 2000,
  message: 2000,
  note: 2000,
  /** images per report or message */
  attachments: 3,
  /** base64 data URL length of one compressed image (Firestore documents are capped at 1 MiB) */
  attachmentChars: 950_000,
  /** original file size accepted by the picker, before compression */
  fileBytes: 10 * 1024 * 1024,
  /** new reports per account per day */
  reportsPerDay: 10,
} as const;

/** Image types the picker accepts; every image is re-encoded as JPEG before upload. */
export const SUPPORT_FILE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];

export const categoryLabel = (id: string) => SUPPORT_CATEGORIES.find((c) => c.id === id)?.label ?? 'Other';
export const statusLabel = (id: string, admin = false) =>
  id === 'awaiting_user' && admin ? 'Awaiting user response' : (SUPPORT_STATUSES.find((s) => s.id === id)?.label ?? id);
export const priorityLabel = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

export interface SupportAttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** A report as returned to its owner (no internal fields). */
export interface SupportReportView {
  ref: string;
  title: string;
  category: SupportCategory;
  description: string;
  status: SupportStatus;
  createdAt: number;
  updatedAt: number;
  attachments: SupportAttachmentRef[];
  lastAdminReply: { text: string; at: number } | null;
  userConfirmedAt: number | null;
}

/** Admin view adds user details, triage fields and counts. */
export interface SupportReportAdminView extends SupportReportView {
  uid: string;
  userName: string;
  userEmail: string;
  priority: SupportPriority;
  assignedTo: string | null;
  messageCount: number;
  lastMessageBy: 'user' | 'admin' | null;
}

export interface SupportMessageView {
  id: string;
  author: 'user' | 'admin' | 'system';
  /** "Atlas Support" for admins, so individual admin emails are not shown to users */
  authorName: string;
  kind: 'message' | 'status' | 'info_request';
  text: string;
  attachments: SupportAttachmentRef[];
  at: number;
}

export interface SupportNoteView {
  id: string;
  text: string;
  adminEmail: string | null;
  at: number;
}

export interface SupportActivityView {
  id: string;
  type: string;
  detail: string | null;
  byEmail: string | null;
  at: number;
}

export interface SupportStats {
  total: number;
  new: number;
  pending: number;
  underReview: number;
  awaitingUser: number;
  resolved: number;
  closed: number;
  featureRequests: number;
}

export type NotificationKind = 'reply' | 'status' | 'resolved' | 'info_request' | 'new_report' | 'user_message' | 'high_priority';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** in-app link, e.g. /support/ATL-2611-7KQ3M */
  link: string;
  ref: string;
  /** how many events this notification stands for (repeat events update one notification) */
  count: number;
  at: number;
  read: boolean;
}
