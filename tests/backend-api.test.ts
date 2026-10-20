import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { webcrypto } from "node:crypto";
import { transform } from "esbuild";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const groupId = "10000000-0000-4000-8000-000000000001";
const otherGroupId = "10000000-0000-4000-8000-000000000002";
const eventId = "20000000-0000-4000-8000-000000000001";
const user = { id: "40000000-0000-4000-8000-000000000001", groupId, displayName: "Synthetic member", role: "member" };

type QueryCall = { table: string; action: string; selection?: string; filters: Array<[string, unknown, unknown]>; values?: unknown };

class Query {
  action = "select";
  selection?: string;
  filters: QueryCall["filters"] = [];
  values?: unknown;

  constructor(private readonly db: FakeDb, private readonly table: string) {}
  select(selection: string) { this.selection = selection; return this; }
  insert(values: unknown) { this.action = "insert"; this.values = values; return this; }
  update(values: unknown) { this.action = "update"; this.values = values; return this; }
  upsert(values: unknown) { this.action = "upsert"; this.values = values; return this; }
  delete() { this.action = "delete"; return this; }
  eq(field: string, value: unknown) { this.filters.push(["eq", field, value]); return this; }
  gt(field: string, value: unknown) { this.filters.push(["gt", field, value]); return this; }
  is(field: string, value: unknown) { this.filters.push(["is", field, value]); return this; }
  order() { return this; }
  maybeSingle() { return this.execute(true); }
  single() { return this.execute(true); }
  then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
    return this.execute(false).then(resolve, reject);
  }
  private execute(single: boolean) {
    const call: QueryCall = { table: this.table, action: this.action, selection: this.selection, filters: this.filters, values: this.values };
    this.db.calls.push(call);
    return Promise.resolve(this.db.resolve(call, single));
  }
}

class FakeDb {
  calls: QueryCall[] = [];
  rpcCalls: Array<[string, Record<string, unknown>]> = [];
  constructor(readonly actor = user, readonly eventGroupId = groupId) {}
  from(table: string) { return new Query(this, table); }
  rpc(name: string, args: Record<string, unknown>) {
    this.rpcCalls.push([name, args]);
    return { maybeSingle: async () => ({ data: null, error: null }) };
  }
  resolve(call: QueryCall, single: boolean) {
    const filter = (name: string) => call.filters.find(([, field]) => field === name)?.[2];
    const result = (data: unknown) => ({ data: single && Array.isArray(data) ? data[0] ?? null : data, error: null });
    if (call.table === "qp_sessions") {
      return result({ id: "session-row", member_id: this.actor.id, expires_at: "2099-01-01T00:00:00Z", qp_members: {
        id: this.actor.id, group_id: this.actor.groupId, display_name: this.actor.displayName, role: this.actor.role,
      } });
    }
    if (call.table === "qp_events" && call.action === "select") {
      const matches = filter("group_id") === this.eventGroupId && filter("id") === eventId;
      return result(matches ? [{ id: eventId }] : []);
    }
    if (call.table === "qp_events" && call.action === "update") return result([]);
    if (call.table === "qp_events") return result([]);
    if (call.table === "qp_tasks" && call.action === "select") return result([]);
    if (call.table === "qp_tasks") return result([]);
    if (call.table === "qp_rsvps") return result([]);
    if (call.table === "qp_members") return result([]);
    return result([]);
  }
}

