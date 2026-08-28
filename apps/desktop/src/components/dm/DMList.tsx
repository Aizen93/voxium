import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDMStore } from '../../stores/dmStore';
import { useFriendStore } from '../../stores/friendStore';
import { useSupportStore } from '../../stores/supportStore';
import { Avatar } from '../common/Avatar';
import { MessageSquare, Users, X, LifeBuoy } from 'lucide-react';
import { clsx } from 'clsx';
import { parseE2EEnvelope } from '@voxium/shared';
import { DMVoicePanel } from '../voice/DMVoicePanel';
import { toast } from '../../stores/toastStore';
import { StaffBadge } from '../common/StaffBadge';
import { SupporterBadge } from '../common/SupporterBadge';

export function DMList() {
  const { t } = useTranslation();
  const { conversations, activeConversationId, isLoading, fetchConversations, setActiveConversation, dmUnreadCounts, participantStatuses, deleteConversation } = useDMStore();
  const showFriendsView = useFriendStore((s) => s.showFriendsView);
  const pendingIncoming = useFriendStore((s) => s.pendingIncoming);
  const [showSupportConfirm, setShowSupportConfirm] = useState(false);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const handleOpenConversation = (conversationId: string) => {
    useFriendStore.getState().setShowFriendsView(false);
    useSupportStore.getState().setShowSupportView(false);
    setActiveConversation(conversationId);
  };

  const handleOpenFriends = () => {
    useFriendStore.getState().setShowFriendsView(true);
    useSupportStore.getState().setShowSupportView(false);
    useDMStore.getState().clearActiveConversation();
  };

  const handleContactSupport = async () => {
    // If user already has an open/claimed ticket, go directly to it
    const existing = useSupportStore.getState().ticket;
    if (existing && existing.status !== 'closed') {
      useSupportStore.getState().setShowSupportView(true);
      useFriendStore.getState().setShowFriendsView(false);
      useDMStore.getState().clearActiveConversation();
      return;
    }
    setShowSupportConfirm(true);
  };

  const handleConfirmSupport = async () => {
    setShowSupportConfirm(false);
    try {
      await useSupportStore.getState().openTicket();
      useFriendStore.getState().setShowFriendsView(false);
      useDMStore.getState().clearActiveConversation();
    } catch (err) {
      toast.error(err instanceof Error ? err.message || t('dm.failedToOpenTicket') : t('dm.failedToOpenTicket'));
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-vox-channel">
      {/* Header — open row, matching the server view's sidebar header */}
      <div className="flex h-10 flex-none items-center gap-2 px-3 pt-1">
        <h2 className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-vox-text-primary">{t('dm.title')}</h2>
      </div>

      {/* Friends button */}
      <div className="px-2">
        <button
          onClick={handleOpenFriends}
          className={clsx(
            'flex h-[31px] w-full items-center gap-2 rounded-md px-2 text-left transition-colors',
            showFriendsView
              ? 'bg-vox-accent-tint text-vox-text-primary font-semibold'
              : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary'
          )}
        >
          <Users size={15} />
          <span className="flex-1 text-[13.5px] font-medium">{t('dm.friends')}</span>
          {pendingIncoming.length > 0 && (
            <span className="flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-vox-accent-primary px-[5px] text-[10.5px] font-bold text-vox-on-accent">
              {pendingIncoming.length}
            </span>
          )}
        </button>
      </div>

      {/* Contact Support */}
      <div className="px-2 pt-0.5">
        <button
          onClick={handleContactSupport}
          className="flex h-[31px] w-full items-center gap-2 rounded-md px-2 text-left text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary transition-colors"
        >
          <LifeBuoy size={15} />
          <span className="flex-1 text-[13.5px] font-medium">{t('dm.contactSupport')}</span>
        </button>
      </div>

      {/* Section label */}
      <div className="px-3 pt-4 pb-1">
        <h3 className="section-label">{t('dm.title')}</h3>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {isLoading && conversations.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
          </div>
        )}

        {!isLoading && conversations.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 px-2 text-center">
            <MessageSquare size={24} className="text-vox-text-muted" />
            <p className="text-xs text-vox-text-muted">
              {t('dm.noConversations')}
            </p>
          </div>
        )}

        {conversations.map((conv) => {
          const unread = dmUnreadCounts[conv.id] || 0;
          const isActive = activeConversationId === conv.id;

          return (
            <div
              key={conv.id}
              role="button"
              tabIndex={0}
              onClick={() => handleOpenConversation(conv.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleOpenConversation(conv.id); }}
              className={clsx(
                'group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                isActive
                  ? 'bg-vox-accent-tint text-vox-text-primary'
                  : unread > 0
                    ? 'text-vox-text-primary hover:bg-vox-bg-hover'
                    : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary'
              )}
            >
              <Avatar
                avatarUrl={conv.participant.avatarUrl}
                displayName={conv.participant.displayName}
                size="sm"
                status={participantStatuses[conv.participant.id] || 'offline'}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className={clsx(
                    'truncate text-[13px] leading-tight',
                    isActive || unread > 0 ? 'font-semibold' : 'font-medium'
                  )}>
                    {conv.participant.displayName}
                  </span>
                  {(conv.participant.role === 'admin' || conv.participant.role === 'superadmin') && <StaffBadge />}
                </div>
                {conv.participant.isSupporter && <SupporterBadge tier={conv.participant.supporterTier} />}
                {conv.lastMessage && (
                  <p className="truncate text-[11.5px] leading-tight text-vox-text-muted">
                    {/* Ciphertext we could not hydrate from the local cache
                        shows the lock rather than raw JSON. Asked of the
                        parser, not of the string's first characters: a
                        display-layer sniff for a payload format is the wrong
                        layer, and it is what let a structured plaintext
                        payload — file key and all — through to the DOM. */}
                    {conv.lastMessage.encrypted &&
                     (!conv.lastMessage.content || parseE2EEnvelope(conv.lastMessage.content) !== null)
                      ? `🔒 ${t('e2e.encryptedMessage')}`
                      : conv.lastMessage.content}
                  </p>
                )}
              </div>
              {unread > 0 && (
                <span className="flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-vox-accent-primary px-[5px] text-[10.5px] font-bold text-vox-on-accent shrink-0">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteConversation(conv.id);
                }}
                className="opacity-0 group-hover:opacity-100 shrink-0 rounded p-0.5 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-active transition-all"
                title={t('common.delete')}
                aria-label={t('common.delete')}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Global DM voice panel */}
      <DMVoicePanel />

      {/* Support confirmation modal */}
      {showSupportConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm rounded-lg bg-vox-bg-secondary p-5 shadow-xl border border-vox-border">
            <div className="flex items-center gap-2 mb-3">
              <LifeBuoy size={18} className="text-vox-accent-primary" />
              <h3 className="text-sm font-semibold text-vox-text-primary">{t('dm.contactSupport')}</h3>
            </div>
            <p className="text-sm text-vox-text-secondary mb-4">
              {t('dm.confirmSupport')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSupportConfirm(false)}
                className="px-3 py-1.5 text-sm rounded-md bg-vox-bg-hover text-vox-text-secondary hover:text-vox-text-primary transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleConfirmSupport}
                className="px-3 py-1.5 text-sm rounded-md bg-vox-accent-primary text-vox-on-accent hover:bg-vox-accent-primary/90 transition-colors"
              >
                {t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
