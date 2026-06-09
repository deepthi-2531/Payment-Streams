/**
 * Modal — backdrop + centered card with the cc-streams aesthetic.
 *
 * Closes on:
 *   - Escape key
 *   - backdrop click (unless `onBackdropClick` is overridden)
 */
import { useEffect, type ReactNode } from 'react';
import { Icons } from '../primitives/Icons.js';

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly width?: number;
  /** Override to false to disable backdrop-click-to-close. */
  readonly closeOnBackdrop?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 480,
  closeOnBackdrop = true,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            padding: '20px 24px 12px',
            gap: 12,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              id="modal-title"
              style={{
                margin: 0,
                fontSize: 16,
                fontWeight: 600,
                color: 'var(--fg)',
              }}
            >
              {title}
            </h2>
            {subtitle && (
              <p
                style={{
                  margin: '4px 0 0',
                  fontSize: 12.5,
                  color: 'var(--fg-3)',
                }}
              >
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            aria-label="Close"
            style={{ padding: 6, borderRadius: 6, color: 'var(--fg-3)' }}
          >
            <Icons.Close size={16} />
          </button>
        </div>
        <div style={{ padding: '8px 24px 20px' }}>{children}</div>
        {footer && (
          <div
            style={{
              padding: '16px 24px',
              borderTop: '1px solid var(--line)',
              background: 'var(--card-2)',
              borderBottomLeftRadius: 'var(--r-xl)',
              borderBottomRightRadius: 'var(--r-xl)',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
