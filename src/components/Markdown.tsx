import 'katex/dist/katex.min.css';
import { memo, useMemo, type ComponentProps } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Source } from '@shared/types';
import { CodeBlock } from './CodeBlock';

/**
 * Convert citation markers like [1] and [D2] (outside code) into links with
 * a custom `cite:` scheme so they render as compact source chips.
 */
export function linkCitations(md: string, sources: Source[] | undefined): string {
  if (!sources?.length) return md;
  const web = new Map(sources.filter((s) => s.kind === 'web').map((s) => [String(s.index), s.url]));
  const docs = new Set(sources.filter((s) => s.kind === 'document').map((s) => `D${s.index}`));
  return md
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part; // code
      return part.replace(/\[(D?\d{1,2})\](?!\(|:)/g, (m, key: string) => {
        if (web.has(key)) return `[${key}](cite:${encodeURIComponent(web.get(key)!)})`;
        if (docs.has(key)) return `[${key}](cite:doc)`;
        return m;
      });
    })
    .join('');
}

/** Close an unterminated code fence while streaming so the rest renders correctly. */
function closeOpenFence(md: string): string {
  const fences = md.match(/^```/gm)?.length ?? 0;
  return fences % 2 === 1 ? md + '\n```' : md;
}

function urlTransform(url: string) {
  if (url.startsWith('cite:')) return url;
  return defaultUrlTransform(url);
}

function makeComponents(streaming: boolean, highlight: boolean): Components {
  return {
    a({ href, children, ...props }) {
      if (href?.startsWith('cite:')) {
        const target = decodeURIComponent(href.slice(5));
        if (target === 'doc') return <span className="cite">{children}</span>;
        return (
          <a className="cite" href={target} target="_blank" rel="noopener noreferrer" title={target}>
            {children}
          </a>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    code({ className, children, ...props }: ComponentProps<'code'> & { node?: unknown }) {
      const match = /language-([\w+#-]+)/.exec(className ?? '');
      const text = String(children ?? '');
      const isBlock = Boolean(match) || text.includes('\n');
      if (!isBlock) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      }
      const code = text.replace(/\n$/, '');
      if (!highlight) {
        return (
          <pre>
            <code>{code}</code>
          </pre>
        );
      }
      return <CodeBlock code={code} lang={match?.[1]?.toLowerCase() ?? ''} streaming={streaming} />;
    },
    table({ children }) {
      return (
        <div className="table-wrap scroll-thin">
          <table>{children}</table>
        </div>
      );
    },
  };
}

const remarkPlugins = [remarkGfm, [remarkMath, { singleDollarTextMath: true }]] as ComponentProps<
  typeof ReactMarkdown
>['remarkPlugins'];
const rehypePlugins = [[rehypeKatex, { throwOnError: false, strict: 'ignore' }]] as ComponentProps<
  typeof ReactMarkdown
>['rehypePlugins'];

export const Markdown = memo(function Markdown({
  content,
  sources,
  streaming = false,
  className,
}: {
  content: string;
  sources?: Source[];
  streaming?: boolean;
  className?: string;
}) {
  const components = useMemo(() => makeComponents(streaming, true), [streaming]);
  const text = useMemo(() => {
    const linked = linkCitations(content, sources);
    return streaming ? closeOpenFence(linked) : linked;
  }, [content, sources, streaming]);
  return (
    <div className={`md ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** Synchronous renderer without highlighting (used for PDF export). */
export function StaticMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={makeComponents(false, false)}
      urlTransform={urlTransform}
    >
      {content}
    </ReactMarkdown>
  );
}
