import type { EventPatch, GroupSession, PlannerState, PlannerTask, Rsvp, RsvpInput } from "./types";

const SESSION_KEY = "priests-planner-session";
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const baseUrl = viteEnv.VITE_API_URL?.replace(/\/+$/, "");
const publishableKey = viteEnv.VITE_SUPABASE_PUBLISHABLE_KEY;

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

const request = async <T>(path: string, options: { method?: "GET" | "POST"; body?: unknown; token?: string } = {}): Promise<T> => {
  if (!baseUrl) throw new ApiError("The planner API URL is not configured.", 0);
  if (!publishableKey) throw new ApiError("The planner publishable key is not configured.", 0);
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: publishableKey };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Could not connect to the planner. Check your connection and try again.", 0);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(typeof payload.error === "string" ? payload.error : "Planner request failed.", response.status);
  return payload as T;
};

export async function joinGroup(input: { inviteCode: string; displayName: string; ownerCode?: string }): Promise<GroupSession> {
  const session = await request<GroupSession>("join", { method: "POST", body: input });
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function getSession(): GroupSession | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as GroupSession;
    if (!value?.token || !value?.expiresAt || new Date(value.expiresAt).getTime() <= Date.now()) {
      clearSession();
      return null;
    }
    return value;
  } catch {
    clearSession();
    return null;
  }
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

export async function getState(): Promise<PlannerState> {
  const session = requireSession();
  return request<PlannerState>("state", { token: session.token });
}

export async function saveRsvp(eventId: string, input: RsvpInput): Promise<Rsvp> {
  const session = requireSession();
  return request<Rsvp>("rsvp", { method: "POST", token: session.token, body: { eventId, ...input } });
}

export async function claimTask(taskId: string, claim: boolean): Promise<PlannerTask> {
  const session = requireSession();
  return request<PlannerTask>("claim", { method: "POST", token: session.token, body: { taskId, claim } });
}

export async function updateEvent(eventId: string, expectedUpdatedAt: string, patch: EventPatch): Promise<PlannerState["events"][number]> {
  const session = requireSession();
  return request("event", { method: "POST", token: session.token, body: { eventId, expectedUpdatedAt, patch } });
}

export async function addTask(input: { eventId: string; title: string; quantity?: number; category?: string }): Promise<PlannerTask> {
  const session = requireSession();
  return request<PlannerTask>("task", { method: "POST", token: session.token, body: input });
}

function requireSession(): GroupSession {
  const session = getSession();
  if (!session) throw new ApiError("Join your group to continue.", 401);
  return session;
}
