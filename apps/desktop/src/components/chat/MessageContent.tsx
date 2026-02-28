import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

interface Props {
  content: string;
}

const allowedElements = [
  'p', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'br', 'input',
];

const components: Components = {
  p: ({ children }) => (
    <p className="leading-relaxed">{children}</p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  del: ({ children }) => (
    <del className="line-through text-vox-text-muted">{children}</del>
  ),
  code: ({ children, className }) => {
    // If className exists (e.g. "language-js"), it's inside a <pre> — render as block
    if (className) {
      return (
        <code className="text-[13px]">{children}</code>
      );
    }
    // Inline code
    return (
      <code className="bg-vox-bg-floating px-1.5 py-0.5 font-mono text-[13px] text-vox-accent-info rounded">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="bg-vox-bg-floating border border-vox-border rounded-md p-3 font-mono text-[13px] overflow-x-auto my-1">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-vox-text-muted/40 pl-3 text-vox-text-secondary my-1">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-vox-text-link hover:underline"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="ml-4 list-disc space-y-0.5 my-1">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="ml-4 list-decimal space-y-0.5 my-1">{children}</ol>
  ),
};

export function MessageContent({ content }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      allowedElements={allowedElements}
      unwrapDisallowed
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}
