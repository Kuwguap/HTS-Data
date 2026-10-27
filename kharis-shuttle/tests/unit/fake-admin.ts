/**
 * A scripted stand-in for the service-role Supabase client used by route tests.
 * `from(table)` returns a chainable query builder that records the table, the
 * operation, the payload, every filter and the terminal call, then asks `respond`
 * for the result. Calls are logged in EXECUTION order (at the terminal call), so a
 * test can assert that one statement ran before another.
 */
import { vi } from "vitest";

export type FakeFilter = { method: string; args: unknown[] };

export type FakeCall = {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  columns?: string;
  filters: FakeFilter[];
  terminal: "maybeSingle" | "single" | "list";
};

export type FakeResult = { data: unknown; error: { code?: string; message: string } | null };
export type Responder = (call: FakeCall, index: number) => FakeResult | undefined;

const FILTERS = ["eq", "neq", "in", "gt", "gte", "lt", "lte", "is", "order", "limit", "not", "like", "ilike"] as const;

export function fakeAdmin(respond: Responder, rpcImpl?: (name: string, args: Record<string, unknown>) => Promise<FakeResult>) {
  const calls: FakeCall[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => (rpcImpl ? rpcImpl(name, args) : { data: null, error: null }));

  function from(table: string) {
    const call: FakeCall = { table, op: "select", filters: [], terminal: "list" };
    let opSet = false;
    const run = (terminal: FakeCall["terminal"]): Promise<FakeResult> => {
      call.terminal = terminal;
      calls.push(call);
      return Promise.resolve(respond(call, calls.length - 1) ?? { data: terminal === "list" ? [] : null, error: null });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {
      select: (columns = "*") => {
        if (!opSet) call.op = "select";
        call.columns = columns;
        return api;
      },
      insert: (payload: unknown) => ((call.op = "insert"), (opSet = true), (call.payload = payload), api),
      update: (payload: unknown) => ((call.op = "update"), (opSet = true), (call.payload = payload), api),
      delete: () => ((call.op = "delete"), (opSet = true), api),
      maybeSingle: () => run("maybeSingle"),
      single: () => run("single"),
      then: (resolve: (v: FakeResult) => unknown, reject?: (e: unknown) => unknown) => run("list").then(resolve, reject),
    };
    for (const method of FILTERS) {
      api[method] = (...args: unknown[]) => {
        call.filters.push({ method, args });
        return api;
      };
    }
    return api;
  }

  const client = { from: vi.fn(from), rpc };
  return { client, calls, rpc };
}

/** The filter `method(column, …)` recorded on a call, or undefined. */
export function filterOf(call: FakeCall, method: string, column: string): FakeFilter | undefined {
  return call.filters.find((f) => f.method === method && f.args[0] === column);
}
