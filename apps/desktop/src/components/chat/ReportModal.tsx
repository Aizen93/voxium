import { useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { X, Flag } from 'lucide-react';
import { api } from '../../services/api';
import { toast } from '../../stores/toastStore';
import { LIMITS } from '@voxium/shared';

interface Props {
  type: 'message' | 'user';
  reportedUserId: string;
  messageId?: string;
  onClose: () => void;
}

const PRESETS = ['Spam', 'Harassment', 'Hate speech', 'NSFW content', 'Other'];

export function ReportModal({ type, reportedUserId, messageId, onClose }: Props) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handlePreset = (preset: string) => {
    if (preset === 'Other') {
      setReason('');
    } else {
      setReason((prev) => prev ? `${preset}: ${prev}` : `${preset}: `);
    }
  };

  const handleSubmit = async () => {
    if (reason.trim().length < LIMITS.REPORT_REASON_MIN) {
      toast.error(`Reason must be at least ${LIMITS.REPORT_REASON_MIN} characters`);
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/reports', {
        type,
        reportedUserId,
        ...(type === 'message' && messageId ? { messageId } : {}),
        reason: reason.trim(),
      });
      toast.success('Report submitted. Thank you!');
      onClose();
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to submit report' : 'Failed to submit report');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg bg-vox-bg-floating border border-vox-border shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-vox-border">
          <div className="flex items-center gap-2 text-vox-text-primary">
            <Flag size={16} className="text-vox-accent-warning" />
            <h3 className="text-sm font-semibold">
              Report {type === 'message' ? 'Message' : 'User'}
            </h3>
          </div>
          <button onClick={onClose} className="text-vox-text-muted hover:text-vox-text-primary">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-3">
          <p className="text-xs text-vox-text-muted">
            Select a category and describe the issue. Reports are reviewed by our staff.
          </p>

          {/* Preset buttons */}
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => handlePreset(preset)}
                className="px-2.5 py-1 text-xs rounded-md bg-vox-bg-hover text-vox-text-secondary hover:bg-vox-bg-active hover:text-vox-text-primary transition-colors border border-vox-border"
              >
                {preset}
              </button>
            ))}
          </div>

          {/* Reason textarea */}
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={`Describe the issue in detail (min ${LIMITS.REPORT_REASON_MIN} characters)...`}
            rows={4}
            maxLength={LIMITS.REPORT_REASON_MAX}
            className="w-full resize-none rounded-md border border-vox-border bg-vox-bg-hover px-3 py-2 text-sm text-vox-text-primary placeholder:text-vox-text-muted focus:border-vox-accent-primary focus:outline-none focus:ring-1 focus:ring-vox-accent-primary"
          />
          <p className="text-right text-[10px] text-vox-text-muted">{reason.length}/{LIMITS.REPORT_REASON_MAX}</p>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-vox-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-md text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || reason.trim().length < LIMITS.REPORT_REASON_MIN}
            className="px-3 py-1.5 text-xs rounded-md bg-vox-accent-danger text-white hover:bg-vox-accent-danger/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? 'Submitting...' : 'Submit Report'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
