import type { DocumentData } from 'firebase/firestore';
import type { AccountExport } from './accountExport';
import { escapeHtml, markdownRenderer, messagesHtml, printDocument } from './export';
import type { Message } from './types';
import { modelShortName } from './utils';

/**
 * The account export as a readable document (Settings › Security › Export
 * your data › PDF). Same data as the JSON export; laid out for people, not
 * machines, and printed to PDF by the browser.
 */

const e = (v: unknown) => escapeHtml(v === null || v === undefined ? '' : String(v));

/** ISO string (the export already converted Firestore timestamps) to a local date and time. */
function when(v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function table(head: string[], rows: string[][]): string {
  if (!rows.length) return '<p class="empty">Nothing here.</p>';
  return `<table><thead><tr>${head.map((h) => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

const size = (n: unknown) => {
  const b = Number(n) || 0;
  return b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
};

const EVENT_LABEL: Record<string, string> = {
  login: 'Signed in',
  logout: 'Signed out',
  logout_inactivity: 'Signed out after inactivity',
  password_changed: 'Password changed',
  password_reset: 'Password reset',
  email_verified: 'Email verified',
  phone_verified: 'Phone number verified',
  sessions_revoked: 'Signed out of all devices',
  data_exported: 'Data exported',
  device_removed: 'Device removed',
  provider_linked: 'Sign-in method added',
  account_suspended: 'Account suspended',
  account_reactivated: 'Account reactivated',
  account_deletion_scheduled: 'Account deletion scheduled',
  account_restored: 'Account restored',
};
const label = (t: unknown) => EVENT_LABEL[String(t)] ?? String(t ?? '').replace(/_/g, ' ');

export function accountHtml(data: AccountExport, md: (s: string) => string): string {
  const p = (data.profile ?? {}) as DocumentData;
  const name = p.displayName ?? p.name ?? '';
  const parts: [string, string, number | null][] = [
    ['conversations', 'Conversations', data.conversations.length],
    ['memories', 'Memories', data.memories.length],
    ['projects', 'Projects', data.projects.length],
    ['saved', 'Saved responses', data.savedResponses.length],
    ['documents', 'Documents', data.documents.length],
    ['activity', 'Security activity', data.securityEvents.length],
  ];
  const out: string[] = [];

  out.push(
    `<div class="hint">Choose <b>Save as PDF</b> as the printer to keep a copy. On an iPhone, use Share › Print, then Share again › Save to Files.</div>`,
    `<h1 class="t">Your Atlas AI data</h1>`,
    `<div class="meta">${e(name || p.email || '')}${name && p.email ? ` &middot; ${e(p.email)}` : ''} &middot; exported ${e(when(data.exportedAt))}</div>`,
    `<ul class="contents">${parts.map(([, t, n]) => `<li>${e(t)}: ${n ?? 0}</li>`).join('')}</ul>`,
  );
  if (data.skipped.length)
    out.push(`<p class="empty">Could not be read and not included: ${e(data.skipped.join(', '))}.</p>`);

  out.push(`<h2 class="part first">Profile</h2>`);
  out.push(
    table(
      ['Field', 'Value'],
      (
        [
          ['Name', name],
          ['Email', p.email],
          ['Phone number', p.phoneNumber ? `${String(p.phoneNumber).slice(0, 4)}•••${String(p.phoneNumber).slice(-2)}` : ''],
          ['Account created', when(p.createdAt)],
          ['Last sign-in', when(p.lastLoginAt)],
          ['Terms accepted', p.consent?.termsVersion ? `Version ${p.consent.termsVersion}` : ''],
        ] as [string, unknown][]
      )
        .filter(([, v]) => v)
        .map(([k, v]) => [e(k), e(v)]),
    ),
  );

  out.push(`<h2 class="part" id="conversations">Conversations</h2>`);
  if (!data.conversations.length) out.push('<p class="empty">No conversations.</p>');
  const convs = [...data.conversations].sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')));
  for (const c of convs) {
    const msgs = c.messages as unknown as Message[];
    // messagesHtml reads Firestore timestamps; the export holds ISO strings
    const withDates = msgs.map((m) => ({ ...m, createdAt: m.createdAt ? { toDate: () => new Date(m.createdAt as unknown as string) } : null })) as unknown as Message[];
    out.push(
      `<h3 class="conv">${e(c.title || 'Untitled conversation')}</h3><div class="sub">${e(when(c.createdAt))} &middot; ${msgs.length} messages${c.saved ? ' &middot; saved' : ''}</div>`,
      messagesHtml(withDates, md),
    );
  }

  out.push(`<h2 class="part" id="memories">Memories</h2>`);
  out.push(
    table(
      ['Memory', 'Category', 'Status', 'Added'],
      data.memories.map((m) => [e(m.text), e(m.category), m.active === false ? 'Off' : 'On', e(when(m.createdAt))]),
    ),
  );

  out.push(`<h2 class="part" id="projects">Projects</h2>`);
  out.push(
    table(
      ['Project', 'Instructions', 'Created'],
      data.projects.map((x) => [e(x.name), e(x.instructions), e(when(x.createdAt))]),
    ),
  );
  if (data.projectMemory.length) {
    out.push('<h3 class="conv">Project memory</h3>');
    out.push(table(['Note', 'Added'], data.projectMemory.map((m) => [e(m.text ?? m.content ?? ''), e(when(m.createdAt))])));
  }

  out.push(`<h2 class="part" id="saved">Saved responses</h2>`);
  if (!data.savedResponses.length) out.push('<p class="empty">Nothing here.</p>');
  for (const s of data.savedResponses)
    out.push(
      `<section><div class="who">${e(s.conversationTitle || 'Saved response')}${s.model ? ` · ${e(modelShortName(String(s.model)))}` : ''} <span style="font-weight:400;text-transform:none;color:#888">· ${e(when(s.createdAt))}</span></div><div class="md">${md(String(s.content ?? ''))}</div></section>`,
    );

  out.push(`<h2 class="part" id="documents">Documents</h2>`);
  out.push(
    `<p class="sub">The files themselves are not included; download them from the Library in Atlas AI.</p>`,
    table(
      ['Name', 'Size', 'Pages', 'Uploaded'],
      data.documents.map((d) => [e(d.name), size(d.size), e(d.pageCount ?? ''), e(when(d.createdAt))]),
    ),
  );

  out.push(`<h2 class="part" id="activity">Security activity</h2>`);
  out.push(
    table(
      ['When', 'What', 'Device', 'Details'],
      data.securityEvents.slice(0, 500).map((s) => [e(when(s.at)), e(label(s.type)), e(s.device ?? ''), e(s.detail ?? '')]),
    ),
  );
  if (data.usage.length) {
    out.push(`<h3 class="conv">Usage by day</h3>`);
    out.push(
      table(
        ['Day', 'Requests'],
        [...data.usage]
          .sort((a, b) => String(b.date ?? b.id).localeCompare(String(a.date ?? a.id)))
          .slice(0, 120)
          .map((u) => [e(u.date ?? u.id), e(u.requests ?? '')]),
      ),
    );
  }
  return out.join('\n');
}

/** Build the account export and open the print dialog to save it as a PDF. */
export async function printAccountPdf(data: AccountExport): Promise<void> {
  const md = await markdownRenderer();
  await printDocument(`atlas-data-${data.exportedAt.slice(0, 10)}`, accountHtml(data, md));
}
