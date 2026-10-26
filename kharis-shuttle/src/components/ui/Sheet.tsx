"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Sticky-ish footer area (usually the confirm Button). */
  footer?: ReactNode;
  /** Hide the ✕ button. */
  hideClose?: boolean;
};

const noop = () => () => {};
function useIsClient() {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/**
 * Bottom sheet (centred dialog on ≥768px). Backdrop tap and Escape close it;
 * body scroll is locked while open. Rendered into a portal on document.body so
 * transformed ancestors cannot trap it.
 */
export function Sheet({ open, onClose, title, children, footer, hideClose }: SheetProps) {
  const isClient = useIsClient();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => panelRef.current?.focus(), 30);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open || !isClient) return null;

  return createPortal(
    <>
      <div className="k-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="k-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        style={{ outline: "none" }}
      >
        <div className="k-sheet-grip" />
        {title || !hideClose ? (
          <div className="flex items-center justify-between gap-3" style={{ marginBottom: 12 }}>
            <h2 className="k-group-title" style={{ fontSize: 20 }}>
              {title}
            </h2>
            {!hideClose ? (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  background: "var(--surface-3)",
                  color: "var(--text-2)",
                  fontSize: 15,
                  fontWeight: 700,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                ✕
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-col gap-3">{children}</div>
        {footer ? <div style={{ marginTop: 16 }}>{footer}</div> : null}
      </div>
    </>,
    document.body,
  );
}
