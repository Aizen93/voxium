import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chatStore';
import { toast } from '../../stores/toastStore';
import { X } from 'lucide-react';
import { format } from 'date-fns';
import type { Message } from '@voxium/shared';

interface Props {
  message: Message;
  channelId?: string;
  conversationId?: string;
  onClose: () => void;
}

export function DeleteConfirmModal({ message, channelId, conversationId, onClose }: Props) {
  const { t } = useTranslation();
  const { requestDeleteMessage, requestDeleteDMMessage } = useChatStore();
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      if (conversationId) {
        await requestDeleteDMMessage(conversationId, message.id);
      } else if (channelId) {
        await requestDeleteMessage(channelId, message.id);
      }
      onClose();
    } catch {
      toast.error(t('chat.failedToDelete'));
      setIsDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-2xl border border-vox-border bg-vox-bg-secondary p-6 shadow-2xl animate-slide-up">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-vox-text-primary">{t('chat.deleteMessage')}</h2>
          <button onClick={onClose} className="text-vox-text-muted hover:text-vox-text-primary transition-colors" aria-label={t('common.close')}>
            <X size={20} />
          </button>
        </div>

        <p className="mb-4 text-sm text-vox-text-secondary">
          {t('chat.deleteConfirm')}
        </p>

        {/* Message preview */}
        <div className="mb-6 rounded-lg border border-vox-border bg-vox-bg-primary p-3">
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-sm font-semibold text-vox-text-primary">
              {message.author.displayName}
            </span>
            <span className="text-xs text-vox-text-muted">
              {format(new Date(message.createdAt), 'MM/dd/yyyy h:mm a')}
            </span>
          </div>
          <p className="text-sm text-vox-text-secondary line-clamp-3 break-words">
            {message.content}
          </p>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="btn-secondary" disabled={isDeleting}>
            {t('common.cancel')}
          </button>
          <button onClick={handleDelete} className="btn-danger" disabled={isDeleting}>
            {isDeleting ? t('chat.deleting') : t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
