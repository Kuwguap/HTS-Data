"use client";

import { useEffect, type ReactNode } from "react";
import { ServiceWorkerRegistrar } from "@/components/pwa/ServiceWorkerRegistrar";
import { ToastProvider } from "@/components/ui/Toast";

/**
 * Mirrors the system colour scheme onto `<html data-theme>` so non-CSS code
 * (map tiles, charts) can read it, and keeps it live when the phone switches.
 * The CSS itself already follows prefers-color-scheme without this.
 */
function ThemeSync() {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return null;
}

/** Client providers for the root layout: toast host, service worker, theme attribute. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ThemeSync />
      <ServiceWorkerRegistrar />
      {children}
    </ToastProvider>
  );
}
