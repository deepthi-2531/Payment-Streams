/**
 * @module components/forms/FormError
 *
 * Inline error message component for forms. Styled to match the
 * dashboard's design tokens; targeted by `<FormField>` and usable
 * directly by callers that need to surface non-field-level errors.
 *
 * Phase 4 / STR-115.
 */

import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

export interface FormErrorProps {
  readonly id?: string;
  readonly children?: ReactNode;
  readonly className?: string;
  /** Render variant: inline (default) or block. */
  readonly variant?: 'inline' | 'block';
}

export function FormError({
  id,
  children,
  className,
  variant = 'inline',
}: FormErrorProps) {
  if (!children) return null;

  if (variant === 'block') {
    return (
      <div
        id={id}
        role="alert"
        className={
          className ??
          'mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 ' +
            'flex items-start gap-2 text-sm text-rose-800'
        }
      >
        <AlertCircle size={15} className="mt-0.5 flex-shrink-0 text-rose-500" />
        <span>{children}</span>
      </div>
    );
  }

  return (
    <p
      id={id}
      role="alert"
      className={className ?? 'mt-1 text-xs text-rose-600 flex items-center gap-1'}
    >
      <AlertCircle size={11} className="flex-shrink-0" />
      <span>{children}</span>
    </p>
  );
}
