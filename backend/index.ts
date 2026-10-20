import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ??
  (() => {
    try {
      return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default;
    } catch {
      return undefined;
    }
  })();

if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase server environment");

const db = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const baseOrigins = ["http://localhost:5173", "http://127.0.0.1:5173", "https://conrarclutch.github.io"];
const allowedOrigins = new Set([
  ...baseOrigins,
  ...(Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
]);
const corsHeaders = (origin: string | null): Record<string, string> => ({
  "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "null",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
});

const camelize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), camelize(child),
    ]));
  }
  return value;
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (body: unknown, status = 200, origin: string | null = null) =>
  new Response(JSON.stringify(camelize(body)), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const applyOrigin = (response: Response, origin: string | null) => {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin && allowedOrigins.has(origin) ? origin : "null");
  headers.set("Vary", "Origin");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

const sha256 = async (value: string) => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const objectBody = async (req: Request): Promise<Record<string, unknown>> => {
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Request body must be an object");
  return value as Record<string, unknown>;
};

const stringValue = (v: unknown, name: string, min: number, max: number) => {
  if (typeof v !== "string" || v.trim().length < min || v.trim().length > max) {
    throw new HttpError(400, `${name} must be ${min}-${max} characters`);
  }
  return v.trim();
};

const optionalText = (v: unknown, name: string, max: number): string | null => {
  if (v === null || v === undefined || v === "") return null;
  return stringValue(v, name, 1, max);
};

const intValue = (v: unknown, name: string, min: number, max: number) => {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new HttpError(400, `${name} must be an integer from ${min} to ${max}`);
  return v as number;
};

const authenticate = async (req: Request) => {
  const token = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token || token.length > 200) throw new HttpError(401, "A valid session is required");
  const { data, error } = await db.from("qp_sessions").select("id, member_id, expires_at, qp_members!inner(id, group_id, display_name, role)")
    .eq("token_hash", await sha256(token)).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (error) throw new Error("Could not verify session");
  if (!data) throw new HttpError(401, "Session expired or invalid");
  const member = Array.isArray(data.qp_members) ? data.qp_members[0] : data.qp_members;
  if (!member) throw new HttpError(401, "Session expired or invalid");
  return { id: member.id as string, groupId: member.group_id as string, displayName: member.display_name as string, role: member.role as string };
};

const assertEventInGroup = async (eventId: unknown, groupId: string) => {
  const id = stringValue(eventId, "eventId", 36, 36);
  const { data, error } = await db.from("qp_events").select("id").eq("id", id).eq("group_id", groupId).maybeSingle();
  if (error) throw new Error("Could not verify event");
  if (!data) throw new HttpError(404, "Event not found");
  return id;
};

