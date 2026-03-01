import { useState, useRef, useEffect } from 'react';
import { Avatar } from './Avatar';
import { Camera } from 'lucide-react';

interface ImageUploadButtonProps {
  currentImageUrl?: string | null;
  displayName: string;
  onFileChange: (file: File | null) => void;
  uploading?: boolean;
  /** 'create' shows dashed circle + camera; 'edit' shows existing avatar + "Change" overlay */
  variant?: 'create' | 'edit';
}

export function ImageUploadButton({
  currentImageUrl,
  displayName,
  onFileChange,
  uploading = false,
  variant = 'create',
}: ImageUploadButtonProps) {
  const [preview, setPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const handleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(file));
    onFileChange(file);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className={
          variant === 'create'
            ? 'group relative flex h-20 w-20 items-center justify-center rounded-full border-2 border-dashed border-vox-border hover:border-vox-accent-primary transition-colors overflow-hidden'
            : 'relative group'
        }
        disabled={uploading}
      >
        {preview ? (
          <img src={preview} alt="Preview" className="h-20 w-20 rounded-full object-cover" />
        ) : variant === 'edit' ? (
          <Avatar avatarUrl={currentImageUrl} displayName={displayName} size="lg" />
        ) : (
          <div className="flex flex-col items-center gap-1 text-vox-text-muted group-hover:text-vox-accent-primary transition-colors">
            <Camera size={24} />
            <span className="text-[10px]">Icon</span>
          </div>
        )}
        {uploading ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent" />
          </div>
        ) : variant === 'edit' && (
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 group-hover:bg-black/40 transition-colors">
            <span className="text-xs font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity">
              Change
            </span>
          </div>
        )}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        onChange={handleSelect}
        className="hidden"
      />
    </>
  );
}
