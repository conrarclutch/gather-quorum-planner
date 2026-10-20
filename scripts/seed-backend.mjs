import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const inviteCode = process.env.SEED_INVITE_CODE;
const ownerCode = process.env.SEED_OWNER_CODE;
const groupName = process.env.SEED_GROUP_NAME ?? "Priests Quorum";

if (!base || !key || !inviteCode || !ownerCode) {
  throw new Error("Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SEED_INVITE_CODE, and SEED_OWNER_CODE first.");
}
if (inviteCode.length < 22 || ownerCode.length < 22 || inviteCode.trim() !== inviteCode || ownerCode.trim() !== ownerCode) {
  throw new Error("Invite and owner codes must each be unguessable codes of at least 22 characters, with no surrounding whitespace.");
}
if (inviteCode === ownerCode) throw new Error("The invite and owner codes must be different.");

const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

async function rest(table, { method = "GET", query = "", body, prefer } = {}) {
  const response = await fetch(`${base}/rest/v1/${table}${query ? `?${query}` : ""}`, {
    method,
    headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${table} failed (${response.status}): ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const { activities, sources } = JSON.parse(await readFile(new URL("../research/schedules.json", import.meta.url), "utf8"));
const inviteCodeHash = digest(inviteCode);
const existing = await rest("qp_groups", { query: `select=id,owner_code_hash&invite_code_hash=eq.${inviteCodeHash}` });
let groupId = existing?.[0]?.id;
if (existing?.length && existing[0].owner_code_hash !== digest(ownerCode)) {
  throw new Error("That invite code already belongs to a group with a different owner code.");
}
if (!groupId) {
  const created = await rest("qp_groups", {
    method: "POST", query: "select=id", body: [{ name: groupName, invite_code_hash: inviteCodeHash, owner_code_hash: digest(ownerCode) }], prefer: "return=representation",
  });
  groupId = created?.[0]?.id;
}
if (!groupId) throw new Error("Could not create or find the planner group.");

const sourceById = new Map(sources.map((source) => [source.id, source]));
const events = activities.map((activity) => ({
  group_id: groupId,
  original_title: activity.activity,
  source_url: sourceById.get(activity.source_id)?.url ?? "",
  source_tab: activity.source_tab,
  source_row: activity.source_row,
  source_id: activity.source_id,
  source_date: activity.source_date,
  original_date_serial: activity.original_date_serial ?? null,
  date_caveat: activity.date_caveat ?? "",
  event_date: activity.interpreted_date,
  year_confidence: activity.year_confidence,
  status: activity.status,
  scope: activity.scope,
  details: [
    activity.details,
    activity.responsible && activity.responsible.toLowerCase() !== "not listed"
      ? `Source responsibility: ${activity.responsible}`
      : null,
  ].filter(Boolean).join(" "),
  ...(activity.activity.includes("Tucson Temple Baptisms 10:30am")
    ? { location: "Tucson Temple", start_time: "10:30" }
    : {}),
}));

await rest("qp_events", {
  method: "POST",
  query: "on_conflict=group_id,source_id,source_tab,source_row",
  body: events,
  prefer: "resolution=ignore-duplicates,return=minimal",
});

const storedEvents = await rest("qp_events", { query: `select=id,original_title,event_date,source_id,source_tab,source_row&group_id=eq.${groupId}` });
const suggestionsFor = (title) => {
  const value = title.toLowerCase();
  if (value.includes("gift basket") || value.includes("basket service")) return [
    ["Coordinate gift basket plan", "coordination"], ["Prepare baskets", "supplies"], ["Gather treats", "food"], ["Arrange delivery driver", "transport"],
  ];
  if (value.includes("overnight") || value.includes("camp")) return [
    ["Confirm overnight leader", "leadership"], ["Arrange drivers", "transport"], ["Confirm route and campground", "planning"],
    ["Plan meals", "food"], ["Bring water", "supplies"], ["Check shared gear", "equipment"],
  ];
  if (value.includes("cooking")) return [
    ["Coordinate meal plan", "coordination"], ["Prepare main dish", "food"], ["Prepare sides", "food"], ["Gather ingredients", "supplies"],
    ["Bring cooking utensils", "equipment"], ["Plan cleanup", "cleanup"],
  ];
  if (value.includes("frisbee") || value.includes("basketball") || value.includes("donut") || value.includes("trunk or treat")) return [
    ["Confirm venue", "planning"], ["Bring activity equipment", "equipment"], ["Bring water", "supplies"],
  ];
  if (value.includes("combined") || value.includes("combine")) return [
    ["Coordinate with the other quorum", "coordination"], ["Plan refreshments", "food"],
    ...(value.includes("temple") ? [
      ["Confirm activity leader", "leadership"], ["Arrange drivers", "transport"], ["Confirm temple time", "planning"],
    ] : []),
  ];
  if (value.includes("temple")) return [
    ["Confirm activity leader", "leadership"], ["Arrange drivers", "transport"], ["Confirm temple time", "planning"],
  ];
  if (value.includes("treat")) return [["Coordinate treats", "food"], ["Bring supplies", "supplies"]];
  return [["Confirm activity plan", "planning"], ["Gather needed supplies", "supplies"]];
};

const tasks = storedEvents.flatMap((event) => suggestionsFor(event.original_title).map(([title, category]) => ({
  group_id: groupId, event_id: event.id, title, category, quantity: 1, suggested: true,
})));
if (tasks.length) await rest("qp_tasks", {
  method: "POST", query: "on_conflict=event_id,title", body: tasks,
  prefer: "resolution=ignore-duplicates,return=minimal",
});

console.log(`Seeded ${activities.length} source events and ${tasks.length} suggested tasks for group ${groupId}.`);
console.log("No names or claims were generated. Source dates and date caveats are preserved; confirm inferred dates and weekday conflicts before treating them as final.");
