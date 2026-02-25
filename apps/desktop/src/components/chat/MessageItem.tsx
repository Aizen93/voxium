import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { toast } from '../../stores/toastStore';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { Pencil, Trash2 } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { clsx } from 'clsx';
import type { Message } from '@voxium/shared';

interface Props {
  message: Message;
  showHeader: boolean;
  addTopMargin: boolean;
  isOwn: boolean;
  canDelete: boolean;
  channelId: string;
}

function formatMessageTime(dateStr: string) {
  const date = new Date(dateStr);
  if (isToday(date)) return `Today at ${format(date, 'h:mm a')}`;
  if (isYesterday(date)) return `Yesterday at ${format(date, 'h:mm a')}`;
  return format(date, 'MM/dd/yyyy h:mm a');
}

export function MessageItem({ message, showHeader, addTopMargin, isOwn, canDelete, channelId }: Props) {
  const { editMessage } = useChatStore();
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

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
      await editMessage(channelId, message.id, trimmed);
      setIsEditing(false);
      setEditContent('');
    } catch {
      toast.error('Failed to edit message');
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

  const showActions = isOwn || canDelete;

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
        escape to cancel · enter to save
      </p>
    </div>
  );

  return (
    <>
      <div
        className={clsx(
          'group relative px-2 py-0.5 hover:bg-vox-bg-hover/50 rounded transition-colors',
          addTopMargin && 'mt-4'
        )}
      >
        {/* Hover action buttons */}
        {showActions && !isEditing && (
          <div className="absolute -top-3 right-2 z-10 hidden group-hover:flex items-center gap-0.5 rounded-md border border-vox-border bg-vox-bg-secondary px-1 py-0.5 shadow-lg">
            {isOwn && (
              <button
                onClick={handleStartEdit}
                className="rounded p-1 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
                title="Edit message"
              >
                <Pencil size={14} />
              </button>
            )}
            {canDelete && (
              <button
                onClick={() => setShowDeleteModal(true)}
                className="rounded p-1 text-vox-text-muted hover:text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
                title="Delete message"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        )}

        {showHeader ? (
          <div className="flex items-start gap-3">
            {/* Avatar */}
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-vox-accent-primary text-sm font-semibold text-white">
              {message.author.displayName?.[0]?.toUpperCase() || '?'}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className={clsx(
                  'text-sm font-semibold',
                  isOwn ? 'text-vox-accent-primary' : 'text-vox-text-primary'
                )}>
                  {message.author.displayName}
                </span>
                <span className="text-xs text-vox-text-muted">
                  {formatMessageTime(message.createdAt)}
                </span>
                {message.editedAt && !isEditing && (
                  <span className="text-[10px] text-vox-text-muted">(edited)</span>
                )}
              </div>

              {isEditing ? (
                <div className="mt-1">{editArea}</div>
              ) : (
                <p className="text-sm text-vox-text-primary leading-relaxed break-words">
                  {message.content}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <div className="w-10 shrink-0 text-center">
              <span className="hidden group-hover:inline text-[10px] text-vox-text-muted">
                {format(new Date(message.createdAt), 'h:mm')}
              </span>
            </div>

            {isEditing ? editArea : (
              <div className="min-w-0 flex-1">
                <p className="inline text-sm text-vox-text-primary leading-relaxed break-words">
                  {message.content}
                </p>
                {message.editedAt && (
                  <span className="ml-1 text-[10px] text-vox-text-muted">(edited)</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {showDeleteModal && (
        <DeleteConfirmModal
          message={message}
          channelId={channelId}
          onClose={() => setShowDeleteModal(false)}
        />
      )}
    </>
  );
}
