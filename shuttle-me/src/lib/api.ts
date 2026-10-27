import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";

/** Error codes shared between route handlers and the UI. */
export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "LOCKED"
  | "TRIP_NOT_OPEN"
  | "BOOKING_CLOSED"
  | "ALREADY_BOOKED"
  | "PICKUP_INVALID"
  | "INVALID_CREDENTIALS"
  | "USERNAME_TAKEN"
  | "SIGNUP_CODE"
  | "INTERNAL";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type ApiErrorBody = { error: { code: ApiErrorCode; message: string; details?: unknown } };

export function ok<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, { status: 200, ...init });
}

export function fail(status: number, code: ApiErrorCode, message: string, details?: unknown) {
  return NextResponse.json<ApiErrorBody>({ error: { code, message, details } }, { status });
}

/** Map a Postgres error raised by our SQL functions (errcode P0001 + message) to an ApiError. */
export function fromPostgresError(err: unknown): ApiError {
  const e = err as { message?: string; code?: string; details?: string } | null;
  const message = e?.message ?? "Database error";
  const known: ApiErrorCode[] = [
    "TRIP_NOT_OPEN",
    "BOOKING_CLOSED",
    "ALREADY_BOOKED",
    "PICKUP_INVALID",
    "NOT_FOUND",
    "FORBIDDEN",
    "CONFLICT",
  ];
  for (const code of known) {
    if (message.startsWith(code)) {
      const status = code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? 403 : 409;
      return new ApiError(status, code, message.replace(/^[A-Z_]+:?\s*/, "") || message);
    }
  }
  if (e?.code === "23505") return new ApiError(409, "CONFLICT", "That already exists.");
  // Unknown driver/Postgres error: keep the raw text in the server log only; the client
  // gets the generic message with no details.
  console.error("[api] database error", e?.code ?? "", message);
  return new ApiError(500, "INTERNAL", "Something went wrong. Try again.");
}

/** Parse a JSON body with a zod schema; throws ApiError(400, VALIDATION). */
export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw new ApiError(400, "VALIDATION", "Body must be JSON");
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ApiError(400, "VALIDATION", "Please check the form.", result.error.flatten());
  }
  return result.data;
}

type Handler<Ctx> = (request: Request, ctx: Ctx) => Promise<Response>;

/**
 * Wrap a route handler so thrown ApiError / ZodError / unknown errors become
 * consistent JSON responses.
 */
export function withHandler<Ctx = unknown>(handler: Handler<Ctx>): Handler<Ctx> {
  return async (request, ctx) => {
    try {
      return await handler(request, ctx);
    } catch (err) {
      if (err instanceof ApiError) {
        return fail(err.status, err.code, err.message, err.details);
      }
      if (err instanceof ZodError) {
        return fail(400, "VALIDATION", "Please check the form.", err.flatten());
      }
      console.error("[api] unhandled", err);
      return fail(500, "INTERNAL", "Something went wrong. Try again.");
    }
  };
}

/** Next 16 route handler context: params is a Promise. */
export type RouteCtx<P extends Record<string, string> = Record<string, string>> = { params: Promise<P> };
