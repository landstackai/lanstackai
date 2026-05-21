'use client';

// Two-step delete confirmation button.
//
// Nothing's more frustrating than nuking a comp by accident, so any
// destructive button in the app should route through this component.
//
// Interaction model (deliberately simple — broker is one-handed at the
// truck or in a meeting, so we want it obvious and forgiving):
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │  state: idle      → click → state: confirming                   │
//   │     ↑                                                           │
//   │     │  auto-revert after 5s OR click outside OR press Escape    │
//   │     │                                                           │
//   │  state: confirming → click → onConfirm() fires + reset to idle  │
//   └─────────────────────────────────────────────────────────────────┘
//
// Variants:
//   - "icon"  → compact trash icon (table rows where space is tight)
//   - "label" → full "Delete" pill (right panels where the action
//               needs to be discoverable, not just hover-revealed)
//
// In confirming state the button widens to fit "Confirm delete?" so the
// click target grows — easier to hit deliberately, harder to mis-tap.
// The 5-second auto-revert is on the long side intentionally: brokers
// often pause mid-click to double-check the row before committing.
//
// stopPropagation is built into the click handler — every consumer of
// this lives inside a clickable parent (table row, card) where bubbling
// would navigate away mid-confirmation. We always stop the bubble.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, X } from 'lucide-react';

type Variant = 'icon' | 'label';

interface DeleteConfirmButtonProps {
  /** What to do when the user confirms. Can be async — the button shows
      a "Deleting…" state while it runs. */
  onConfirm: () => void | Promise<void>;
  /** "icon" for tight rows, "label" for prominent placement. */
  variant?: Variant;
  /** Optional override for the initial-state label (label variant only). */
  label?: string;
  /** Optional override for the confirming-state label. */
  confirmLabel?: string;
  /** Tooltip on the idle-state button (icon variant). */
  title?: string;
  /** Tailwind extra classes for the outer button. */
  className?: string;
  /** Disable the button (used during parent-level pending states). */
  disabled?: boolean;
}

const AUTO_REVERT_MS = 5000;

export default function DeleteConfirmButton({
  onConfirm,
  variant = 'icon',
  label = 'Delete',
  confirmLabel = 'Confirm delete?',
  title = 'Delete',
  className = '',
  disabled = false,
}: DeleteConfirmButtonProps) {
  const [state, setState] = useState<'idle' | 'confirming' | 'deleting'>('idle');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const reset = useCallback(() => {
    clearTimer();
    setState('idle');
  }, []);

  // Outside-click + Escape revert. Only attach while confirming so we
  // don't spam global listeners. stopPropagation on the button click
  // keeps the click that ENTERED confirming from immediately exiting.
  useEffect(() => {
    if (state !== 'confirming') return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) reset();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') reset();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    timerRef.current = setTimeout(reset, AUTO_REVERT_MS);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      clearTimer();
    };
  }, [state, reset]);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (disabled || state === 'deleting') return;
    if (state === 'idle') {
      setState('confirming');
      return;
    }
    // state === 'confirming' → fire the actual delete
    clearTimer();
    setState('deleting');
    try {
      await onConfirm();
      // Caller usually navigates away or refetches; if the button is
      // still mounted, return it to idle.
      setState('idle');
    } catch {
      setState('idle');
    }
  };

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    reset();
  };

  // ─── ICON VARIANT ───────────────────────────────────────────────────
  // Idle: small ghost trash. Confirming: red pill with "Confirm
  // delete?" + a tiny X to bail. The wider hit area makes the
  // confirm-click forgiving.
  if (variant === 'icon') {
    if (state === 'idle') {
      return (
        <button
          onClick={handleClick}
          disabled={disabled}
          title={title}
          className={`p-1 rounded text-ink-2 hover:text-red-600 hover:bg-red-50 disabled:opacity-40 transition-colors ${className}`}
        >
          <Trash2 size={12} />
        </button>
      );
    }
    return (
      <div ref={containerRef} className="inline-flex items-center gap-0.5">
        <button
          onClick={handleClick}
          disabled={state === 'deleting'}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 transition-colors"
        >
          <Trash2 size={11} />
          {state === 'deleting' ? 'Deleting…' : confirmLabel}
        </button>
        <button
          onClick={handleCancel}
          disabled={state === 'deleting'}
          title="Cancel"
          className="p-1 rounded text-ink-2 hover:text-ink hover:bg-cream transition-colors"
        >
          <X size={11} />
        </button>
      </div>
    );
  }

  // ─── LABEL VARIANT ──────────────────────────────────────────────────
  // Larger, discoverable. Idle: ghost button with red text on hover.
  // Confirming: solid red with the confirm label + cancel X.
  if (state === 'idle') {
    return (
      <button
        onClick={handleClick}
        disabled={disabled}
        title={title}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold text-ink-2 border border-beige hover:text-red-600 hover:border-red-200 hover:bg-red-50 disabled:opacity-40 transition-colors ${className}`}
      >
        <Trash2 size={13} />
        {label}
      </button>
    );
  }
  return (
    <div ref={containerRef} className="inline-flex items-center gap-1">
      <button
        onClick={handleClick}
        disabled={state === 'deleting'}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 transition-colors"
      >
        <Trash2 size={13} />
        {state === 'deleting' ? 'Deleting…' : confirmLabel}
      </button>
      <button
        onClick={handleCancel}
        disabled={state === 'deleting'}
        title="Cancel"
        className="p-1.5 rounded-md text-ink-2 hover:text-ink hover:bg-cream transition-colors"
      >
        <X size={13} />
      </button>
    </div>
  );
}
