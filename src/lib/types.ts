import type { Timestamp } from 'firebase/firestore';
import type { ApprovalRequest, Attachment, GeneratedImageInfo, MemoryCategory, MessageStatus, ResearchStep, RouteInfo, SearchInfo, Source, UsageInfo } from '@shared/types';

export type { ApprovalRequest, Attachment, GeneratedImageInfo, MemoryCategory, MessageStatus, ResearchStep, RouteInfo, SearchInfo, Source, UsageInfo };

export type Theme = 'light' | 'dark' | 'system';
export type Accent = 'teal' | 'cyan' | 'emerald' | 'blue' | 'amber' | 'graphite';

export interface UserSettings {
  theme: Theme;
  accent: Accent;
  defaultModel: string | null;
  customInstructions: string;
  aboutMe: string;
  responseStyle: 'balanced' | 'concise' | 'detailed';
  tone: 'professional' | 'casual' | 'friendly';
  technicalLevel: 'beginner' | 'intermediate' | 'expert';
  language: string;
  memoryEnabled: boolean;
  webSearchDefault: boolean;
  /** search automatically when a message clearly needs current information */
  autoSearch: boolean;
  /** auto (default): search only when needed; manual: only when asked; eager: whenever it may help */
  searchMode: 'auto' | 'manual' | 'eager';
  sendOnEnter: boolean;
  voiceName: string | null;
}

export const DEFAULT_SETTINGS: UserSettings = {
  theme: 'system',
  accent: 'teal',
  defaultModel: null,
  customInstructions: '',
  aboutMe: '',
  responseStyle: 'balanced',
  tone: 'professional',
  technicalLevel: 'intermediate',
  language: 'auto',
  memoryEnabled: true,
  webSearchDefault: false,
  autoSearch: true,
  searchMode: 'auto',
  sendOnEnter: true,
  voiceName: null,
};

export interface UserProfile {
  uid?: string;
  email: string | null;
  displayName: string;
  photoURL?: string | null;
  /** sign-in method last used: password, google.com, apple.com */
  provider?: string;
  /** set by the server after SMS verification */
  phoneNumber?: string | null;
  phoneVerified?: boolean;
  phoneVerifiedAt?: Timestamp;
  emailVerified?: boolean;
  accountCreatedAt?: string;
  lastLoginAt?: Timestamp;
  accountStatus?: string;
  createdAt?: Timestamp;
  settings?: Partial<UserSettings>;
  /** "Secure your account" reminder: when it was last skipped, and when it may show again (ms) */
  phoneReminderDismissedAt?: Timestamp;
  phoneReminderNextAt?: number | null;
}

export interface Conversation {
  id: string;
  title: string;
  titleSet?: boolean;
  projectId: string | null;
  saved: boolean;
  model?: string | null;
  lastModel?: string | null;
  documentIds?: string[];
  messageCount?: number;
  summary?: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
  model?: string;
  status?: MessageStatus;
  sources?: Source[];
  notices?: string[];
  search?: SearchInfo | null;
  researchSteps?: ResearchStep[];
  route?: RouteInfo | null;
  approval?: ApprovalRequest | null;
  usage?: UsageInfo | null;
  reasoning?: string | null;
  /** pictures created by Atlas AI for this reply (bytes stored separately, see features/images) */
  images?: GeneratedImageInfo[];
  error?: { code: string; message: string; suggestion?: string | null } | null;
  /** which context sources the server used for this reply */
  contextUsed?: ContextUsed | null;
  createdAt?: Timestamp | null;
  editedAt?: Timestamp | null;
}

export interface ContextUsed {
  memories: number;
  documents: number;
  conversations: number;
  knowledge: number;
  web: number;
}

export type KbScope = 'personal' | 'shared';

export interface KbCollection {
  id: string;
  name: string;
  description?: string;
  createdAt?: Timestamp | null;
}

export interface KbSourceMeta {
  id: string;
  collectionId: string;
  title: string;
  type: 'file' | 'url' | 'note';
  fileName?: string;
  mime?: string;
  size?: number;
  url?: string;
  status: 'processing' | 'ready' | 'failed';
  error?: string | null;
  warning?: string | null;
  chunkCount?: number;
  charCount?: number;
  embeddingModel?: string | null;
  confidential?: boolean;
  aiAllowed?: boolean;
  addedFrom?: 'upload' | 'manual' | 'web_search';
  refreshDays?: number | null;
  indexedAt?: string;
  refreshedAt?: string;
  /** manual entries keep their text so they can be edited */
  noteText?: string;
  createdAt?: Timestamp | null;
}

export interface Memory {
  id: string;
  text: string;
  category: MemoryCategory;
  reason: string;
  active: boolean;
  origin: 'auto' | 'manual';
  sourceConversationId?: string | null;
  sourceTitle?: string | null;
  /** 1 (minor) to 5 (always relevant); missing means 3 */
  importance?: number;
  /** project-memory key (p_slug) when the memory belongs to one project */
  project?: string | null;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

/** Automatic project brief (users/{uid}/projectMemory/{key}), written by the server. */
export interface ProjectBrief {
  id: string;
  name: string;
  aliases?: string[];
  linkedProjectId?: string | null;
  description?: string;
  technologies?: string[];
  architecture?: string;
  progress?: string;
  decisions?: string[];
  bugs?: string[];
  tasks?: string[];
  conversations?: { id: string; title: string; at: number }[];
  origin?: 'auto' | 'manual';
  updatedAt?: Timestamp | null;
}

export interface Project {
  id: string;
  name: string;
  instructions: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface DocumentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  status: 'processing' | 'ready' | 'failed';
  error?: string | null;
  chunkCount?: number;
  charCount?: number;
  pageCount?: number;
  createdAt?: Timestamp | null;
}

export interface SavedResponse {
  id: string;
  conversationId: string;
  messageId: string;
  content: string;
  model?: string | null;
  conversationTitle?: string;
  createdAt?: Timestamp | null;
}

export interface UsageDay {
  id: string;
  date: string;
  requests?: number;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
  models?: Record<string, { requests?: number; tokens?: number }>;
  /** per AI provider (gemini, openrouter) */
  providers?: Record<string, { requests?: number; tokens?: number; failed?: number; rateLimited?: number }>;
  routing?: { fallbacks?: number; providerSwitches?: number; switched?: number };
  /** per search provider (serpapi, tavily) */
  search?: Record<string, { requests?: number; cached?: number; failed?: number; credits?: number }>;
  /** decision engine outcomes: none/search/extract/research counts, plus reasons */
  searchDecisions?: Record<string, number | Record<string, number> | undefined> & { reasons?: Record<string, number> };
  knowledge?: { retrievals?: number; used?: number; hits?: number };
}
