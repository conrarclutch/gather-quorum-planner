import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const apiUrl = process.env.API_URL?.replace(/\/+$/, "");
const publishableKey = process.env.PUBLISHABLE_KEY;
const inviteCode = process.env.INVITE_CODE;
const ownerCode = process.env.OWNER_CODE;
const origin = "https://conrarclutch.github.io";
const recordsPath = resolve(".private/live-test-records.json");
const schedulePath = resolve("research/schedules.json");

let schedule;
try {
  schedule = JSON.parse(await readFile(schedulePath, "utf8"));
} catch {
  throw new Error("The ignored research/schedules.json file is required to run live verification.");
}
const activities = schedule.activities ?? [];
const sources = schedule.sources ?? [];
const expectedRows = activities.map((activity) => ({
  sourceId: activity.source_id,
  sourceTab: activity.source_tab,
  sourceRow: activity.source_row,
  eventDate: activity.interpreted_date,
}));
const expectedSourceIds = new Set(activities.map((activity) => activity.source_id));
const secondarySource = sources.find((source) => source.title === "Youth Activity Schedule");
const november6Source = activities.find((activity) => activity.interpreted_date === "2026-11-06" && /Sat/i.test(activity.date_caveat ?? ""));
const november13Source = activities.find((activity) => activity.interpreted_date === "2026-11-13" && /Sat/i.test(activity.date_caveat ?? ""));
const templeSource = activities.find((activity) => /Tucson Temple Baptisms 10:30am/i.test(activity.activity));

if (activities.length !== 14 || expectedSourceIds.size !== 2 || !secondarySource || !november6Source || !november13Source || !templeSource) {
  throw new Error("research/schedules.json does not contain the expected 14 events, two sources, weekday caveats, and temple event.");
}

if (!apiUrl || !publishableKey || !inviteCode || !ownerCode) {
  throw new Error("Set API_URL, PUBLISHABLE_KEY, INVITE_CODE, and OWNER_CODE before running the live verification.");
}
if (!apiUrl.startsWith("https://") || inviteCode === ownerCode || inviteCode.length < 22 || ownerCode.length < 22 ||
  inviteCode.trim() !== inviteCode || ownerCode.trim() !== ownerCode) {
  throw new Error("API_URL must use HTTPS, and the distinct invite and owner codes must each be at least 22 characters with no surrounding whitespace.");
}

const suffix = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const records = {
  createdAt: new Date().toISOString(),
  apiUrl,
  origin,
  members: [],
  rsvps: [],
  taskId: null,
  taskReleased: false,
  eventId: null,
  eventOriginalLocation: null,
  eventTestLocation: null,
  eventRestored: false,
};
const sessions = {};
const checks = [];

