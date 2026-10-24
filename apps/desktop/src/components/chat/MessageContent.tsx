import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { useTranslation } from 'react-i18next';
import type { Components } from 'react-markdown';
import { MENTION_RE, EVERYONE_MENTION_RE } from '@voxium/shared';
import type { MessageAuthor } from '@voxium/shared';

interface Props {
  content: string;
  mentions?: MessageAuthor[];
  /** The server's word that `@everyone` in this message pings the channel
   *  (the author held MENTION_EVERYONE). Without it the token is plain text. */
  mentionsEveryone?: boolean;
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

type Segment =
  | { type: 'text'; value: string }
  | { type: 'mention'; userId: string }
  | { type: 'everyone' };

/**
 * Split `content` into text, `@[userId]` mentions and — only when the server
 * said this message pings the channel — `@everyone` tokens. The bare text
 * `@everyone` in a message the server did NOT flag stays text: whoever wrote
 * it lacked the permission, and rendering it as a ping would lie.
 */
function segment(content: string, mentionsEveryone: boolean): Segment[] {
  const sources: Array<{ re: RegExp; kind: 'mention' | 'everyone' }> = [{ re: MENTION_RE, kind: 'mention' }];
  if (mentionsEveryone) sources.push({ re: EVERYONE_MENTION_RE, kind: 'everyone' });
  const combined = new RegExp(sources.map((s) => `(${s.re.source})`).join('|'), 'g');
  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = combined.exec(content)) !== null) {
    // Group layout: [1] whole user mention, [2] its userId, [3] whole everyone
    // token, [4] the character before it (which the token regex consumes)
    const prefix = match[3] !== undefined ? (match[4] ?? '') : '';
    const start = match.index + prefix.length;
    if (start > lastIndex) segments.push({ type: 'text', value: content.slice(lastIndex, start) });
    if (match[3] !== undefined) segments.push({ type: 'everyone' });
    else segments.push({ type: 'mention', userId: match[2] });
    lastIndex = combined.lastIndex;
  }
  if (lastIndex < content.length) segments.push({ type: 'text', value: content.slice(lastIndex) });
  return segments;
}

export function MessageContent({ content, mentions, mentionsEveryone = false }: Props) {
  const { t } = useTranslation();
  const mentionMap = buildMentionMap(mentions);
  const hasUserMentions = mentionMap.size > 0 && new RegExp(MENTION_RE.source, MENTION_RE.flags).test(content);
  const hasEveryone = mentionsEveryone && new RegExp(EVERYONE_MENTION_RE.source).test(content);
  const hasMentions = hasUserMentions || hasEveryone;

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
  const segments = segment(content, hasEveryone);

  return (
    <span>
      {segments.map((seg, i) => {
        if (seg.type === 'everyone') {
          return (
            <span
              key={i}
              className="inline-flex items-baseline rounded bg-vox-accent-primary/20 px-1 text-vox-accent-primary font-medium"
              data-testid="mention-everyone"
            >
              @everyone
            </span>
          );
        }
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
              {t('chat.mentionUnknown')}
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

