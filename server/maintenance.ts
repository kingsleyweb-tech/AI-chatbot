/**
 * Maintenance mode: the Super Admin can switch the signed-in app off for everyone except
 * administrators. Signed-in users then see a full-screen notice (title and message chosen by the
 * administrator) instead of their dashboard, and every protected API call is refused with
 * 503 `maintenance`. The public website, sign-in and the Atlas AI API for applications are not
 * affected. Stored in config/maintenance (server identity only).
 */
import type { Firestore } from './firestore.js';
import { HttpError } from './http.js';

export const MAINTENANCE_PATH = 'config/maintenance';
export const MAINTENANCE_DEFAULTS = {
  title: 'Atlas AI is temporarily unavailable',
  message: 'We’re carrying out maintenance. Please try again in a moment.',
};

export interface MaintenanceConfig {
  enabled: boolean;
  title: string;
  message: string;
  updatedAt: number | null;
  updatedBy: string | null;
}

const CACHE_MS = 10_000;
let cache: { value: MaintenanceConfig; at: number } | null = null;

function normalize(d: Partial<MaintenanceConfig> | null | undefined): MaintenanceConfig {
  return {
    enabled: d?.enabled === true,
    title: typeof d?.title === 'string' && d.title.trim() ? d.title.trim() : MAINTENANCE_DEFAULTS.title,
    message: typeof d?.message === 'string' && d.message.trim() ? d.message.trim() : MAINTENANCE_DEFAULTS.message,
    updatedAt: typeof d?.updatedAt === 'number' ? d.updatedAt : null,
    updatedBy: typeof d?.updatedBy === 'string' ? d.updatedBy : null,
  };
}

/** The current setting (shared for a few seconds across requests; `fresh` reads it again). */
export async function loadMaintenance(db: Firestore, fresh = false): Promise<MaintenanceConfig> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = normalize((await db.get<Partial<MaintenanceConfig>>(MAINTENANCE_PATH))?.data);
  cache = { value, at: Date.now() };
  return value;
}

export async function saveMaintenance(
  db: Firestore,
  input: { enabled: boolean; title?: string; message?: string },
  by: string,
): Promise<MaintenanceConfig> {
  const current = await loadMaintenance(db, true);
  const next: MaintenanceConfig = normalize({
    enabled: input.enabled,
    title: input.title ?? current.title,
    message: input.message ?? current.message,
    updatedAt: Date.now(),
    updatedBy: by,
  });
  await db.set(MAINTENANCE_PATH, { ...next });
  cache = { value: next, at: Date.now() };
  return next;
}

/** What a signed-in (non-admin) user is shown; null when the app is available. */
export function maintenanceNotice(m: MaintenanceConfig): { title: string; message: string } | null {
  return m.enabled ? { title: m.title, message: m.message } : null;
}

export function maintenanceError(m: MaintenanceConfig): HttpError {
  return new HttpError(503, 'maintenance', m.message, { title: m.title });
}

/** test hook */
export function clearMaintenanceCache() {
  cache = null;
}