async function persistRecords() {
  await mkdir(resolve(".private"), { recursive: true });
  await writeFile(recordsPath, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
}

function check(name, passed, detail = "") {
  if (!passed) throw new Error(`${name} failed${detail ? `: ${detail}` : ""}`);
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function call(path, { method = "GET", token, body, preflight = false } = {}) {
  const headers = { Origin: origin, apikey: publishableKey };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (preflight) {
    headers["Access-Control-Request-Method"] = "POST";
    headers["Access-Control-Request-Headers"] = "authorization, apikey, content-type";
  }
  const response = await fetch(`${apiUrl}/${path}`, {
    method: preflight ? "OPTIONS" : method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function assertStatus(name, result, status) {
  check(name, result.response.status === status, `expected HTTP ${status}, received ${result.response.status}`);
  return result.payload;
}

async function join(label, code = undefined) {
  const displayName = `GO-LIVE VERIFY ${label} ${suffix}`;
  const result = await call("join", {
    method: "POST",
    body: { inviteCode, displayName, ...(code ? { ownerCode: code } : {}) },
  });
  const payload = assertStatus(`join temporary ${label}`, result, 200);
  check(`CORS on join ${label} success`, result.response.headers.get("Access-Control-Allow-Origin") === origin);
  if (!payload?.token || !payload?.member?.id) throw new Error(`Join ${label} returned no usable session.`);
  sessions[label] = payload.token;
  records.members.push({ id: payload.member.id, displayName, role: payload.member.role });
  await persistRecords();
  return payload.member;
}

async function state(token) {
  const result = await call("state", { token });
  if (result.response.status !== 200 || !result.payload) {
    throw new Error(`State request failed with HTTP ${result.response.status}.`);
  }
  return result.payload;
}

function sourceRows(events) {
  return events
    .filter((event) => expectedSourceIds.has(event.sourceId))
    .map((event) => ({ sourceId: event.sourceId, sourceTab: event.sourceTab, sourceRow: event.sourceRow, eventDate: event.eventDate }))
    .sort((a, b) => `${a.sourceId}|${a.sourceTab}|${a.sourceRow}`.localeCompare(`${b.sourceId}|${b.sourceTab}|${b.sourceRow}`));
}

let originalEvent = null;
let eventTestAttempted = false;
let claimWinner = null;
let cleanupFailures = [];

try {
  const preflight = await call("state", { preflight: true });
  const allowHeaders = (preflight.response.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase();
  const allowMethods = (preflight.response.headers.get("Access-Control-Allow-Methods") ?? "").toUpperCase();
  check("GitHub Pages CORS preflight", preflight.response.status === 204 && preflight.response.headers.get("Access-Control-Allow-Origin") === origin &&
    ["authorization", "apikey", "content-type"].every((header) => allowHeaders.includes(header)) && allowMethods.includes("POST"));

  const noSession = await call("state");
  assertStatus("reject requests without a session", noSession, 401);
  check("CORS on unauthenticated error", noSession.response.headers.get("Access-Control-Allow-Origin") === origin);

  const owner = await join("owner", ownerCode);
  check("owner role assigned", owner.role === "owner");
  let initial = await state(sessions.owner);
  const rows = sourceRows(initial.events);
  const sortedExpectedRows = [...expectedRows].sort((a, b) => `${a.sourceId}|${a.sourceTab}|${a.sourceRow}`.localeCompare(`${b.sourceId}|${b.sourceTab}|${b.sourceRow}`));
  check("14 expected researched source rows are seeded", rows.length === 14 && JSON.stringify(rows) === JSON.stringify(sortedExpectedRows));
  const sourceRowsFromSecondary = rows.filter((row) => row.sourceId === secondarySource.id);
  const expectedSecondaryCount = activities.filter((activity) => activity.source_id === secondarySource.id).length;
  check("both schedule sources are represented", new Set(rows.map((row) => row.sourceId)).size === 2 && sourceRowsFromSecondary.length === expectedSecondaryCount);

  const november6 = initial.events.find((event) => event.sourceId === november6Source.source_id && event.sourceRow === november6Source.source_row);
  const november13 = initial.events.find((event) => event.sourceId === november13Source.source_id && event.sourceRow === november13Source.source_row);
  check("November weekday caveats are preserved", november6?.eventDate === november6Source.interpreted_date &&
    november6.dateCaveat === november6Source.date_caveat && /Saturday.*Friday|Sat.*Friday/i.test(november6.dateCaveat) &&
    november13?.eventDate === november13Source.interpreted_date && november13.dateCaveat === november13Source.date_caveat &&
    /Saturday.*Friday|Sat.*Friday/i.test(november13.dateCaveat));

  const temple = initial.events.find((event) => event.sourceId === templeSource.source_id && event.sourceRow === templeSource.source_row);
  check("temple event has its source time and location", Boolean(temple && /Tucson Temple/i.test(temple.location ?? "") && /10:30/.test(temple.startTime ?? "")));
  if (!temple) throw new Error("Expected temple source event was not found.");

  const openTask = initial.tasks.find((task) => task.claimedBy === null);
  if (!openTask) throw new Error("No unclaimed task is available for the safe claim-race check.");
  records.eventId = temple.id;
  records.eventOriginalLocation = temple.location;
  records.taskId = openTask.id;
  await persistRecords();

  const memberA = await join("member-a");
  const memberB = await join("member-b");
  check("member roles assigned", memberA.role === "member" && memberB.role === "member");

  const forbiddenEdit = await call("event", {
    method: "POST", token: sessions["member-a"],
    body: { eventId: temple.id, expectedUpdatedAt: temple.updatedAt, patch: { location: "unauthorized verification edit" } },
  });
  assertStatus("member cannot edit event logistics", forbiddenEdit, 403);
  check("CORS on owner authorization error", forbiddenEdit.response.headers.get("Access-Control-Allow-Origin") === origin);

  const rsvpA = await call("rsvp", {
    method: "POST", token: sessions["member-a"],
    body: { eventId: temple.id, status: "going", count: 1, rideNeeded: 0, seatsOffered: 0, notes: "Temporary live verification RSVP A" },
  });
  const rsvpAPayload = assertStatus("member A RSVP save", rsvpA, 200);
  records.rsvps.push({ id: rsvpAPayload.id, memberId: memberA.id, eventId: temple.id });
  await persistRecords();

  const rsvpB = await call("rsvp", {
    method: "POST", token: sessions["member-b"],
    body: { eventId: temple.id, status: "maybe", count: 1, rideNeeded: 0, seatsOffered: 0, notes: "Temporary live verification RSVP B" },
  });
  const rsvpBPayload = assertStatus("member B RSVP save", rsvpB, 200);
  records.rsvps.push({ id: rsvpBPayload.id, memberId: memberB.id, eventId: temple.id });
  await persistRecords();

  const ownerEditPatch = { location: `GO-LIVE VERIFY TEMP ${suffix}` };
  records.eventTestLocation = ownerEditPatch.location;
  eventTestAttempted = true;
  const ownerEdit = await call("event", {
    method: "POST", token: sessions.owner,
    body: { eventId: temple.id, expectedUpdatedAt: temple.updatedAt, patch: ownerEditPatch },
  });
  const editedEvent = assertStatus("owner can save event logistics", ownerEdit, 200);
  check("owner logistics edit persisted", editedEvent.location === ownerEditPatch.location);

  const staleEdit = await call("event", {
    method: "POST", token: sessions.owner,
    body: { eventId: temple.id, expectedUpdatedAt: temple.updatedAt, patch: { location: "GO-LIVE VERIFY stale edit must not stick" } },
  });
  assertStatus("stale event edit rejected", staleEdit, 409);
  const afterStale = await state(sessions.owner);
  check("stale edit did not overwrite the current logistics", afterStale.events.find((event) => event.id === temple.id)?.location === ownerEditPatch.location);

  const claimRace = await Promise.all([
    call("claim", { method: "POST", token: sessions["member-a"], body: { taskId: openTask.id, claim: true } }),
    call("claim", { method: "POST", token: sessions["member-b"], body: { taskId: openTask.id, claim: true } }),
  ]);
  const winners = claimRace.filter((result) => result.response.status === 200);
  const conflicts = claimRace.filter((result) => result.response.status === 409);
  claimWinner = winners[0]?.payload?.claimedBy;
  check("only one simultaneous claimant wins", winners.length === 1 && conflicts.length === 1);
  check("winning claim belongs to one test member", [memberA.id, memberB.id].includes(claimWinner));

  const ownerState = await state(sessions.owner);
  const memberState = await state(sessions["member-a"]);
  const expectedMemberIds = [owner.id, memberA.id, memberB.id].sort();
  const visibleMemberIds = ownerState.members.filter((member) => expectedMemberIds.includes(member.id)).map((member) => member.id).sort();
  check("all temporary signups are visible to owner", JSON.stringify(visibleMemberIds) === JSON.stringify(expectedMemberIds));
  const memberBState = await state(sessions["member-b"]);
  for (const [name, snapshot] of [["owner", ownerState], ["member A", memberState], ["member B", memberBState]]) {
    const visibleRsvps = snapshot.rsvps.filter((rsvp) => records.rsvps.some((testRsvp) => testRsvp.id === rsvp.id));
    check(`both RSVPs visible to ${name} session`, visibleRsvps.length === 2 && new Set(visibleRsvps.map((rsvp) => rsvp.memberId)).size === 2);
  }

  const taskAfterRace = ownerState.tasks.find((task) => task.id === openTask.id);
  check("claim race winner appears in shared state", taskAfterRace?.claimedBy === claimWinner);
} finally {
  if (eventTestAttempted && sessions.owner && records.eventId) {
    try {
      const latest = await state(sessions.owner);
      const current = latest.events.find((event) => event.id === records.eventId);
      if (current?.location === records.eventTestLocation) {
        const restore = await call("event", {
          method: "POST", token: sessions.owner,
          body: { eventId: records.eventId, expectedUpdatedAt: current.updatedAt, patch: { location: records.eventOriginalLocation } },
        });
        if (restore.response.status !== 200) throw new Error(`restore returned HTTP ${restore.response.status}`);
        records.eventRestored = true;
      } else {
        records.eventRestored = current?.location === records.eventOriginalLocation;
      }
    } catch (error) {
      cleanupFailures.push(`Event location may need manual restore (${error instanceof Error ? error.message : "unknown error"}).`);
    }
  }

  if (claimWinner && records.taskId) {
    try {
      const winningLabel = claimWinner === records.members[1]?.id ? "member-a" : "member-b";
      const release = await call("claim", { method: "POST", token: sessions[winningLabel], body: { taskId: records.taskId, claim: false } });
      records.taskReleased = release.response.status === 200 && release.payload?.claimedBy === null;
      if (!records.taskReleased) throw new Error(`release returned HTTP ${release.response.status}`);
    } catch (error) {
      cleanupFailures.push(`Task ${records.taskId} may need manual release (${error instanceof Error ? error.message : "unknown error"}).`);
    }
  }

  await persistRecords();
}

console.log(`\nLive verification passed ${checks.length} checks.`);
console.log(`Private cleanup record saved at ${recordsPath}; it contains IDs and temporary names, never invite/owner codes or session tokens.`);
if (cleanupFailures.length) {
  console.error(`Cleanup needs attention: ${cleanupFailures.join(" ")}`);
  process.exitCode = 1;
}
