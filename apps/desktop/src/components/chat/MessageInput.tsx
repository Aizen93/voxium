import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type ChangeEvent, type DragEvent } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { getSocket } from '../../services/socket';
import { toast } from '../../stores/toastStore';
import { EmojiPicker } from '../common/EmojiPicker';
import { MentionAutocomplete, getMentionQuery, handleMentionKeyDown } from './MentionAutocomplete';
import { api } from '../../services/api';
import { LIMITS, ALLOWED_ATTACHMENT_TYPES, getMaxAttachmentSize } from '@voxium/shared';
import type { ServerMember } from '@voxium/shared';
import { PlusCircle, Smile, Send, X, FileText, Image, Film, Music, Upload } from 'lucide-react';

interface Props {
  channelId?: string;
  conversationId?: string;
  channelName?: string;
  placeholderName?: string;
}

interface PendingFile {
  id: string;
  file: File;
  status: 'uploading' | 'uploaded' | 'error';
  s3Key?: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  previewUrl?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return Film;
  if (mimeType.startsWith('audio/')) return Music;
  return FileText;
}

export function MessageInput({ channelId, conversationId, channelName, placeholderName }: Props) {
  const { sendMessage, sendDMMessage, replyingTo, clearReplyingTo } = useChatStore();
  const [content, setContent] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionResultsRef = useRef<ServerMember[]>([]);

  // Focus textarea when replying to a message
  useEffect(() => {
    if (replyingTo) {
      textareaRef.current?.focus();
    }
  }, [replyingTo]);

  // Clear pending files on channel/conversation switch
  useEffect(() => {
    setPendingFiles((prev) => {
      for (const pf of prev) {
        if (pf.previewUrl) URL.revokeObjectURL(pf.previewUrl);
      }
      return [];
    });
  }, [channelId, conversationId]);

  const handleTyping = () => {
    const socket = getSocket();
    if (!socket) return;

    if (!isTypingRef.current) {
      isTypingRef.current = true;
      if (conversationId) {
        socket.emit('dm:typing:start', conversationId);
      } else if (channelId) {
        socket.emit('typing:start', channelId);
      }
    }

    // Reset the typing timeout
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false;
      if (conversationId) {
        socket.emit('dm:typing:stop', conversationId);
      } else if (channelId) {
        socket.emit('typing:stop', channelId);
      }
    }, 2000);
  };

  const handleMentionSelect = useCallback((userId: string, displayName: string, mentionStart: number, mentionEnd: number) => {
    // Replace @query with @[userId] followed by a space
    const before = content.slice(0, mentionStart);
    const after = content.slice(mentionEnd);
    const mention = `@[${userId}] `;
    const newContent = before + mention + after;
    setContent(newContent);
    setShowMentions(false);
    setMentionIndex(0);
    // Focus textarea and place cursor after the inserted mention
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const newPos = mentionStart + mention.length;
        textareaRef.current.focus();
        textareaRef.current.selectionStart = newPos;
        textareaRef.current.selectionEnd = newPos;
        setCursorPos(newPos);
      }
    });
  }, [content]);

  const handleMentionMemberSelect = useCallback((member: ServerMember) => {
    const mention = getMentionQuery(content, cursorPos);
    if (!mention) return;
    const mentionEnd = mention.start + 1 + mention.query.length;
    handleMentionSelect(member.user.id, member.user.displayName, mention.start, mentionEnd);
  }, [content, cursorPos, handleMentionSelect]);

  const uploadFile = async (file: File, fileId: string) => {
    try {
      const { data } = await api.post('/uploads/presign/attachment', {
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        ...(channelId ? { channelId } : { conversationId }),
      });

      const { uploadUrl, key } = data.data;

      await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });

      setPendingFiles((prev) =>
        prev.map((pf) => (pf.id === fileId ? { ...pf, status: 'uploaded' as const, s3Key: key } : pf))
      );
    } catch {
      setPendingFiles((prev) =>
        prev.map((pf) => (pf.id === fileId ? { ...pf, status: 'error' as const } : pf))
      );
    }
  };

  const processFiles = (files: FileList) => {
    if (files.length === 0) return;

    const remaining = LIMITS.MAX_ATTACHMENTS_PER_MESSAGE - pendingFiles.length;
    if (remaining <= 0) {
      toast.error(`Max ${LIMITS.MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
      return;
    }

    const toAdd: PendingFile[] = [];
    for (let i = 0; i < Math.min(files.length, remaining); i++) {
      const file = files[i];
      if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type as typeof ALLOWED_ATTACHMENT_TYPES[number])) {
        toast.error(`${file.name}: file type not allowed`);
        continue;
      }
      const maxSize = getMaxAttachmentSize(file.type);
      if (file.size > maxSize) {
        toast.error(`${file.name} is too large (max ${maxSize / 1024 / 1024}MB)`);
        continue;
      }
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      toAdd.push({
        id: crypto.randomUUID(),
        file,
        status: 'uploading',
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        previewUrl,
      });
    }

    if (toAdd.length === 0) return;

    setPendingFiles((prev) => [...prev, ...toAdd]);
    toAdd.forEach((pf) => uploadFile(pf.file, pf.id));
  };

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    processFiles(files);
    e.target.value = '';
  };

  const removePendingFile = (fileId: string) => {
    setPendingFiles((prev) => {
      const removed = prev.find((pf) => pf.id === fileId);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((pf) => pf.id !== fileId);
    });
  };

  const handleSend = async () => {
    const trimmed = content.trim();
    const uploadedFiles = pendingFiles.filter((pf) => pf.status === 'uploaded');
    const hasUploading = pendingFiles.some((pf) => pf.status === 'uploading');

    if (hasUploading) {
      toast.warning('Please wait for uploads to finish');
      return;
    }

    if (!trimmed && uploadedFiles.length === 0) return;
    if (isSending) return;

    const attachments = uploadedFiles.map((pf) => ({
      s3Key: pf.s3Key!,
      fileName: pf.fileName,
      fileSize: pf.fileSize,
      mimeType: pf.mimeType,
    }));

    setIsSending(true);
    try {
      if (conversationId) {
        await sendDMMessage(conversationId, trimmed, attachments.length ? attachments : undefined);
      } else if (channelId) {
        await sendMessage(channelId, trimmed, attachments.length ? attachments : undefined);
      }
      setContent('');
      // Clean up previews
      for (const pf of pendingFiles) {
        if (pf.previewUrl) URL.revokeObjectURL(pf.previewUrl);
      }
      setPendingFiles([]);
      isTypingRef.current = false;
    } catch {
      toast.error('Failed to send message');
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Let mention autocomplete consume keys first (only in server channels)
    if (showMentions && channelId) {
      const consumed = handleMentionKeyDown(
        e, mentionResultsRef.current, mentionIndex, setMentionIndex, handleMentionMemberSelect,
      );
      if (consumed) return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape' && showMentions) {
      e.preventDefault();
      setShowMentions(false);
    } else if (e.key === 'Escape' && replyingTo) {
      e.preventDefault();
      clearReplyingTo();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      processFiles(files);
    }
  };

  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      processFiles(files);
    }
  };

  const canSend = content.trim() || pendingFiles.some((pf) => pf.status === 'uploaded');

  return (
    <div
      className="relative border-t border-vox-border px-4 py-3"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-vox-accent-primary bg-vox-accent-primary/10 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-vox-accent-primary">
            <Upload size={32} />
            <span className="text-sm font-medium">Drop files to upload</span>
          </div>
        </div>
      )}

      {replyingTo && (
        <div className="flex items-center justify-between rounded-t-xl border border-b-0 border-vox-border bg-vox-bg-secondary px-3 py-2">
          <div className="min-w-0 flex-1 text-xs text-vox-text-secondary">
            <span className="text-vox-text-muted">Replying to </span>
            <span className="font-semibold text-vox-text-primary">{replyingTo.author.displayName}</span>
            <span className="ml-2 truncate text-vox-text-muted">
              {replyingTo.content.length > 80 ? replyingTo.content.slice(0, 80) + '...' : replyingTo.content}
            </span>
          </div>
          <button
            onClick={clearReplyingTo}
            className="ml-2 shrink-0 rounded p-0.5 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
            title="Cancel reply"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Pending file previews */}
      {pendingFiles.length > 0 && (
        <div className={`flex gap-2 overflow-x-auto border border-b-0 border-vox-border bg-vox-bg-secondary px-3 py-2 ${replyingTo ? '' : 'rounded-t-xl'}`}>
          {pendingFiles.map((pf) => {
            const FileIcon = getFileIcon(pf.mimeType);
            return (
              <div
                key={pf.id}
                className={`relative flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 ${
                  pf.status === 'error'
                    ? 'border-vox-accent-danger/50 bg-vox-accent-danger/10'
                    : 'border-vox-border bg-vox-bg-floating'
                }`}
              >
                {pf.previewUrl ? (
                  <img src={pf.previewUrl} alt="" className="h-10 w-10 rounded object-cover" />
                ) : (
                  <FileIcon size={20} className="text-vox-text-muted" />
                )}
                <div className="min-w-0 max-w-[120px]">
                  <p className="truncate text-xs text-vox-text-primary">{pf.fileName}</p>
                  <p className="text-[10px] text-vox-text-muted">
                    {pf.status === 'uploading' ? 'Uploading...' : pf.status === 'error' ? 'Failed' : formatFileSize(pf.fileSize)}
                  </p>
                </div>
                {pf.status === 'uploading' && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden rounded-b-lg">
                    <div className="h-full w-1/2 animate-pulse bg-vox-accent-primary" />
                  </div>
                )}
                <button
                  onClick={() => removePendingFile(pf.id)}
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-vox-bg-tertiary text-vox-text-muted hover:text-vox-text-primary"
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Mention autocomplete (server channels only) */}
      {showMentions && channelId && (
        <MentionAutocomplete
          text={content}
          cursorPos={cursorPos}
          onSelect={handleMentionSelect}
          onClose={() => setShowMentions(false)}
          onResultsChange={(r) => { mentionResultsRef.current = r; }}
        />
      )}

      <div className={`flex items-end gap-2 bg-vox-bg-floating border border-vox-border px-3 py-2 ${
        replyingTo || pendingFiles.length > 0 ? 'rounded-b-xl border-t-0' : 'rounded-xl'
      }`}>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="mb-0.5 text-vox-text-muted hover:text-vox-text-primary transition-colors"
          title="Attach file"
        >
          <PlusCircle size={20} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
          accept={ALLOWED_ATTACHMENT_TYPES.join(',')}
        />

        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            const pos = e.target.selectionStart ?? e.target.value.length;
            setCursorPos(pos);
            // Show mention autocomplete if in a server channel and @ detected
            if (channelId) {
              const mention = getMentionQuery(e.target.value, pos);
              setShowMentions(!!mention);
              if (mention) setMentionIndex(0);
            }
            handleTyping();
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onClick={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyUp={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          placeholder={conversationId ? `Message @${placeholderName}` : `Message #${channelName}`}
          className="max-h-36 min-h-[24px] flex-1 resize-none bg-transparent text-sm text-vox-text-primary
                     placeholder:text-vox-text-muted focus:outline-none"
          rows={1}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement;
            target.style.height = 'auto';
            target.style.height = `${Math.min(target.scrollHeight, 144)}px`;
          }}
        />

        <button
          ref={emojiBtnRef}
          onClick={() => setShowEmojiPicker(!showEmojiPicker)}
          className="mb-0.5 text-vox-text-muted hover:text-vox-text-primary transition-colors"
        >
          <Smile size={20} />
        </button>
        {showEmojiPicker && (
          <EmojiPicker
            anchorRef={emojiBtnRef}
            onEmojiSelect={(emoji) => {
              setContent((prev) => prev + emoji);
              setShowEmojiPicker(false);
            }}
            onClose={() => setShowEmojiPicker(false)}
          />
        )}

        {canSend && (
          <button
            onClick={handleSend}
            disabled={isSending}
            className="mb-0.5 text-vox-accent-primary hover:text-vox-accent-hover transition-colors disabled:opacity-50"
          >
            <Send size={20} />
          </button>
        )}
      </div>
    </div>
  );
}