const routes: Record<string, (req: Request, user?: Awaited<ReturnType<typeof authenticate>>) => Promise<Response>> = {
  "/join": async (req) => {
    const body = await objectBody(req);
    const inviteCode = stringValue(body.inviteCode, "inviteCode", 6, 200);
    const displayName = stringValue(body.displayName, "displayName", 2, 60);
    const ownerCode = body.ownerCode == null || body.ownerCode === "" ? null : stringValue(body.ownerCode, "ownerCode", 6, 200);
    const inviteHash = await sha256(inviteCode);
    const { data: group, error } = await db.from("qp_groups").select("id, owner_code_hash").eq("invite_code_hash", inviteHash).maybeSingle();
    if (error) throw new Error("Could not look up invite");
    if (!group) throw new HttpError(403, "Invite code is invalid");
    const isOwner = ownerCode !== null && await sha256(ownerCode) === group.owner_code_hash;
    if (ownerCode && !isOwner) throw new HttpError(403, "Owner code is invalid");
    const { data: member, error: memberError } = await db.from("qp_members").insert({
      group_id: group.id, display_name: displayName, role: isOwner ? "owner" : "member",
    }).select("id, group_id, display_name, role").single();
    if (memberError || !member) throw new Error("Could not create member");
    const token = randomToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error: sessionError } = await db.from("qp_sessions").insert({ member_id: member.id, token_hash: await sha256(token), expires_at: expiresAt });
    if (sessionError) {
      await db.from("qp_members").delete().eq("id", member.id);
      throw new Error("Could not create session");
    }
    return json({ token, expiresAt, member: { id: member.id, displayName: member.display_name, role: member.role } });
  },

  "/state": async (_req, user) => {
    const groupId = user!.groupId;
    const [events, tasks, rsvps, members] = await Promise.all([
      db.from("qp_events").select("*").eq("group_id", groupId).order("event_date"),
      db.from("qp_tasks").select("*").eq("group_id", groupId).order("created_at"),
      db.from("qp_rsvps").select("id, event_id, member_id, status, count, ride_needed, seats_offered, notes, updated_at").eq("group_id", groupId),
      db.from("qp_members").select("id, display_name, role").eq("group_id", groupId).order("display_name"),
    ]);
    for (const result of [events, tasks, rsvps, members]) if (result.error) throw new Error("Could not load group state");
    return json({
      member: { id: user!.id, displayName: user!.displayName, role: user!.role },
      events: events.data, tasks: tasks.data, rsvps: rsvps.data,
      members: members.data,
    });
  },

  "/rsvp": async (req, user) => {
    const body = await objectBody(req);
    const eventId = await assertEventInGroup(body.eventId, user!.groupId);
    if (!["going", "maybe", "declined"].includes(String(body.status))) throw new HttpError(400, "status must be going, maybe, or declined");
    const count = intValue(body.count, "count", 1, 20);
    const rideNeeded = intValue(body.rideNeeded, "rideNeeded", 0, count);
    const seatsOffered = intValue(body.seatsOffered, "seatsOffered", 0, 12);
    const notes = body.notes == null ? "" : stringValue(body.notes, "notes", 0, 500);
    const { data, error } = await db.from("qp_rsvps").upsert({
      group_id: user!.groupId, event_id: eventId, member_id: user!.id,
      status: body.status, count, ride_needed: rideNeeded, seats_offered: seatsOffered, notes,
    }, { onConflict: "event_id,member_id" }).select("id, event_id, member_id, status, count, ride_needed, seats_offered, notes, updated_at").single();
    if (error || !data) throw new Error("Could not save RSVP");
    return json(data);
  },

  "/claim": async (req, user) => {
    const body = await objectBody(req);
    const taskId = stringValue(body.taskId, "taskId", 36, 36);
    if (typeof body.claim !== "boolean") throw new HttpError(400, "claim must be true or false");
    const { data, error } = await db.rpc("qp_claim_task", {
      p_task_id: taskId, p_group_id: user!.groupId, p_member_id: user!.id, p_claim: body.claim,
    }).maybeSingle();
    if (error) throw new Error("Could not update task claim");
    if (!data) {
      const { data: task } = await db.from("qp_tasks").select("id").eq("id", taskId).eq("group_id", user!.groupId).maybeSingle();
      if (!task) throw new HttpError(404, "Task not found");
      throw new HttpError(409, "Task has already been claimed by another member");
    }
    return json(data);
  },

  "/event": async (req, user) => {
    if (user!.role !== "owner") throw new HttpError(403, "Owner access required");
    const body = await objectBody(req);
    const eventId = await assertEventInGroup(body.eventId, user!.groupId);
    if (!body.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) throw new HttpError(400, "patch must be an object");
    const patch = body.patch as Record<string, unknown>;
    const expectedUpdatedAt = stringValue(body.expectedUpdatedAt, "expectedUpdatedAt", 10, 40);
    const allowed: Record<string, (value: unknown) => unknown> = {
      location: (v) => optionalText(v, "location", 160),
      meetingPoint: (v) => optionalText(v, "meetingPoint", 160),
      departureTime: (v) => optionalText(v, "departureTime", 40),
      startTime: (v) => optionalText(v, "startTime", 40),
      endTime: (v) => optionalText(v, "endTime", 40),
      returnTime: (v) => optionalText(v, "returnTime", 40),
      eventDate: (v) => {
        const date = stringValue(v, "eventDate", 10, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "eventDate must be a valid YYYY-MM-DD date");
        const parsed = new Date(`${date}T00:00:00.000Z`);
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
          throw new HttpError(400, "eventDate must be a valid YYYY-MM-DD date");
        }
        return date;
      },
      leader: (v) => optionalText(v, "leader", 120),
      notes: (v) => optionalText(v, "notes", 1000),
      confirmed: (v) => { if (typeof v !== "boolean") throw new HttpError(400, "confirmed must be boolean"); return v; },
    };
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      const parse = allowed[key];
      if (!parse) throw new HttpError(400, `Field cannot be edited: ${key}`);
      changes[key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] = parse(value);
    }
    if (!Object.keys(changes).length) throw new HttpError(400, "patch is empty");
    const { data, error } = await db.from("qp_events").update(changes).eq("id", eventId).eq("group_id", user!.groupId)
      .eq("updated_at", expectedUpdatedAt).select("*").maybeSingle();
    if (error) throw new Error("Could not update event");
    if (!data) throw new HttpError(409, "Event changed since you loaded it. Refresh and try again.");
    return json(data);
  },

  "/task": async (req, user) => {
    if (user!.role !== "owner") throw new HttpError(403, "Owner access required");
    const body = await objectBody(req);
    const eventId = await assertEventInGroup(body.eventId, user!.groupId);
    const title = stringValue(body.title, "title", 1, 120);
    const quantity = body.quantity === undefined ? 1 : intValue(body.quantity, "quantity", 1, 100);
    const category = body.category === undefined ? "general" : stringValue(body.category, "category", 1, 40);
    const { data, error } = await db.from("qp_tasks").insert({ group_id: user!.groupId, event_id: eventId, title, quantity, category })
      .select("*").single();
    if (error || !data) throw new Error("Could not create task");
    return json(data, 201);
  },

  "/delete-task": async (req, user) => {
    if (user!.role !== "owner") throw new HttpError(403, "Owner access required");
    const body = await objectBody(req);
    const taskId = stringValue(body.taskId, "taskId", 36, 36);
    const { data, error } = await db.from("qp_tasks").delete().eq("id", taskId).eq("group_id", user!.groupId)
      .is("claimed_by", null).select("id").maybeSingle();
    if (error) throw new Error("Could not delete task");
    if (!data) throw new HttpError(409, "Task not found or still claimed");
    return json({ deleted: true });
  },
};

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (origin && !allowedOrigins.has(origin)) return json({ error: "Origin not allowed" }, 403, null);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  const url = new URL(req.url);
  const route = url.pathname.replace(/\/+$/, "").split("/").at(-1) ?? "";
  try {
    if (route === "join" && req.method === "POST") return applyOrigin(await routes["/join"](req), origin);
    const key = `/${route}`;
    const handler = routes[key];
    if (!handler) throw new HttpError(404, "Route not found");
    if (key === "/state" ? req.method !== "GET" : req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const user = await authenticate(req);
    return applyOrigin(await handler(req, user), origin);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status, origin);
    console.error("backend request failed", error instanceof Error ? error.message : "unknown error");
    return json({ error: "Request could not be completed" }, 500, origin);
  }
});
