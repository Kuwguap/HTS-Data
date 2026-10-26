"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api-client";

export type LogoutButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pill?: boolean;
  className?: string;
  children?: ReactNode;
};

/** POST /api/auth/logout then go to /login. Reusable on every role's "Me" screen. */
export function LogoutButton({ variant = "dangerSoft", size = "md", pill, className, children }: LogoutButtonProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post("/api/auth/logout");
    } catch {
      // The cookie is gone either way once we leave; nothing useful to show.
    }
    toast("👋 Logged out");
    router.replace("/login");
    router.refresh();
  };

  return (
    <Button variant={variant} size={size} pill={pill} className={className} loading={busy} onClick={logout}>
      {children ?? "🚪 Log out"}
    </Button>
  );
}
