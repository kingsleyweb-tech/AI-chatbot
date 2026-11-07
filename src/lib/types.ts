import type { Timestamp } from 'firebase/firestore';
import type { ApprovalRequest, Attachment, MemoryCategory, MessageStatus, ResearchStep, RouteInfo, SearchInfo, Source, UsageInfo } from '@shared/types';

export type { ApprovalRequest, Attachment, MemoryCategory, MessageStatus, ResearchStep, RouteInfo, SearchInfo, Source, UsageInfo };

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
  email: string | null;
  displayName: string;
  photoURL?: string | null;
  createdAt?: Timestamp;
  settings?: Partial<UserSettings>;
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
  error?: { code: string; message: string; suggestion?: string | null } | null;
  createdAt?: Timestamp | null;
  editedAt?: Timestamp | null;
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
  createdAt?: Timestamp | null;
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
}
