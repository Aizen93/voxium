import { useId } from 'react';

/** The typed value counts when, trimmed, it equals the expected text exactly (case-sensitive). */
export function typedTextMatches(typed: string, expected: string): boolean {
  return expected.length > 0 && typed.trim() === expected;
}

interface Props {
  /** The text the admin has to type: the username of the account being deleted. */
  expected: string;
  value: string;
  onChange: (value: string) => void;
  /** Enter in the input; called only when the value matches. */
  onSubmit?: () => void;
  disabled?: boolean;
}

/**
 * "Type <name> to confirm": a guard against a slip on an action that cannot be undone. The name is
 * shown in a <code> so it can be read and selected. An empty name can never be confirmed.
 */
export function TypedConfirmInput({ expected, value, onChange, onSubmit, disabled = false }: Props) {
  const inputId = useId();
  const hintId = useId();
  const matches = typedTextMatches(value, expected);
  const caseOnly = !matches && expected.length > 0 && value.trim().toLowerCase() === expected.toLowerCase();

  if (expected.length === 0) {
    return (
      <p className="mt-3 text-xs text-vox-accent-danger">
        This account has no username to type, so it cannot be confirmed here.
      </p>
    );
  }

  return (
    <div className="mt-3">
      <label htmlFor={inputId} className="text-xs text-vox-text-muted mb-1 block">
        Type <code className="select-all rounded bg-vox-bg-hover px-1 font-mono text-vox-text-primary">{expected}</code> to confirm
      </label>
      <input
        id={inputId}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches && !disabled) onSubmit?.();
        }}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={caseOnly ? hintId : undefined}
        className="w-full rounded-md bg-vox-bg-primary border border-vox-border text-sm text-vox-text-primary px-3 py-1.5 focus:outline-none focus:border-vox-accent-primary disabled:opacity-50"
      />
      {caseOnly && (
        <p id={hintId} className="mt-1 text-xs text-vox-text-muted">The name is case-sensitive.</p>
      )}
    </div>
  );
}
