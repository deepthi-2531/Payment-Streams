/**
 * Shared in-page wallet picker modal.
 *
 * Rendered in the dashboard DOM (same 'self' origin — scripts run, inline
 * styles allowed by `style-src 'unsafe-inline'`), NOT in a blob:-URL popup
 * (whose inline <script> our `script-src 'self'` CSP blanks out). Used by the
 * dapp-sdk layer (its discovered wallets) and the combined layer (PartyLayer +
 * dapp-sdk merged).
 *
 * `onChoose` runs SYNCHRONOUSLY inside the row-click event handler, so callers
 * can open a user-gesture-bound popup (the gateway login) right there before
 * any await.
 */

export interface WalletPickerRow {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  /** Short route/layer label shown on the right of the row (e.g. "Gateway",
   * "Loop", "Extension"). */
  readonly badge?: string;
  /** Not-installed catalog entries: shown greyed out, not selectable. */
  readonly disabled?: boolean;
  readonly installUrl?: string;
}

export interface WalletPickerModalHandlers {
  /** Called synchronously in the row-click gesture with the chosen row. */
  onChoose: (row: WalletPickerRow) => void;
  /** Called on backdrop click / Cancel / Escape. */
  onCancel: () => void;
}

export interface WalletPickerModalHandle {
  close(): void;
}

const PICKER_MODAL_ID = 'streams-dapp-wallet-picker';

/**
 * Build and mount the picker modal. Returns a handle to close it
 * programmatically; it also auto-removes on choose/cancel.
 */
export function openWalletPickerModal(
  rows: readonly WalletPickerRow[],
  handlers: WalletPickerModalHandlers,
  opts?: { title?: string },
): WalletPickerModalHandle {
  const noop: WalletPickerModalHandle = { close: () => {} };
  if (typeof document === 'undefined') return noop;

  document.getElementById(PICKER_MODAL_ID)?.remove();

  const overlay = document.createElement('div');
  overlay.id = PICKER_MODAL_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', opts?.title ?? 'Connect a wallet');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483000',
    'background:rgba(4,8,10,0.72)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:20px',
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
  ].join(';');

  const card = document.createElement('div');
  card.style.cssText = [
    'width:min(400px,100%)',
    'max-height:80vh',
    'overflow:auto',
    'background:#12171a',
    'color:#e6e8ea',
    'border:1px solid rgba(255,255,255,0.08)',
    'border-radius:16px',
    'box-shadow:0 24px 70px rgba(0,0,0,0.6)',
    'padding:20px',
  ].join(';');

  const heading = document.createElement('div');
  heading.textContent = opts?.title ?? 'Connect a wallet';
  heading.style.cssText = 'font-size:17px;font-weight:650;margin:0 0 14px 2px;';
  card.appendChild(heading);

  let settled = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') cancel();
  };
  const cleanup = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const choose = (row: WalletPickerRow) => {
    if (settled) return;
    settled = true;
    cleanup();
    handlers.onChoose(row);
  };
  function cancel() {
    if (settled) return;
    settled = true;
    cleanup();
    handlers.onCancel();
  }

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No wallets available.';
    empty.style.cssText = 'opacity:0.7;font-size:13px;padding:8px 2px;';
    card.appendChild(empty);
  }

  for (const row of rows) {
    const el = document.createElement('button');
    el.type = 'button';
    el.disabled = Boolean(row.disabled);
    el.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:12px',
      'width:100%',
      'text-align:left',
      `background:rgba(255,255,255,${row.disabled ? '0.015' : '0.03'})`,
      'color:inherit',
      'border:1px solid rgba(255,255,255,0.08)',
      'border-radius:12px',
      'padding:14px',
      'margin:0 0 10px 0',
      row.disabled ? 'cursor:default' : 'cursor:pointer',
      'font:inherit',
      row.disabled ? 'opacity:0.5' : 'opacity:1',
    ].join(';');
    if (!row.disabled) {
      el.addEventListener('mouseenter', () => {
        el.style.background = 'rgba(70,211,154,0.12)';
        el.style.borderColor = 'rgba(70,211,154,0.5)';
      });
      el.addEventListener('mouseleave', () => {
        el.style.background = 'rgba(255,255,255,0.03)';
        el.style.borderColor = 'rgba(255,255,255,0.08)';
      });
    }

    if (row.icon) {
      const img = document.createElement('img');
      img.src = row.icon;
      img.alt = '';
      img.style.cssText =
        'width:28px;height:28px;border-radius:7px;flex:0 0 auto;object-fit:contain;';
      el.appendChild(img);
    }

    const textCol = document.createElement('span');
    textCol.style.cssText =
      'display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;';
    const nameEl = document.createElement('span');
    nameEl.textContent =
      row.name + (row.disabled ? ' — not installed' : '');
    nameEl.style.cssText = 'font-size:14.5px;font-weight:600;';
    textCol.appendChild(nameEl);
    if (row.description) {
      const descEl = document.createElement('span');
      descEl.textContent = row.description;
      descEl.style.cssText = 'font-size:12px;opacity:0.6;';
      textCol.appendChild(descEl);
    }
    el.appendChild(textCol);

    if (row.badge) {
      const badgeEl = document.createElement('span');
      badgeEl.textContent = row.badge;
      badgeEl.style.cssText = [
        'flex:0 0 auto',
        'font-size:10.5px',
        'font-weight:600',
        'letter-spacing:0.02em',
        'text-transform:uppercase',
        'color:#8aa',
        'background:rgba(255,255,255,0.06)',
        'border:1px solid rgba(255,255,255,0.08)',
        'border-radius:999px',
        'padding:3px 8px',
      ].join(';');
      el.appendChild(badgeEl);
    }

    if (!row.disabled) {
      el.addEventListener('click', () => choose(row));
    } else if (row.installUrl) {
      // A disabled/not-installed row: clicking opens its install page.
      el.disabled = false;
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        window.open(row.installUrl, '_blank', 'noopener,noreferrer');
      });
    }
    card.appendChild(el);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText =
    'display:block;margin:6px auto 0;background:none;border:none;color:#9aa3a8;font:inherit;font-size:13px;cursor:pointer;';
  cancelBtn.addEventListener('click', cancel);
  card.appendChild(cancelBtn);

  overlay.appendChild(card);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cancel();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);

  return { close: cleanup };
}
