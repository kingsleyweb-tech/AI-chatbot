/**
 * Minimal client monitoring: uncaught errors, failed API calls (server errors
 * and network failures) and slow API calls are reported to the server log
 * (/api/account clientReport, visible in Vercel runtime logs).
 *
 * Privacy: only an error message (trimmed, with emails, numbers and query
 * strings removed), the API path, status and duration are sent. Never prompts,
 * message text, tokens or request bodies. At most a few reports per page load.
 */
export type ReportKind = 'error' | 'api' | 'slow';

const MAX_PER_LOAD = 8;
export const SLOW_API_MS = 10_000;
let sent = 0;
const seen = new Set<string>();
let sender: ((r: ClientReport) => Promise<unknown>) | null = null;

export interface ClientReport {
  kind: ReportKind;
  message: string;
  path?: string;
  status?: number;
  ms?: number;
}

/** Remove anything that could identify a person or carry content. */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\?[^\s]*/g, '')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '[number]')
    .replace(/(Bearer|key|token)[=:\s]+\S+/gi, '$1 [redacted]')
    .slice(0, 300);
}

export function report(r: ClientReport) {
  if (!sender || sent >= MAX_PER_LOAD) return;
  const clean: ClientReport = { ...r, message: scrub(r.message || 'unknown'), path: r.path ? scrub(r.path).slice(0, 100) : undefined };
  const key = `${clean.kind}|${clean.path ?? ''}|${clean.message}`;
  if (seen.has(key)) return;
  seen.add(key);
  sent++;
  void sender(clean).catch(() => undefined);
}

/** Start listening for uncaught errors. `send` posts one report (it must not report its own failures). */
export function initMonitoring(send: (r: ClientReport) => Promise<unknown>) {
  if (sender) return;
  sender = send;
  window.addEventListener('error', (e) => {
    // resource load errors (images) have no message and are not code errors
    if (!e.message) return;
    report({ kind: 'error', message: e.message });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { name?: string; message?: string } | undefined;
    if (reason?.name === 'AbortError') return; // a stopped reply or navigation, not a fault
    report({ kind: 'error', message: `unhandled: ${reason?.message ?? String(e.reason)}` });
  });
}
