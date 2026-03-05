import { useEffect, useRef, useState } from 'react';
import { LifeBuoy, Send } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { clsx } from 'clsx';
import type { SupportTicket } from '@voxium/shared';

const STATUS_TABS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'claimed', label: 'Claimed' },
  { value: 'closed', label: 'Closed' },
];

export function AdminSupportTickets() {
  const {
    supportTickets, supportTicketsTotal, supportTicketsPage, supportTicketsFilter,
    activeTicket, activeTicketMessages,
    fetchSupportTickets, setSupportTicketsFilter, setActiveTicket,
    claimTicket, sendTicketMessage, closeTicket,
    subscribeSupport, unsubscribeSupport,
  } = useAdminStore();

  const [msgInput, setMsgInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(0);

  useEffect(() => {
    fetchSupportTickets(1);
    subscribeSupport();
    return () => unsubscribeSupport();
  }, [fetchSupportTickets, subscribeSupport, unsubscribeSupport]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (activeTicketMessages.length > prevLengthRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevLengthRef.current = activeTicketMessages.length;
  }, [activeTicketMessages.length]);

  const handleSend = async () => {
    if (!activeTicket || !msgInput.trim() || sending) return;
    setSending(true);
    try {
      await sendTicketMessage(activeTicket.id, msgInput.trim());
      setMsgInput('');
    } catch {
      // Error handled by store
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

  const handleSelectTicket = (ticket: SupportTicket) => {
    setActiveTicket(ticket);
  };

  const statusBadge = (status: string, claimedBy?: string | null) => {
    const colors: Record<string, string> = {
      open: 'bg-yellow-500/20 text-yellow-400',
      claimed: 'bg-blue-500/20 text-blue-400',
      closed: 'bg-gray-500/20 text-gray-400',
    };
    const labels: Record<string, string> = { open: 'Open', claimed: 'Claimed', closed: 'Closed' };
    return (
      <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', colors[status] || colors.closed)}>
        {labels[status] || status}
        {status === 'claimed' && claimedBy && <span className="ml-1 normal-case font-normal">by {claimedBy}</span>}
      </span>
    );
  };

  const totalPages = Math.ceil(supportTicketsTotal / 12);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-vox-text-primary flex items-center gap-2">
        <LifeBuoy size={20} /> Support Tickets
      </h2>

      <div className="flex gap-4 h-[calc(100vh-12rem)]">
        {/* Left panel: Ticket list */}
        <div className="w-2/5 flex flex-col rounded-lg bg-vox-bg-secondary border border-vox-border overflow-hidden">
          {/* Filter tabs */}
          <div className="flex border-b border-vox-border">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => setSupportTicketsFilter(tab.value)}
                className={clsx(
                  'flex-1 px-3 py-2 text-xs font-medium transition-colors',
                  supportTicketsFilter === tab.value
                    ? 'text-vox-accent-primary border-b-2 border-vox-accent-primary'
                    : 'text-vox-text-muted hover:text-vox-text-secondary'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Ticket list */}
          <div className="flex-1 overflow-y-auto">
            {supportTickets.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <LifeBuoy size={32} className="text-vox-text-muted" />
                <p className="text-sm text-vox-text-muted">No tickets found</p>
              </div>
            ) : (
              supportTickets.map((ticket) => (
                <button
                  key={ticket.id}
                  onClick={() => handleSelectTicket(ticket)}
                  className={clsx(
                    'w-full flex items-start gap-3 px-3 py-3 text-left border-b border-vox-border transition-colors',
                    activeTicket?.id === ticket.id
                      ? 'bg-vox-accent-primary/10'
                      : 'hover:bg-vox-bg-hover'
                  )}
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-vox-bg-hover text-xs font-bold text-vox-text-secondary uppercase">
                    {ticket.displayName.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-vox-text-primary truncate">{ticket.displayName}</span>
                      {statusBadge(ticket.status, ticket.claimedByUsername)}
                    </div>
                    <p className="text-xs text-vox-text-muted truncate mt-0.5">
                      @{ticket.username}
                    </p>
                    {ticket.lastMessage && (
                      <p className="text-xs text-vox-text-muted truncate mt-0.5">{ticket.lastMessage}</p>
                    )}
                    <p className="text-[10px] text-vox-text-muted mt-1">
                      {new Date(ticket.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-vox-border px-3 py-2">
              <button
                onClick={() => fetchSupportTickets(supportTicketsPage - 1)}
                disabled={supportTicketsPage <= 1}
                className="text-xs text-vox-text-muted hover:text-vox-text-primary disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-xs text-vox-text-muted">
                {supportTicketsPage} / {totalPages}
              </span>
              <button
                onClick={() => fetchSupportTickets(supportTicketsPage + 1)}
                disabled={supportTicketsPage >= totalPages}
                className="text-xs text-vox-text-muted hover:text-vox-text-primary disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </div>

        {/* Right panel: Chat view */}
        <div className="flex-1 flex flex-col rounded-lg bg-vox-bg-secondary border border-vox-border overflow-hidden">
          {!activeTicket ? (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-sm text-vox-text-muted">Select a ticket to view</p>
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="flex items-center gap-3 border-b border-vox-border px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-vox-text-primary">{activeTicket.displayName}</span>
                    <span className="text-xs text-vox-text-muted">@{activeTicket.username}</span>
                  </div>
                  <div className="mt-0.5">{statusBadge(activeTicket.status, activeTicket.claimedByUsername)}</div>
                </div>
                <div className="flex-1" />
                {activeTicket.status === 'open' && (
                  <button
                    onClick={() => claimTicket(activeTicket.id)}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                  >
                    Claim
                  </button>
                )}
                {(activeTicket.status === 'open' || activeTicket.status === 'claimed') && (
                  <button
                    onClick={() => closeTicket(activeTicket.id)}
                    className="rounded-md bg-gray-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 transition-colors"
                  >
                    Close
                  </button>
                )}
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-4 py-3">
                {activeTicketMessages.length === 0 && (
                  <p className="text-center text-sm text-vox-text-muted py-8">No messages yet</p>
                )}
                {activeTicketMessages.map((msg) => {
                  if (msg.type === 'system') {
                    return (
                      <div key={msg.id} className="my-2 flex justify-center">
                        <span className="rounded-full bg-vox-bg-hover px-3 py-1 text-xs text-vox-text-muted">
                          {msg.content}
                        </span>
                      </div>
                    );
                  }

                  const isStaff = msg.author.role === 'admin' || msg.author.role === 'superadmin';

                  return (
                    <div key={msg.id} className="flex gap-3 py-1.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-vox-bg-hover text-[10px] font-bold text-vox-text-secondary uppercase">
                        {msg.author.displayName.charAt(0)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={clsx('text-sm font-medium', isStaff ? 'text-vox-accent-info' : 'text-vox-text-primary')}>
                            {msg.author.displayName}
                          </span>
                          {isStaff && (
                            <span className="rounded bg-blue-500/20 px-1 py-0.5 text-[9px] font-bold text-blue-400 uppercase">Staff</span>
                          )}
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
              {activeTicket.status !== 'closed' && (
                <div className="border-t border-vox-border px-4 py-3">
                  <div className="flex items-end gap-2">
                    <textarea
                      value={msgInput}
                      onChange={(e) => setMsgInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Type a message..."
                      rows={1}
                      className="flex-1 resize-none rounded-md border border-vox-border bg-vox-bg-hover px-3 py-2 text-sm text-vox-text-primary placeholder:text-vox-text-muted focus:border-vox-accent-primary focus:outline-none"
                    />
                    <button
                      onClick={handleSend}
                      disabled={!msgInput.trim() || sending}
                      className="flex h-9 w-9 items-center justify-center rounded-md bg-vox-accent-primary text-white transition-colors hover:bg-vox-accent-primary/90 disabled:opacity-50"
                    >
                      <Send size={16} />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
