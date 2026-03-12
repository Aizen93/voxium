import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Download } from 'lucide-react';
import { toast } from '../../stores/toastStore';

interface Props {
  src: string;
  alt: string;
  fileName?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, fileName, onClose }: Props) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleDownload = () => {
    try {
      const a = document.createElement('a');
      a.href = src;
      a.download = fileName || alt || 'image';
      a.click();
      toast.success(`Downloaded "${fileName || alt || 'image'}"`);
    } catch {
      toast.error('Failed to download file');
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      {/* Top-right controls */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <button
          onClick={(e) => { e.stopPropagation(); handleDownload(); }}
          className="rounded-full bg-vox-bg-tertiary/80 p-2 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-tertiary transition-colors"
          title="Download"
        >
          <Download size={20} />
        </button>
        <button
          onClick={onClose}
          className="rounded-full bg-vox-bg-tertiary/80 p-2 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-tertiary transition-colors"
          title="Close"
        >
          <X size={20} />
        </button>
      </div>

      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
