import { useState, useEffect } from 'react';
import { FileText, Download, Image, Film, Music, Clock, Loader2 } from 'lucide-react';
import { ImageLightbox } from './ImageLightbox';
import { toast } from '../../stores/toastStore';
import { api } from '../../services/api';
import type { Attachment } from '@voxium/shared';

const API_URL = import.meta.env.VITE_API_URL;

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

/** Fetch an attachment via the authenticated API and return a blob URL */
async function fetchBlobUrl(s3Key: string): Promise<string> {
  const response = await api.get(`/uploads/${s3Key}`, { responseType: 'blob' });
  return URL.createObjectURL(response.data);
}

interface Props {
  attachment: Attachment;
}

export function AttachmentDisplay({ attachment }: Props) {
  const [imgError, setImgError] = useState(false);
  const [showLightbox, setShowLightbox] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isImage = attachment.mimeType.startsWith('image/');
  const isVideo = attachment.mimeType.startsWith('video/');
  const isAudio = attachment.mimeType.startsWith('audio/');
  const needsBlob = (isImage || isVideo || isAudio) && !attachment.expired;

  // Fetch blob URL for media elements (they can't set Authorization headers)
  useEffect(() => {
    if (!needsBlob) return;
    let revoked = false;
    setLoading(true);
    fetchBlobUrl(attachment.s3Key)
      .then((url) => {
        if (!revoked) setBlobUrl(url);
        else URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (!revoked) setImgError(true);
      })
      .finally(() => {
        if (!revoked) setLoading(false);
      });
    return () => {
      revoked = true;
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [attachment.s3Key, needsBlob]);

  // Show expired placeholder for all file types
  if (attachment.expired) {
    const FileIcon = getFileIcon(attachment.mimeType);
    return (
      <div className="mt-1 inline-flex items-center gap-2 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-xs text-vox-text-muted">
        <FileIcon size={16} className="shrink-0" />
        <span>{attachment.fileName}</span>
        <span className="flex items-center gap-1 text-vox-text-muted/60"><Clock size={12} />Expired</span>
      </div>
    );
  }

  const handleDownload = async () => {
    try {
      const response = await api.get(`/uploads/${attachment.s3Key}`, { responseType: 'blob' });
      const blob = response.data as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.fileName;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded "${attachment.fileName}"`);
    } catch {
      toast.error('Failed to download file');
    }
  };

  // Loading state for media
  if (needsBlob && loading) {
    return (
      <div className="mt-1 inline-flex items-center gap-2 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-xs text-vox-text-muted">
        <Loader2 size={16} className="animate-spin shrink-0" />
        <span>Loading {isImage ? 'image' : isVideo ? 'video' : 'audio'}...</span>
      </div>
    );
  }

  if (isImage && !imgError && blobUrl) {
    return (
      <div className="mt-1">
        <img
          src={blobUrl}
          alt={attachment.fileName}
          className="max-h-[300px] max-w-[400px] rounded-lg object-contain cursor-pointer hover:opacity-90 transition-opacity"
          onError={() => setImgError(true)}
          onClick={() => setShowLightbox(true)}
        />
        <p className="mt-0.5 text-[10px] text-vox-text-muted">{attachment.fileName} - {formatFileSize(attachment.fileSize)}</p>
        {showLightbox && (
          <ImageLightbox
            src={blobUrl}
            alt={attachment.fileName}
            fileName={attachment.fileName}
            onClose={() => setShowLightbox(false)}
          />
        )}
      </div>
    );
  }

  if (isImage && imgError) {
    return (
      <div className="mt-1 flex items-center gap-2 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-xs text-vox-text-muted">
        <Image size={16} />
        <span>{attachment.fileName} - File expired</span>
      </div>
    );
  }

  if (isVideo && blobUrl) {
    return (
      <div className="mt-1">
        <video
          src={blobUrl}
          controls
          className="max-h-[300px] max-w-[400px] rounded-lg"
          preload="metadata"
        />
        <p className="mt-0.5 text-[10px] text-vox-text-muted">{attachment.fileName} - {formatFileSize(attachment.fileSize)}</p>
      </div>
    );
  }

  if (isAudio && blobUrl) {
    return (
      <div className="mt-1">
        <div className="flex items-center gap-2 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2">
          <Music size={16} className="shrink-0 text-vox-text-muted" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-vox-text-primary">{attachment.fileName}</p>
            <audio src={blobUrl} controls className="mt-1 h-8 w-full" preload="metadata" />
          </div>
          <span className="shrink-0 text-[10px] text-vox-text-muted">{formatFileSize(attachment.fileSize)}</span>
        </div>
      </div>
    );
  }

  // Generic file card
  const FileIcon = getFileIcon(attachment.mimeType);
  return (
    <div className="mt-1">
      <button
        onClick={handleDownload}
        className="inline-flex items-center gap-2 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 hover:bg-vox-bg-hover transition-colors"
      >
        <FileIcon size={20} className="shrink-0 text-vox-accent-primary" />
        <div className="min-w-0 text-left">
          <p className="truncate text-xs font-medium text-vox-accent-primary hover:underline">{attachment.fileName}</p>
          <p className="text-[10px] text-vox-text-muted">{formatFileSize(attachment.fileSize)}</p>
        </div>
        <Download size={14} className="shrink-0 text-vox-text-muted" />
      </button>
    </div>
  );
}
