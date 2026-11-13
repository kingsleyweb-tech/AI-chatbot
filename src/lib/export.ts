import type { Conversation, Message } from './types';
import { modelShortName, toDate } from './utils';

function safeName(title: string) {
  return (title || 'conversation').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'conversation';
}

function download(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function toMarkdown(conv: Conversation, messages: Message[]): string {
  const lines = [`# ${conv.title}`, '', `_Exported from Atlas AI on ${new Date().toLocaleString()}_`, ''];
  for (const m of messages) {
    const when = toDate(m.createdAt)?.toLocaleString() ?? '';
    lines.push(m.role === 'user' ? `## You · ${when}` : `## Atlas AI${m.model ? ` (${modelShortName(m.model)})` : ''} · ${when}`);
    lines.push('');
    lines.push(m.content || (m.error ? `_Error: ${m.error.message}_` : ''));
    const att = m.attachments?.map((a) => a.name).join(', ');
    if (att) lines.push('', `_Attachments: ${att}_`);
    if (m.sources?.length) {
      lines.push('', '**Sources**');
      for (const s of m.sources) lines.push(s.url ? `${s.index}. [${s.title}](${s.url})` : `D${s.index}. ${s.title}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function toPlainText(conv: Conversation, messages: Message[]): string {
  const out = [conv.title, '='.repeat(Math.min(conv.title.length, 60)), ''];
  for (const m of messages) {
    out.push(m.role === 'user' ? 'You:' : 'Atlas AI:');
    out.push(m.content);
    if (m.sources?.length) out.push('Sources:', ...m.sources.map((s) => `  [${s.index}] ${s.title} ${s.url}`));
    out.push('');
  }
  return out.join('\n');
}

export function exportMarkdown(conv: Conversation, messages: Message[]) {
  download(toMarkdown(conv, messages), `${safeName(conv.title)}.md`, 'text/markdown;charset=utf-8');
}

export function exportText(conv: Conversation, messages: Message[]) {
  download(toPlainText(conv, messages), `${safeName(conv.title)}.txt`, 'text/plain;charset=utf-8');
}

/** Shared look of every PDF made by Atlas AI (printed by the browser, so nothing leaves the device). */
export const PRINT_CSS = `
body{font:13.5px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 24px}
h1.t{font-size:22px;margin:0 0 4px} .meta{color:#666;font-size:12px;margin-bottom:24px}
h2.part{font-size:18px;margin:32px 0 8px;padding-top:8px;border-top:2px solid #0f766e;page-break-before:always}
h2.part.first{page-break-before:auto}
h3.conv{font-size:15px;margin:22px 0 2px} .sub{color:#666;font-size:12px;margin-bottom:6px}
section{padding:10px 0;border-top:1px solid #e5e5e5;page-break-inside:auto}
.who{font-weight:600;font-size:11.5px;color:#0f766e;margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em}
section.user .who{color:#555}
pre{background:#f5f5f4;padding:10px;border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:12px}
code{font-family:ui-monospace,Menlo,Consolas,monospace}
table{border-collapse:collapse;width:100%;font-size:12px;margin:6px 0} th,td{border:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f5f5f4} .src{font-size:12px;color:#555;margin-top:8px} a{color:#0f766e;word-break:break-all}
ul.contents{columns:2;font-size:13px} .empty{color:#777;font-style:italic}
.hint{background:#ecfeff;border:1px solid #a5f3fc;border-radius:8px;padding:10px 12px;font-size:12.5px;margin-bottom:20px}
@media print{.hint{display:none}}
.katex-html{display:none}
`;  /* maths: the browser draws the MathML copy, so no KaTeX stylesheet is needed */

type RenderMd = (content: string) => string;

/** Markdown to static HTML (lazy: react-dom/server and the Markdown component load only when exporting). */
export async function markdownRenderer(): Promise<RenderMd> {
  const [{ renderToStaticMarkup }, { createElement }, { StaticMarkdown }] = await Promise.all([
    import('react-dom/server'),
    import('react'),
    import('@/components/Markdown'),
  ]);
  return (content) => renderToStaticMarkup(createElement(StaticMarkdown, { content }));
}

/** The messages of one conversation as HTML sections. */
export function messagesHtml(messages: Message[], md: RenderMd): string {
  return messages
    .map((m) => {
      const html = m.content ? md(m.content) : m.error ? `<p class="empty">Error: ${escapeHtml(m.error.message)}</p>` : '';
      const when = toDate(m.createdAt)?.toLocaleString() ?? '';
      const who = m.role === 'user' ? 'You' : `Atlas AI${m.model ? ` · ${escapeHtml(modelShortName(m.model))}` : ''}`;
      const att = m.attachments?.length ? `<div class="src">Attachments: ${escapeHtml(m.attachments.map((a) => a.name).join(', '))}</div>` : '';
      const sources = m.sources?.length
        ? `<div class="src"><b>Sources</b><ol>${m.sources
            .map((s) => `<li>${escapeHtml(s.title)}${s.url ? ` &mdash; <a href="${escapeHtml(s.url)}">${escapeHtml(s.url)}</a>` : ''}</li>`)
            .join('')}</ol></div>`
        : '';
      return `<section class="${m.role}"><div class="who">${who}${when ? ` <span style="font-weight:400;text-transform:none;color:#888">· ${escapeHtml(when)}</span>` : ''}</div><div class="md">${html}</div>${att}${sources}</section>`;
    })
    .join('');
}

/**
 * Open the system print dialog for a finished HTML body ("Save as PDF" on
 * computers and Android, Share > Print > Save to Files on iPhone). The page
 * title becomes the suggested file name.
 */
export async function printDocument(title: string, body: string) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(iframe);
  const w = iframe.contentWindow!;
  w.document.open();
  w.document.write(doc);
  w.document.close();
  await new Promise((r) => setTimeout(r, 600));
  w.focus();
  w.print();
  setTimeout(() => iframe.remove(), 60_000);
}

/** One conversation as a PDF. Pass every message (not only the ones loaded on screen). */
export async function exportPdf(conv: Conversation, messages: Message[]) {
  const md = await markdownRenderer();
  const body = `<h1 class="t">${escapeHtml(conv.title)}</h1><div class="meta">Exported from Atlas AI &middot; ${escapeHtml(new Date().toLocaleString())} &middot; ${messages.length} messages</div>${messagesHtml(messages, md)}`;
  await printDocument(safeName(conv.title), body);
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
