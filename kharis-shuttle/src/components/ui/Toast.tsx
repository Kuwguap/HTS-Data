"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastTone = "green" | "red" | "amber";

export type ToastOptions = {
  tone?: ToastTone;
  /** Auto-hide delay in ms (default 3000). `0` keeps it until tapped or replaced. */
  ms?: number;
  /** Called when the toast is tapped; the toast closes afterwards. */
  onTap?: () => void;
};

export type ToastFn = (message: string, options?: ToastOptions) => void;

type ToastState = { id: number; message: string; tone?: ToastTone; onTap?: () => void };

const ToastContext = createContext<{ toast: ToastFn; dismiss: () => void } | null>(null);

/**
 * Hosts the black "island" toast at the top of the screen. One toast at a time;
 * a new call replaces the current one.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ToastState | null>(null);
  const timer = useRef<number | null>(null);
  const seq = useRef(0);

  const dismiss = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setCurrent(null);
  }, []);

  const toast = useCallback<ToastFn>((message, options) => {
    if (timer.current) window.clearTimeout(timer.current);
    seq.current += 1;
    setCurrent({ id: seq.current, message, tone: options?.tone, onTap: options?.onTap });
    const ms = options?.ms ?? 3000;
    timer.current = ms > 0 ? window.setTimeout(() => setCurrent(null), ms) : null;
  }, []);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {current ? (
        <button
          key={current.id}
          type="button"
          className={["k-toast", current.tone ? `k-toast--${current.tone}` : "", current.message.length > 48 ? "k-toast--wrap" : ""].filter(Boolean).join(" ")}
          role="status"
          aria-live="polite"
          onClick={() => {
            current.onTap?.();
            dismiss();
          }}
        >
          {current.message}
        </button>
      ) : null}
    </ToastContext.Provider>
  );
}

/**
 * ```ts
 * const { toast } = useToast();
 * toast("✅ Seat reserved", { tone: "green" });
 * toast("⚠️ Could not book — try again", { tone: "red" });
 * ```
 */
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider> (see components/providers/Providers)");
  return ctx;
}