async function loadHandler(db: FakeDb) {
  let handler: ((request: Request) => Promise<Response>) | undefined;
  let source = await readFile(resolve(root, "backend/index.ts"), "utf8");
  source = source.replace(/^import \{ createClient \} from "npm:@supabase\/supabase-js@2\.118\.0";\r?\n/m, "const createClient = __createClient;\n");
  const javascript = (await transform(source, { loader: "ts", format: "iife", target: "es2022" })).code;
  const Deno = {
    env: { get: (name: string) => ({ SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-server-key" } as Record<string, string>)[name] },
    serve: (callback: (request: Request) => Promise<Response>) => { handler = callback; (Deno as any).__handler = callback; },
  };
  new Function("Deno", "__createClient", "crypto", "console", `${javascript}\nreturn Deno.__handler;`)(Deno, () => db, webcrypto, { error() {} });
  if (!handler) throw new Error("Backend did not register a Deno handler");
  return handler;
}

const request = (path: string, options: { method?: string; body?: unknown; origin?: string; token?: string } = {}) => new Request(`https://synthetic.invalid/functions/v1/backend/${path}`, {
  method: options.method ?? "GET",
  headers: {
    ...(options.origin ? { Origin: options.origin } : {}),
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
  },
  ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
});

describe("planner Edge Function authorization and response boundary", () => {
  it("keeps successful and error responses CORS-readable only by an allowed origin", async () => {
    const handler = await loadHandler(new FakeDb());
    const success = await handler(request("state", { origin: "http://localhost:5173", token: "synthetic-token" }));
    expect(success.status).toBe(200);
    expect(success.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(success.headers.get("Cache-Control")).toBe("no-store");

    const preflight = await handler(request("state", { method: "OPTIONS", origin: "http://localhost:5173" }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");

    const error = await handler(request("unlisted-route", { origin: "http://localhost:5173", token: "synthetic-token" }));
    expect(error.status).toBe(404);
    expect(error.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(error.headers.get("Vary")).toBe("Origin");

    const denied = await handler(request("state", { origin: "https://attacker.invalid", token: "synthetic-token" }));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBe("null");
  });

  it("does not return the session row or stored hash fields in authenticated state", async () => {
    const db = new FakeDb();
    const handler = await loadHandler(db);
    const response = await handler(request("state", { origin: "http://localhost:5173", token: "synthetic-session-secret" }));
    const payload = await response.json();
    const serialized = JSON.stringify(payload);
    expect(response.status).toBe(200);
    expect(serialized).not.toContain("synthetic-session-secret");
    expect(serialized).not.toContain("token_hash");
    expect(serialized).not.toContain("invite_code_hash");
    const sessionRead = db.calls.find((call) => call.table === "qp_sessions");
    expect(sessionRead?.selection).not.toContain("token_hash");
  });

  it("scopes an RSVP event lookup to the caller's group and never writes for another group's event", async () => {
    const db = new FakeDb(user, otherGroupId);
    const handler = await loadHandler(db);
    const response = await handler(request("rsvp", {
      method: "POST", token: "synthetic-session-secret",
      body: { eventId, status: "going", count: 1, rideNeeded: 0, seatsOffered: 0, notes: "" },
    }));
    expect(response.status).toBe(404);
    const lookup = db.calls.find((call) => call.table === "qp_events");
    expect(lookup?.filters).toContainEqual(["eq", "group_id", groupId]);
    expect(db.calls.some((call) => call.table === "qp_rsvps" && call.action === "upsert")).toBe(false);
  });

  it("binds a claim RPC to the authenticated group and reports a cross-group task as missing", async () => {
    const db = new FakeDb();
    const handler = await loadHandler(db);
    const taskId = "30000000-0000-4000-8000-000000000001";
    const response = await handler(request("claim", { method: "POST", token: "synthetic-session-secret", body: { taskId, claim: true } }));
    expect(response.status).toBe(404);
    expect(db.rpcCalls).toEqual([["qp_claim_task", {
      p_task_id: taskId, p_group_id: groupId, p_member_id: user.id, p_claim: true,
    }]]);
  });

  it("rejects member event edits before touching event data and rejects impossible owner dates", async () => {
    const memberDb = new FakeDb();
    const memberHandler = await loadHandler(memberDb);
    const memberResponse = await memberHandler(request("event", {
      method: "POST", token: "synthetic-session-secret",
      body: { eventId, expectedUpdatedAt: "2026-10-20T00:00:00Z", patch: { location: "Changed" } },
    }));
    expect(memberResponse.status).toBe(403);
    expect(memberDb.calls.some((call) => call.table === "qp_events")).toBe(false);

    const ownerDb = new FakeDb({ ...user, role: "owner" });
    const ownerHandler = await loadHandler(ownerDb);
    const invalidDateResponse = await ownerHandler(request("event", {
      method: "POST", token: "synthetic-session-secret",
      body: { eventId, expectedUpdatedAt: "2026-10-20T00:00:00Z", patch: { eventDate: "2026-02-30" } },
    }));
    expect(invalidDateResponse.status).toBe(400);
    expect(ownerDb.calls.some((call) => call.action === "update")).toBe(false);
  });

  it("refuses requests without a bearer session", async () => {
    const db = new FakeDb();
    const handler = await loadHandler(db);
    const response = await handler(request("state"));
    expect(response.status).toBe(401);
    expect(db.calls).toHaveLength(0);
  });
});
