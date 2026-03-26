import { useState, useRef, useEffect, useMemo, memo, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chatStore';
import { toast } from '../../stores/toastStore';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { ReactionDisplay } from './ReactionDisplay';
import { EmojiPicker } from '../common/EmojiPicker';
import { Avatar } from '../common/Avatar';
import { MessageContent } from './MessageContent';
import { AttachmentDisplay } from './AttachmentDisplay';
import { UserHoverTarget } from '../common/UserHoverTarget';
import { Pencil, Trash2, SmilePlus, Reply, Flag } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { clsx } from 'clsx';
import type { Message } from '@voxium/shared';
import { StaffBadge } from '../common/StaffBadge';
import { SupporterBadge } from '../common/SupporterBadge';
import { ReportModal } from './ReportModal';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';

interface Props {
  message: Message;
  showHeader: boolean;
  addTopMargin: boolean;
  isOwn: boolean;
  canDelete: boolean;
  channelId?: string;
  conversationId?: string;
}

function formatMessageTime(dateStr: string, t: (key: string, opts?: Record<string, string>) => string) {
  const date = new Date(dateStr);
  if (isToday(date)) return t('messageItem.todayAt', { time: format(date, 'h:mm a') });
  if (isYesterday(date)) return t('messageItem.yesterdayAt', { time: format(date, 'h:mm a') });
  return format(date, 'MM/dd/yyyy h:mm a');
}

export const MessageItem = memo(function MessageItem({ message, showHeader, addTopMargin, isOwn, canDelete, channelId, conversationId }: Props) {
  const { t } = useTranslation();
  const { editMessage, editDMMessage } = useChatStore();
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const reactionBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isEditing && editRef.current) {
      const el = editRef.current;
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, [isEditing]);

  const handleStartEdit = () => {
    setEditContent(message.content);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditContent('');
  };

  const handleSaveEdit = async () => {
    const trimmed = editContent.trim();
    if (!trimmed || trimmed === message.content) {
      handleCancelEdit();
      return;
    }

    setIsSaving(true);
    try {
      if (conversationId) {
        await editDMMessage(conversationId, message.id, trimmed);
      } else if (channelId) {
        await editMessage(channelId, message.id, trimmed);
      }
      setIsEditing(false);
      setEditContent('');
    } catch {
      toast.error(t('chat.failedToEdit'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSaveEdit();
    }
  };

  const handleReactionSelect = async (emoji: string) => {
    setShowReactionPicker(false);
    try {
      if (conversationId) {
        await useChatStore.getState().toggleDMReaction(conversationId, message.id, emoji);
      } else if (channelId) {
        await useChatStore.getState().toggleReaction(channelId, message.id, emoji);
      }
    } catch {
      toast.error(t('messageItem.failedToToggleReaction'));
    }
  };

  const editArea = (
    <div className="min-w-0 flex-1">
      <textarea
        ref={editRef}
        value={editContent}
        onChange={(e) => {
          setEditContent(e.target.value);
          const target = e.target;
          target.style.height = 'auto';
          target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
        }}
        onKeyDown={handleEditKeyDown}
        disabled={isSaving}
        className="w-full resize-none rounded-md border border-vox-border bg-vox-bg-floating px-3 py-2 text-sm text-vox-text-primary focus:border-vox-accent-primary focus:outline-none focus:ring-1 focus:ring-vox-accent-primary disabled:opacity-50"
        rows={1}
      />
      <p className="mt-1 text-[11px] text-vox-text-muted">
        {t('messageItem.editHint')}
      </p>
    </div>
  );

  const isSystemMessage = message.type === 'system';
  const currentUserId = useAuthStore((s) => s.user?.id);
  const isMentioned = !!(message.mentions && currentUserId && message.mentions.some((m) => m.id === currentUserId));

  // Look up member for nickname and role color (only applies in server context)
  const members = useServerStore((s) => s.members);
  const authorMember = useMemo(
    () => channelId ? members.find((m) => m.userId === message.author.id) ?? null : null,
    [members, channelId, message.author.id],
  );
  const authorDisplayName = authorMember?.nickname || message.author.displayName;
  const authorRoleColor = useMemo(
    () => authorMember?.roles?.length
      ? [...authorMember.roles].sort((a, b) => b.position - a.position)[0]?.color ?? null
      : null,
    [authorMember],
  );

  const handleReply = () => {
    useChatStore.getState().setReplyingTo(message);
  };

  const handleScrollToReply = () => {
    if (!message.replyTo) return;
    const el = document.querySelector(`[data-message-id="${message.replyTo.id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('bg-vox-accent-primary/10');
      setTimeout(() => el.classList.remove('bg-vox-accent-primary/10'), 1500);
    }
  };

  const replyPreview = (() => {
    if (message.replyTo) {
      const truncated = message.replyTo.content.length > 80
        ? message.replyTo.content.slice(0, 80) + '...'
        : message.replyTo.content;
      return (
        <div
          onClick={handleScrollToReply}
          className="ml-13 mb-0.5 flex items-center gap-1.5 cursor-pointer text-xs text-vox-text-muted hover:text-vox-text-secondary border-l-2 border-vox-text-muted/40 pl-2"
        >
          <Reply size={12} className="shrink-0 rotate-180" />
          <span className="font-semibold text-vox-text-secondary">{message.replyTo.author.displayName}</span>
          <span className="truncate">{truncated}</span>
        </div>
      );
    }
    if (message.replyToId && !message.replyTo) {
      return (
        <div className="ml-13 mb-0.5 flex items-center gap-1.5 text-xs text-vox-text-muted italic border-l-2 border-vox-text-muted/40 pl-2">
          <Reply size={12} className="shrink-0 rotate-180" />
          <span>{t('messageItem.originalDeleted')}</span>
        </div>
      );
    }
    return null;
  })();

  return (
    <>
      <div
        data-message-id={message.id}
        className={clsx(
          'group relative px-2 py-0.5 rounded transition-colors',
          isMentioned ? 'bg-vox-accent-primary/10 border-l-2 border-vox-accent-primary hover:bg-vox-accent-primary/15' : 'hover:bg-vox-bg-hover/50',
          addTopMargin && 'mt-4'
        )}
      >
        {replyPreview}

        {/* Hover action buttons */}
        {!isEditing && (
          <div className={clsx(
            'absolute -top-3 right-2 z-10 items-center gap-0.5 rounded-md border border-vox-border bg-vox-bg-secondary px-1 py-0.5 shadow-lg',
            showReactionPicker ? 'flex' : 'hidden group-hover:flex'
          )}>
            {!isSystemMessage && (
              <button
                onClick={handleReply}
                className="rounded p-1 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
                title={t('messageItem.reply')}
                aria-label={t('messageItem.reply')}
              >
                <Reply size={14} />
              </button>
            )}
            <button
              ref={reactionBtnRef}
              onClick={() => setShowReactionPicker(!showReactionPicker)}
              className="rounded p-1 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
              title={t('messageItem.addReaction')}
              aria-label={t('messageItem.addReaction')}
            >
              <SmilePlus size={14} />
            </button>
            {showReactionPicker && (
              <EmojiPicker
                anchorRef={reactionBtnRef}
                onEmojiSelect={handleReactionSelect}
                onClose={() => setShowReactionPicker(false)}
              />
            )}
            {isOwn && (
              <button
                onClick={handleStartEdit}
                className="rounded p-1 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
                title={t('messageItem.editMessage')}
                aria-label={t('messageItem.editMessage')}
              >
                <Pencil size={14} />
              </button>
            )}
            {canDelete && (
              <button
                onClick={() => setShowDeleteModal(true)}
                className="rounded p-1 text-vox-text-muted hover:text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
                title={t('messageItem.deleteMessage')}
                aria-label={t('messageItem.deleteMessage')}
              >
                <Trash2 size={14} />
              </button>
            )}
            {!isOwn && !isSystemMessage && (
              <button
                onClick={() => setShowReportModal(true)}
                className="rounded p-1 text-vox-text-muted hover:text-vox-accent-warning hover:bg-vox-accent-warning/10 transition-colors"
                title={t('messageItem.report')}
                aria-label={t('messageItem.report')}
              >
                <Flag size={14} />
              </button>
            )}
          </div>
        )}

        {showHeader ? (
          <>
            <div className="flex items-start gap-3">
              {/* Avatar + Name hover target */}
              <UserHoverTarget userId={message.author.id} className="mt-0.5 shrink-0 cursor-pointer">
                <Avatar avatarUrl={message.author.avatarUrl} displayName={message.author.displayName} size="md" />
              </UserHoverTarget>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <UserHoverTarget userId={message.author.id} className="inline">
                    <span
                      className={clsx(
                        'text-sm font-semibold cursor-pointer hover:underline',
                        !authorRoleColor && (isOwn ? 'text-vox-accent-primary' : 'text-vox-text-primary')
                      )}
                      style={authorRoleColor ? { color: authorRoleColor } : undefined}
                    >
                      {authorDisplayName}
                    </span>
                  </UserHoverTarget>
                  {(message.author.role === 'admin' || message.author.role === 'superadmin') && <StaffBadge />}
                  {message.author.isSupporter && <SupporterBadge tier={message.author.supporterTier} />}
                  <span className="text-xs text-vox-text-muted">
                    {formatMessageTime(message.createdAt, t)}
                  </span>
                  {message.editedAt && !isEditing && (
                    <span className="text-[10px] text-vox-text-muted">{t('messageItem.edited')}</span>
                  )}
                </div>

                {isEditing ? (
                  <div className="mt-1">{editArea}</div>
                ) : (
                  <>
                    {message.content && (
                      <div className="text-sm text-vox-text-primary break-words">
                        <MessageContent content={message.content} mentions={message.mentions} />
                      </div>
                    )}
                    {message.attachments && message.attachments.length > 0 && (
                      <div className="flex flex-col">
                        {message.attachments.map((a) => (
                          <AttachmentDisplay key={a.id} attachment={a} />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            <ReactionDisplay reactions={message.reactions || []} messageId={message.id} channelId={channelId} conversationId={conversationId} />
          </>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <div className="w-10 shrink-0 text-center">
                <span className="hidden group-hover:inline text-[10px] text-vox-text-muted">
                  {format(new Date(message.createdAt), 'h:mm')}
                </span>
              </div>

              {isEditing ? editArea : (
                <div className="min-w-0 flex-1">
                  {message.content && (
                    <div className="text-sm text-vox-text-primary break-words">
                      <MessageContent content={message.content} mentions={message.mentions} />
                      {message.editedAt && (
                        <span className="text-[10px] text-vox-text-muted">{t('messageItem.edited')}</span>
                      )}
                    </div>
                  )}
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="flex flex-col">
                      {message.attachments.map((a) => (
                        <AttachmentDisplay key={a.id} attachment={a} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <ReactionDisplay reactions={message.reactions || []} messageId={message.id} channelId={channelId} conversationId={conversationId} />
          </>
        )}
      </div>

      {showDeleteModal && (
        <DeleteConfirmModal
          message={message}
          channelId={channelId}
          conversationId={conversationId}
          onClose={() => setShowDeleteModal(false)}
        />
      )}

      {showReportModal && (
        <ReportModal
          type="message"
          reportedUserId={message.author.id}
          messageId={message.id}
          onClose={() => setShowReportModal(false)}
        />
      )}
    </>
  );
});
