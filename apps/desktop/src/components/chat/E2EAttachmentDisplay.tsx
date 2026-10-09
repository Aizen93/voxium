import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileText, Image as ImageIcon, Film, Music, Lock } from 'lucide-react';
import { api } from '../../services/api';
import type { E2EAttachmentMeta } from '@voxium/shared';

// Renders an E2E attachment (docs/e2e-dm-spec.md §13): the server only holds
// an opaque AES-GCM blob, so the ciphertext is fetched through the existing
// authenticated proxy and decrypted in the WASM engine; the real name/type
// come from the message ciphertext. Blob URLs never touch the network.

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(mimeType: string) {
  if (mimeType.startsWith('image/')) return ImageIcon;
  if (mimeType.startsWith('video/')) return Film;
  if (mimeType.startsWith('audio/')) return Music;
  return FileText;
}

interface Props {
  meta: E2EAttachmentMeta;
}

export function E2EAttachmentDisplay({ meta }: Props) {
  const { t } = useTranslation();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    let url: string | null = null;

    (async () => {
      try {
        const [{ data }, engine] = await Promise.all([
          api.get(`/uploads/${meta.s3Key}`, { responseType: 'arraybuffer' }),
          import('../../services/e2e/engine'),
        ]);
        await engine.initEngine();
        const plaintext = engine.decryptAttachment(new Uint8Array(data as ArrayBuffer), meta.key, meta.iv);
        if (revoked) return;
        url = URL.createObjectURL(new Blob([plaintext as BlobPart], { type: meta.mimeType }));
        setBlobUrl(url);
      } catch (err) {
        // GCM authentication failure = swapped/corrupted blob; network errors
        // land here too — either way the honest state is "can't show this"
        console.warn(`e2e: attachment ${meta.s3Key} failed to load/decrypt:`, err instanceof Error ? err.message : err);
        if (!revoked) setFailed(true);
      }
    })();

    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [meta.s3Key, meta.key, meta.iv, meta.mimeType]);

  const Icon = iconFor(meta.mimeType);

  if (failed) {
    return (
      <div className="mt-1 flex max-w-md items-center gap-2 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm italic text-vox-text-muted">
        <Lock size={14} />
        {t('e2e.attachmentFailed')}
      </div>
    );
  }

  if (!blobUrl) {
    return (
      <div className="mt-1 flex max-w-md items-center gap-2 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-muted">
        <Icon size={16} className="animate-pulse" />
        <span className="truncate">{meta.fileName}</span>
        <span className="ml-auto shrink-0 text-xs">{formatFileSize(meta.fileSize)}</span>
      </div>
    );
  }

  if (meta.mimeType.startsWith('image/')) {
    return (
      <a href={blobUrl} download={meta.fileName} className="mt-1 block w-fit" title={meta.fileName}>
        <img
          src={blobUrl}
          alt={meta.fileName}
          className="max-h-80 max-w-md rounded-lg object-contain"
          loading="lazy"
        />
      </a>
    );
  }

  if (meta.mimeType.startsWith('video/')) {
    return <video src={blobUrl} controls className="mt-1 max-h-80 max-w-md rounded-lg" />;
  }

  if (meta.mimeType.startsWith('audio/')) {
    return <audio src={blobUrl} controls className="mt-1 w-full max-w-md" />;
  }

  return (
    <div className="mt-1 flex max-w-md items-center gap-3 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2">
      <Icon size={20} className="shrink-0 text-vox-text-muted" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-vox-text-primary">{meta.fileName}</p>
        <p className="text-xs text-vox-text-muted">{formatFileSize(meta.fileSize)}</p>
      </div>
      <a
        href={blobUrl}
        download={meta.fileName}
        className="shrink-0 rounded p-1.5 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
        title={t('e2e.downloadAttachment')}
        aria-label={t('e2e.downloadAttachment')}
      >
        <Download size={16} />
      </a>
    </div>
  );
}
