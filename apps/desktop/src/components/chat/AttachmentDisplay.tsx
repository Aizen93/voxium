import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Download, Image, Film, Music, Clock, Loader2 } from 'lucide-react';
import { ImageLightbox } from './ImageLightbox';
import { DeferredMedia, formatFileSize, describeError } from './DeferredMedia';
import { toast } from '../../stores/toastStore';
import { api } from '../../services/api';
import type { Attachment } from '@voxium/shared';

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return Film;
  if (mimeType.startsWith('audio/')) return Music;
  return FileText;
}

/** Fetch an attachment via the authenticated API (Authorization header only) */
async function fetchBlob(s3Key: string): Promise<Blob> {
  const response = await api.get(`/uploads/${s3Key}`, { responseType: 'blob' });
  return response.data as Blob;
}

/** Fetch an attachment via the authenticated API and return a blob URL */
async function fetchBlobUrl(s3Key: string): Promise<string> {
  return URL.createObjectURL(await fetchBlob(s3Key));
}

interface Props {
  attachment: Attachment;
}

export function AttachmentDisplay({ attachment }: Props) {
  const { t } = useTranslation();
  const [imgError, setImgError] = useState(false);
  const [showLightbox, setShowLightbox] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isImage = attachment.mimeType.startsWith('image/');
  const isVideo = attachment.mimeType.startsWith('video/');
  const isAudio = attachment.mimeType.startsWith('audio/');
  // Only images are fetched on render; video and audio wait for a play request
  const needsBlob = isImage && !attachment.expired;

  // Fetch blob URL for images (an <img> can't set Authorization headers)
  useEffect(() => {
    if (!needsBlob) return;
    let revoked = false;
    setLoading(true);
    fetchBlobUrl(attachment.s3Key)
      .then((url) => {
        if (!revoked) setBlobUrl(url);
        else URL.revokeObjectURL(url);
      })
      .catch((err: unknown) => {
        console.warn('[Attachment] Failed to load image:', describeError(err));
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
        <span className="flex items-center gap-1 text-vox-text-muted/60"><Clock size={12} />{t('attachment.expired')}</span>
      </div>
    );
  }

  // Loading state for images
  if (needsBlob && loading) {
    return (
      <div className="mt-1 inline-flex items-center gap-2 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-xs text-vox-text-muted">
        <Loader2 size={16} className="animate-spin shrink-0" />
        <span>{t('attachment.loadingImage')}</span>
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
        <span>{attachment.fileName} - {t('attachment.fileExpired')}</span>
      </div>
    );
  }

  if (isVideo || isAudio) {
    return (
      <DeferredMedia
        key={attachment.s3Key}
        kind={isVideo ? 'video' : 'audio'}
        load={() => fetchBlob(attachment.s3Key)}
        cacheKey={attachment.s3Key}
        fileName={attachment.fileName}
        fileSize={attachment.fileSize}
        mimeType={attachment.mimeType}
        fallback={<FileCard attachment={attachment} />}
      />
    );
  }

  return <FileCard attachment={attachment} />;
}

/** The generic file card: a download button. */
function FileCard({ attachment }: Props) {
  const { t } = useTranslation();
  const FileIcon = getFileIcon(attachment.mimeType);

  const handleDownload = async () => {
    try {
      const blob = await fetchBlob(attachment.s3Key);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.fileName;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t('attachment.downloaded'));
    } catch {
      toast.error(t('attachment.failedToDownload'));
    }
  };

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
