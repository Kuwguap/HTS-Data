import type { ApiErrorBody, ApiErrorCode } from "@/lib/api";

/** Thrown by the browser API helper when a route handler returns an error body. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** First field-level validation message for a given path, if any. */
  fieldError(field: string): string | undefined {
    const d = this.details as { fieldErrors?: Record<string, string[]> } | undefined;
    return d?.fieldErrors?.[field]?.[0];
  }
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      ...init,
    });
  } catch {
    throw new ApiClientError(0, "INTERNAL", "No connection. Check your internet and try again.");
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error;
    if (res.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      // Session gone: send them to log in, remembering where they were.
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.assign(`/login?next=${next}`);
    }
    throw new ApiClientError(
      res.status,
      err?.code ?? "INTERNAL",
      err?.message ?? "Something went wrong. Try again.",
      err?.details,
    );
  }
  return json as T;
}

/** Small typed fetch wrapper for calling our own /api routes from client components. */
export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>("GET", path, undefined, init),
  post: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>("POST", path, body ?? {}, init),
  patch: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>("PATCH", path, body ?? {}, init),
  put: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>("PUT", path, body ?? {}, init),
  delete: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>("DELETE", path, body, init),
};

/** Human message for any thrown value. */
export function errorMessage(err: unknown, fallback = "Something went wrong. Try again."): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
