import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type { Components } from 'react-markdown';
import { MENTION_RE } from '@voxium/shared';
import type { MessageAuthor } from '@voxium/shared';

interface Props {
  content: string;
  mentions?: MessageAuthor[];
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

/** Build a Map of userId -> display info from the mentions array */
function buildMentionMap(mentions?: MessageAuthor[]): Map<string, MessageAuthor> {
  const map = new Map<string, MessageAuthor>();
  if (mentions) {
    for (const m of mentions) map.set(m.id, m);
  }
  return map;
}

export function MessageContent({ content, mentions }: Props) {
  const mentionMap = buildMentionMap(mentions);
  const hasMentions = mentionMap.size > 0 && new RegExp(MENTION_RE.source, MENTION_RE.flags).test(content);

  if (!hasMentions) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        allowedElements={allowedElements}
        unwrapDisallowed
        components={components}
      >
        {content}
      </ReactMarkdown>
    );
  }

  // When mentions are present, first do mention replacement then render markdown
  // for the text segments. We split content by mentions and render text parts
  // through markdown individually.
  const re = new RegExp(MENTION_RE.source, MENTION_RE.flags);
  const segments: Array<{ type: 'text'; value: string } | { type: 'mention'; userId: string }> = [];
  let lastIndex = 0;
  let match;

  while ((match = re.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'mention', userId: match[1] });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < content.length) {
    segments.push({ type: 'text', value: content.slice(lastIndex) });
  }

  return (
    <span>
      {segments.map((seg, i) => {
        if (seg.type === 'mention') {
          const user = mentionMap.get(seg.userId);
          return user ? (
            <span
              key={i}
              className="inline-flex items-baseline rounded bg-vox-accent-primary/20 px-1 text-vox-accent-primary font-medium cursor-pointer hover:bg-vox-accent-primary/30 transition-colors"
              data-mention-user-id={seg.userId}
              data-testid="mention-badge"
              title={`@${user.username}`}
            >
              @{user.displayName}
            </span>
          ) : (
            <span key={i} className="inline-flex items-baseline rounded bg-vox-bg-floating px-1 text-vox-text-muted">
              @unknown
            </span>
          );
        }
        return (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm, remarkBreaks]}
            allowedElements={allowedElements}
            unwrapDisallowed
            components={components}
          >
            {seg.value}
          </ReactMarkdown>
        );
      })}
    </span>
  );
}

