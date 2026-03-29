import { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type { Components } from 'react-markdown';
import { MENTION_RE, CUSTOM_EMOJI_RE } from '@voxium/shared';
import type { MessageAuthor } from '@voxium/shared';
import { useEmojiStore } from '../../stores/emojiStore';

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

type Segment =
  | { type: 'text'; value: string }
  | { type: 'mention'; userId: string }
  | { type: 'custom_emoji'; name: string; id: string };

/** Parse content into text, mention, and custom emoji segments */
function parseSegments(content: string): Segment[] {
  // Combined regex: mentions OR custom emojis
  const combined = new RegExp(
    `(${MENTION_RE.source})|(${CUSTOM_EMOJI_RE.source})`,
    'g',
  );
  const segments: Segment[] = [];
  let lastIndex = 0;
  let match;

  while ((match = combined.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }
    if (match[1]) {
      // Mention: @[userId]
      segments.push({ type: 'mention', userId: match[2] });
    } else if (match[3]) {
      // Custom emoji: <:name:id>
      segments.push({ type: 'custom_emoji', name: match[4], id: match[5] });
    }
    lastIndex = combined.lastIndex;
  }
  if (lastIndex < content.length) {
    segments.push({ type: 'text', value: content.slice(lastIndex) });
  }
  return segments;
}

/** Check if content is ONLY custom emojis (for large display) */
function isEmojiOnly(segments: Segment[]): boolean {
  const nonEmpty = segments.filter(
    (s) => s.type !== 'text' || s.value.trim().length > 0,
  );
  return (
    nonEmpty.length > 0 &&
    nonEmpty.length <= 3 &&
    nonEmpty.every((s) => s.type === 'custom_emoji')
  );
}

export function MessageContent({ content, mentions }: Props) {
  const mentionMap = buildMentionMap(mentions);

  // Fast path: skip regex parsing entirely for plain text messages (vast majority)
  const mightHaveSpecial = content.includes('@[') || content.includes('<:');
  if (!mightHaveSpecial) {
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

  const segments = parseSegments(content);
  const hasSpecial = segments.some((s) => s.type !== 'text');

  if (!hasSpecial) {
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

  const emojiOnly = isEmojiOnly(segments);
  const emojiSize = emojiOnly ? 'w-10 h-10' : 'w-5 h-5';

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
        if (seg.type === 'custom_emoji') {
          return <CustomEmojiInline key={i} name={seg.name} id={seg.id} className={emojiSize} />;
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

function CustomEmojiInline({ name, id, className }: { name: string; id: string; className: string }) {
  const emoji = useEmojiStore((s) => s.emojis.get(id));
  const getUrl = useEmojiStore((s) => s.getEmojiImageUrl);
  const resolveEmoji = useEmojiStore((s) => s.resolveEmoji);

  // Trigger resolution for unknown emojis (e.g. cross-server usage in DMs)
  useEffect(() => {
    if (!emoji) {
      resolveEmoji(id);
    }
  }, [emoji, id, resolveEmoji]);

  if (!emoji) {
    // Emoji not in cache yet — show fallback text while resolving
    return <span className="text-vox-text-muted" title={`Custom emoji: ${name}`}>:{name}:</span>;
  }

  return (
    <img
      src={getUrl(emoji)}
      alt={`:${name}:`}
      title={`:${name}:`}
      className={`${className} inline-block align-middle object-contain`}
      loading="lazy"
    />
  );
}

