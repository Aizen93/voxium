import type { RefObject } from 'react';
import { LIMITS } from '@voxium/shared';

interface Props {
  /** The input's id (and test id); the error line is `${id}-error`. */
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The validator's refusal, translated; announced as an alert. */
  error: string | null;
  /** Focused by the dialog shell on open (never `autoFocus`: see WebhookDialog). */
  inputRef: RefObject<HTMLInputElement | null>;
  placeholder?: string;
  /** While a request is in flight: unlike `disabled`, it keeps the focus where it is. */
  readOnly?: boolean;
  /** The input's data-testid, when it differs from its id. */
  testId?: string;
}

/**
 * A webhook's name, as the create and edit dialogs ask for it: the label, the
 * one-line input capped at the shared limit, the counter and the error line.
 * One component so the two dialogs cannot drift apart (limit, a11y wiring).
 */
export function WebhookNameField({ id, label, value, onChange, error, inputRef, placeholder, readOnly = false, testId }: Props) {
  const errorId = `${id}-error`;
  return (
    <>
      <label htmlFor={id} className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={LIMITS.WEBHOOK_NAME_MAX}
        placeholder={placeholder}
        readOnly={readOnly}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="w-full rounded-lg border border-vox-border bg-vox-bg-primary px-3 py-2 text-sm text-vox-text-primary placeholder:text-vox-text-muted focus:border-vox-accent-primary focus:outline-none read-only:opacity-60"
        data-testid={testId ?? id}
      />
      <div className="mt-1 flex items-start justify-between gap-2 text-[11px]">
        <span id={errorId} className="text-vox-accent-danger" role={error ? 'alert' : undefined} data-testid={errorId}>{error}</span>
        <span className="shrink-0 text-vox-text-muted">{value.length}/{LIMITS.WEBHOOK_NAME_MAX}</span>
      </div>
    </>
  );
}
