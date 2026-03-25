import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LifeBuoy, Send, RotateCcw, X } from 'lucide-react';
import { useSupportStore } from '../../stores/supportStore';
import { useAuthStore } from '../../stores/authStore';
import { Avatar } from '../common/Avatar';
import { StaffBadge } from '../common/StaffBadge';
import { toast } from '../../stores/toastStore';
import { clsx } from 'clsx';
import { LIMITS } from '@voxium/shared';

export function SupportTicketView() {
  const { t } = useTranslation();
  const { ticket, messages, isLoading, sendMessage, openTicket, setShowSupportView } = useSupportStore();
  const user = useAuthStore((s) => s.user);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(0);

  // Auto-scroll on new messages
  useEffect(() => {
    if (messages.length > prevLengthRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevLengthRef.current = messages.length;
  }, [messages.length]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || sending) return;
    if (content.length > LIMITS.SUPPORT_MESSAGE_MAX) {
      toast.error(t('support.messageTooLong', { max: String(LIMITS.SUPPORT_MESSAGE_MAX) }));
      return;
    }
    setSending(true);
    try {
      await sendMessage(content);
      setInput('');
    } catch {
      toast.error(t('support.failedToSend'));
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleReopen = async () => {
    try {
      await openTicket();
    } catch (err) {
      toast.error(err instanceof Error ? err.message || t('support.failedToReopen') : t('support.failedToReopen'));
    }
  };

  const isClosed = ticket?.status === 'closed';

  const statusLabel = ticket?.status === 'open' ? t('support.open') : ticket?.status === 'claimed' ? t('support.inProgress') : t('support.closed');
  const statusColor = ticket?.status === 'open' ? 'bg-yellow-500/20 text-yellow-400' : ticket?.status === 'claimed' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-500/20 text-gray-400';

  return (
    <div className="flex h-full flex-col bg-vox-bg-primary">
      {/* Header */}
      <div className="flex h-12 items-center gap-3 border-b border-vox-border px-4 shadow-sm">
        <LifeBuoy size={18} className="text-vox-accent-primary" />
        <h2 className="text-sm font-semibold text-vox-text-primary">{t('support.title')}</h2>
        {ticket && (
          <span className={clsx('rounded px-2 py-0.5 text-[10px] font-semibold uppercase', statusColor)}>
            {statusLabel}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setShowSupportView(false)}
          className="rounded p-1 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
          title={t('common.close')}
          aria-label={t('common.close')}
        >
          <X size={16} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {isLoading && messages.length === 0 && (
          <div className="flex items-center justify-center py-16">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
          </div>
        )}

        {!isLoading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <LifeBuoy size={40} className="text-vox-text-muted" />
            <p className="text-sm text-vox-text-muted">{t('support.noMessages')}</p>
          </div>
        )}

        {messages.map((msg) => {
          if (msg.type === 'system') {
            return (
              <div key={msg.id} className="my-2 flex justify-center">
                <span className="rounded-full bg-vox-bg-secondary px-3 py-1 text-xs text-vox-text-muted">
                  {msg.content}
                </span>
              </div>
            );
          }

          const isOwnMessage = msg.authorId === user?.id;
          const isStaff = msg.author.role === 'admin' || msg.author.role === 'superadmin';

          return (
            <div key={msg.id} className="group flex gap-3 py-1.5 hover:bg-vox-bg-hover/50 rounded px-2 -mx-2">
              <Avatar
                avatarUrl={msg.author.avatarUrl}
                displayName={msg.author.displayName}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={clsx(
                    'text-sm font-medium',
                    isOwnMessage ? 'text-vox-accent-primary' : isStaff ? 'text-vox-accent-info' : 'text-vox-text-primary'
                  )}>
                    {msg.author.displayName}
                  </span>
                  {isStaff && <StaffBadge />}
                  <span className="text-[10px] text-vox-text-muted">
                    {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p className="text-sm text-vox-text-secondary whitespace-pre-wrap break-words">{msg.content}</p>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-vox-border px-4 py-3">
        {isClosed ? (
          <div className="flex items-center gap-3">
            <p className="flex-1 text-sm text-vox-text-muted">Ticket is closed.</p>
            <button
              onClick={handleReopen}
              className="flex items-center gap-1.5 rounded-md bg-vox-accent-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-vox-accent-primary/90 transition-colors"
            >
              <RotateCcw size={14} />
              {t('support.reopenTicket')}
            </button>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('support.placeholder')}
              rows={1}
              className="flex-1 resize-none rounded-md border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary placeholder:text-vox-text-muted focus:border-vox-accent-primary focus:outline-none"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="flex h-9 w-9 items-center justify-center rounded-md bg-vox-accent-primary text-white transition-colors hover:bg-vox-accent-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={t('support.sendMessage')}
            >
              <Send size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
