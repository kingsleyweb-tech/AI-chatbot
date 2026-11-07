import { Check, Copy, WrapText } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { copyText, cn } from '@/lib/utils';

const cache = new Map<string, string>();

async function highlight(code: string, lang: string): Promise<string | null> {
  const key = `${lang}\u0000${code}`;
  if (cache.has(key)) return cache.get(key)!;
  const shiki = await import('shiki');
  const language = (lang in shiki.bundledLanguages ? lang : 'text') as Parameters<typeof shiki.codeToHtml>[1]['lang'];
  const html = await shiki.codeToHtml(code, {
    lang: language,
    themes: { light: 'github-light', dark: 'github-dark-dimmed' },
    defaultColor: 'light',
  });
  if (cache.size > 300) cache.clear();
  cache.set(key, html);
  return html;
}

export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  streaming,
}: {
  code: string;
  lang: string;
  streaming?: boolean;
}) {
  const [html, setHtml] = useState<string | null>(() => cache.get(`${lang}\u0000${code}`) ?? null);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);

  useEffect(() => {
    if (streaming) return; // highlight once the block is complete
    let cancelled = false;
    highlight(code, lang)
      .then((h) => !cancelled && setHtml(h))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [code, lang, streaming]);

  return (
    <div className="group/code my-3 overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex h-9 items-center justify-between border-b border-border pl-3.5 pr-1.5 text-xs text-muted">
        <span className="font-mono">{lang || 'text'}</span>
        <div className="flex items-center">
          <button
            onClick={() => setWrap((w) => !w)}
            className={cn('rounded-md p-1.5 hover:bg-surface-2 hover:text-fg', wrap && 'text-accent')}
            aria-label="Toggle line wrap"
            title="Wrap lines"
          >
            <WrapText className="size-3.5" />
          </button>
          <button
            onClick={async () => {
              if (await copyText(code)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            }}
            className="flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-surface-2 hover:text-fg"
            aria-label="Copy code"
          >
            {copied ? <Check className="size-3.5 text-accent" /> : <Copy className="size-3.5" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>
      {html && !streaming ? (
        <div
          className={cn('shiki-wrap scroll-thin', wrap && '[&_pre]:!whitespace-pre-wrap [&_pre]:break-words')}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre
          className={cn(
            'scroll-thin overflow-x-auto px-4 py-[0.9em] font-mono text-[0.86em] leading-[1.55]',
            wrap && 'whitespace-pre-wrap break-words',
          )}
        >
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
});
