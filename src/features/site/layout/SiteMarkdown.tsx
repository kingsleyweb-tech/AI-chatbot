import { Check, Copy } from 'lucide-react';
import { Children, isValidElement, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { copyText } from '@/lib/utils';
import { slugify } from '../content/docs';
import { SmartLink } from './ui';

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? textOf(c.props.children) : ''))
    .join('');
}

/** Lightweight code block (no syntax highlighter, so the site stays small). */
function Code({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-[#0b1413] text-[#d8ece8]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5 text-xs text-[#8fb0aa]">
        <span className="font-mono">{lang || 'text'}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-white/10 hover:text-white"
          onClick={async () => {
            if (await copyText(code)) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            }
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-[13.5px] leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  h2: ({ children }) => <h2 id={slugify(textOf(children))}>{children}</h2>,
  h3: ({ children }) => <h3 id={slugify(textOf(children))}>{children}</h3>,
  a: ({ href, children }) => <SmartLink href={href ?? '#'}>{children}</SmartLink>,
  pre: ({ children }) => <>{children}</>,
  code({ className, children, ...props }: ComponentProps<'code'> & { node?: unknown }) {
    const match = /language-([\w+#-]+)/.exec(className ?? '');
    const text = String(children ?? '');
    if (!match && !text.includes('\n')) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { node, ...rest } = props as { node?: unknown };
      return <code {...rest}>{children}</code>;
    }
    return <Code code={text.replace(/\n$/, '')} lang={match?.[1] ?? ''} />;
  },
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
};

/** Markdown for docs, blog and policies, with heading ids for the table of contents. */
export function SiteMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={`prose-site ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
