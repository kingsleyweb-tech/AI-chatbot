/**
 * One authenticated API request: who is calling (integration, key, end user), what it may do,
 * which environment it runs in and what it used. Built only from the verified key and trusted
 * server configuration; nothing here comes from the request body.
 */
import type { Firestore } from '../firestore.js';
import { HttpError } from '../http.js';
import type { EnvId } from '../shared/environments.js';
import {
  HARD_CEILINGS,
  PERMISSION_INFO,
  stricter,
  withCeiling,
  type ApiFeature,
  type ApiPermission,
  type IntegrationConfig,
  type NumericLimitKey,
} from '../shared/apiPlatform.js';
import type { RateInfo, Scope, UnitClaim } from './limits.js';
import type { KeyRecord } from './store.js';

export interface ApiCall {
  requestId: string;
  db: Firestore;
  integration: IntegrationConfig;
  key: KeyRecord;
  scope: Scope;
  /** the end user's Atlas AI data space (users/{euid}), derived from the integration + X-Atlas-User */
  euid: string;
  /** '_app' when the application did not name an end user */
  endUser: string;
  environment: EnvId | 'mixed';
  source: 'api' | 'admin_test';
  request: Request;
  method: string;
  /** path segments after /v1/ */
  segments: string[];
  query: URLSearchParams;
  signal: AbortSignal;
  background(p: Promise<unknown>): void;
  rate: RateInfo | null;
  /** what the request used (for logs and analytics) */
  meta: { feature: ApiFeature; model: string | null; providerError: boolean; units: UnitClaim[] };
}

export function has(call: Pick<ApiCall, 'integration'>, p: ApiPermission): boolean {
  return call.integration.permissions.includes(p);
}

/** Refuse a request the integration has no permission for (HTTP 403, checked on the server). */
export function need(call: Pick<ApiCall, 'integration'>, p: ApiPermission): void {
  if (!has(call, p)) {
    throw new HttpError(403, 'permission_denied', `This application is not permitted to use: ${PERMISSION_INFO[p].label}.`, { permission: p });
  }
}

/** The effective size limit: the stricter of the application's and the key's, within the hard ceiling. */
export function sizeLimit(call: Pick<ApiCall, 'integration' | 'key'>, k: NumericLimitKey & keyof typeof HARD_CEILINGS): number {
  return withCeiling(stricter(call.integration.limits[k], call.key.limits?.[k]), k);
}
