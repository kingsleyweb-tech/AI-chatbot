/**
 * Atlas Central Knowledge: a platform-wide repository of verified facts, kept apart from every
 * user's own data. Records are written only by the server; no client can read these collections
 * directly (the catch-all Firestore rule allows the server identity only).
 *
 *   kcRecords/{id}        knowledge records (PENDING | VERIFIED | REJECTED | ARCHIVED)
 *   kcCategories/{id}     administrator-managed categories
 *   kcAudit/{id}          who did what, when (no record content)
 *   kcStats/{yyyy-mm-dd}  daily counters (submissions, assessments, approvals, retrievals ...)
 *   kcTopics/{hash}       opt-in, aggregated question topics: three keywords and a count, no text,
 *                         no user ids
 *   kcDiscovery/{hash}    opt-in queue of public source addresses seen in web-searched answers
 *   config/knowledge      roles, review policies and discovery settings
 *
 * Only VERIFIED records are ever retrieved for answers.
 */
import type { Tier } from '../news/sources.js';

export type RecordStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'ARCHIVED';
export const STATUSES: RecordStatus[] = ['PENDING', 'VERIFIED', 'REJECTED', 'ARCHIVED'];

/** where a candidate came from; never a conversation's text */
export type Origin = 'admin' | 'url' | 'web_discovery';

export type Flag =
  | 'pii_redacted'
  | 'duplicate_suspected'
  | 'source_unreachable'
  | 'source_unsupported'
  | 'low_credibility'
  | 'no_sources'
  | 'conflict_suspected'
  | 'review_due'
  | 'ai_unavailable';

export interface RecordSource {
  url: string;
  title: string;
  publisher: string;
  tier: Tier;
  addedAt: number;
  /** last reachability check */
  checkedAt: number | null;
  reachable: boolean | null;
  /** the page mentions the record's key terms */
  supports: boolean | null;
}

export interface Assessment {
  at: number;
  by: 'ai' | 'rules';
  /** 0..1: how likely the content is accurate, given its sources */
  score: number;
  verdict: 'likely_accurate' | 'uncertain' | 'likely_inaccurate';
  reasons: string[];
  uncertainties: string[];
  suggestedCategory: string | null;
}

export interface KRecord {
  title: string;
  content: string;
  categoryId: string | null;
  tags: string[];
  status: RecordStatus;
  /** 0..1, computed from source credibility, support, assessment and flags */
  confidence: number;
  sources: RecordSource[];
  origin: Origin;
  assessment: Assessment | null;
  flags: Flag[];
  /** a near-identical record that already exists */
  duplicateOf: string | null;
  mergedFrom: string[];
  contentHash: string;
  /** distinct index terms, space separated */
  terms: string;
  vector: string | null;
  vectorModel: string | null;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  verifiedAt: number | null;
  verifiedBy: string | null;
  reviewAt: number | null;
  rejectedReason: string | null;
  version: number;
}

export interface Category {
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export type Permission = 'view' | 'submit' | 'edit' | 'review' | 'delete' | 'categories' | 'intelligence';
export const PERMISSIONS: Permission[] = ['view', 'submit', 'edit', 'review', 'delete', 'categories', 'intelligence'];

export interface CentralConfig {
  /** knowledge administrators by lower-case email, with their permissions */
  admins: Record<string, Permission[]>;
  /** default days between reviews of a verified record */
  reviewDays: number;
  categoryReviewDays: Record<string, number>;
  /** answers may use verified records */
  retrievalEnabled: boolean;
  /** queue public sources seen in web-searched answers for review (no conversation text) */
  discoveryFromWebSearch: boolean;
  /** discovery items processed per day by the maintenance job */
  discoveryDailyCap: number;
  /** count anonymous question topics (three keywords, no text, no user) for gap analysis */
  topicInsights: boolean;
  /** AI assessments per day (each is one free utility-model call) */
  assessmentsDailyCap: number;
}

export const DEFAULT_CONFIG: CentralConfig = {
  admins: {},
  reviewDays: 180,
  categoryReviewDays: {},
  retrievalEnabled: true,
  discoveryFromWebSearch: false,
  discoveryDailyCap: 10,
  topicInsights: false,
  assessmentsDailyCap: 200,
};

export interface Actor {
  uid: string;
  email: string | null;
}
