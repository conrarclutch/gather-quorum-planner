import type { EventPatch, GroupSession, PlannerState, PlannerTask, Rsvp, RsvpInput } from "./types";

const SESSION_KEY = "priests-planner-session";
const LEGACY_SESSION_KEY = SESSION_KEY;
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const baseUrl = viteEnv.VITE_API_URL?.replace(/\/+$/, "");
const publishableKey = viteEnv.VITE_SUPABASE_PUBLISHABLE_KEY;
const persistentSessionKey = `${SESSION_KEY}:${baseUrl || "unconfigured"}`;
let transientSession: GroupSession | null = null;

const getLocalStorage = (): Storage | null => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };
const getSessionStorage = (): Storage | null => { try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; } };
const safeStorageGet = (storage: Storage | null, key: string): string | null => {
  if (!storage) return null;
  try { return storage.getItem(key); } catch { return null; }
};
const safeStorageSet = (storage: Storage | null, key: string, value: string): boolean => {
  if (!storage) return false;
  try { storage.setItem(key, value); return true; } catch { return false; }
};
const safeStorageRemove = (storage: Storage | null, key: string): void => { try { storage?.removeItem(key); } catch { /* Private browsing may disable storage. */ } };
const validSession = (value: unknown): value is GroupSession => {
  const session = value as GroupSession | null;
  return Boolean(session?.token && session?.expiresAt && Number.isFinite(Date.parse(session.expiresAt)) && Date.parse(session.expiresAt) > Date.now() && session.member?.id && session.member?.displayName);
};
const saveSession = (session: GroupSession): void => {
  transientSession = session;
  const raw = JSON.stringify(session);
  if (safeStorageSet(getLocalStorage(), persistentSessionKey, raw)) {
    safeStorageRemove(getSessionStorage(), LEGACY_SESSION_KEY);
  } else {
    safeStorageSet(getSessionStorage(), LEGACY_SESSION_KEY, raw);
  }
};

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
  saveSession(session);
  return session;
}

export function getSession(): GroupSession | null {
  const stored = safeStorageGet(getLocalStorage(), persistentSessionKey);
  const isLegacy = !stored;
  const raw = stored ?? safeStorageGet(getSessionStorage(), LEGACY_SESSION_KEY);
  if (!raw) return transientSession && validSession(transientSession) ? transientSession : null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!validSession(value)) {
      clearSession();
      return null;
    }
    transientSession = value;
    if (isLegacy) saveSession(value);
    return value;
  } catch {
    clearSession();
    return null;
  }
}

export function clearSession(): void {
  transientSession = null;
  safeStorageRemove(getLocalStorage(), persistentSessionKey);
  safeStorageRemove(getSessionStorage(), LEGACY_SESSION_KEY);
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
