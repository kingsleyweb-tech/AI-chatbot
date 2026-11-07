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

/**
 * PDF export via the system print dialog ("Save as PDF" on desktop,
 * Share > Save to Files / Print on iPhone). Renders Markdown to static HTML.
 */
export async function exportPdf(conv: Conversation, messages: Message[]) {
  const [{ renderToStaticMarkup }, { createElement }, { StaticMarkdown }] = await Promise.all([
    import('react-dom/server'),
    import('react'),
    import('@/components/Markdown'),
  ]);
  const body = messages
    .map((m) => {
      const html = renderToStaticMarkup(createElement(StaticMarkdown, { content: m.content }));
      const who = m.role === 'user' ? 'You' : `Atlas AI${m.model ? ` · ${modelShortName(m.model)}` : ''}`;
      const sources = m.sources?.length
        ? `<div class="src"><b>Sources</b><ol>${m.sources
            .map((s) => `<li>${escapeHtml(s.title)}${s.url ? ` &mdash; <a href="${escapeHtml(s.url)}">${escapeHtml(s.url)}</a>` : ''}</li>`)
            .join('')}</ol></div>`
        : '';
      return `<section class="${m.role}"><div class="who">${who}</div><div class="md">${html}</div>${sources}</section>`;
    })
    .join('');
  const katexCss = 'https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css';
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(conv.title)}</title>
<link rel="stylesheet" href="${katexCss}">
<style>
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 24px}
h1.t{font-size:22px;margin:0 0 4px} .meta{color:#666;font-size:12px;margin-bottom:24px}
section{padding:12px 0;border-top:1px solid #e5e5e5;page-break-inside:auto}
.who{font-weight:600;font-size:12px;color:#0f766e;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
section.user .who{color:#555}
pre{background:#f5f5f4;padding:10px;border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:12px}
code{font-family:ui-monospace,Menlo,Consolas,monospace}
table{border-collapse:collapse} th,td{border:1px solid #ddd;padding:4px 8px}
.src{font-size:12px;color:#555;margin-top:8px} a{color:#0f766e}
</style></head><body><h1 class="t">${escapeHtml(conv.title)}</h1><div class="meta">Exported from Atlas AI &middot; ${new Date().toLocaleString()}</div>${body}</body></html>`;

  const iframe = document.createElement('iframe');
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

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
