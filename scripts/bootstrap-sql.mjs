import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const privateDir = resolve(root, ".private");
const accessPath = resolve(privateDir, "access.json");
const sqlPath = resolve(privateDir, "bootstrap.sql");

for (const path of [accessPath, sqlPath]) {
  try {
    await access(path, constants.F_OK);
    throw new Error("Private bootstrap files already exist. Preserve them; move or remove them deliberately before generating a new group.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const [schema, seedSource, researchText] = await Promise.all([
  readFile(resolve(root, "backend/schema.sql"), "utf8"),
  readFile(resolve(root, "scripts/seed-backend.mjs"), "utf8"),
  readFile(resolve(root, "research/schedules.json"), "utf8"),
]);
if (!schema.includes("public.qp_claim_task") || !seedSource.includes("suggestionsFor") || !schema.includes("grant select, insert, update, delete")) {
  throw new Error("Backend schema or seeding contract did not match the expected planner version.");
}

const { activities, sources } = JSON.parse(researchText);
if (!Array.isArray(activities) || activities.length !== 14) throw new Error("Expected exactly 14 researched source activities.");

const inviteCode = randomBytes(24).toString("base64url");
let ownerCode = randomBytes(24).toString("base64url");
while (ownerCode === inviteCode) ownerCode = randomBytes(24).toString("base64url");
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const sqlText = (value) => `'${String(value ?? "").replaceAll("'", "''")}'`;

const sourcesById = new Map(sources.map((source) => [source.id, source]));
const eventRows = activities.map((activity) => {
  const templeEvent = activity.activity.includes("Tucson Temple Baptisms 10:30am");
  const details = [
    activity.details,
    activity.responsible && activity.responsible.toLowerCase() !== "not listed"
      ? `Source responsibility: ${activity.responsible}`
      : null,
  ].filter(Boolean).join(" ");
  return {
    sourceId: activity.source_id,
    sourceTab: activity.source_tab,
    sourceRow: activity.source_row,
    values: [
      sqlText(randomUUID()),
      "v_group_id",
      sqlText(activity.activity),
      sqlText(sourcesById.get(activity.source_id)?.url ?? ""),
      sqlText(activity.source_tab),
      String(activity.source_row),
      sqlText(activity.source_id),
      sqlText(activity.source_date),
      activity.original_date_serial == null ? "null" : String(activity.original_date_serial),
      sqlText(activity.date_caveat ?? ""),
      sqlText(activity.interpreted_date),
      sqlText(activity.year_confidence),
      sqlText(activity.status),
      sqlText(activity.scope),
      sqlText(details),
      templeEvent ? sqlText("Tucson Temple") : "null",
      templeEvent ? sqlText("10:30") : "null",
    ].join(", "),
  };
});

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

const taskRows = activities.flatMap((activity) => suggestionsFor(activity.activity).map(([title, category]) => ({
  sourceId: activity.source_id,
  sourceTab: activity.source_tab,
  sourceRow: activity.source_row,
  title,
  category,
})));
const taskValues = taskRows.map((task) => `(${sqlText(task.sourceId)}, ${sqlText(task.sourceTab)}, ${task.sourceRow}, ${sqlText(task.title)}, ${sqlText(task.category)})`).join(",\n      ");
const eventValues = eventRows.map(({ values }) => `(${values})`).join(",\n      ");
const bootstrapSql = `-- Generated locally by scripts/bootstrap-sql.mjs. Invite/owner codes are not stored here.
${schema.trim()}

do $bootstrap$
declare
  v_group_id uuid;
  v_owner_hash text := ${sqlText(sha256(ownerCode))};
begin
  insert into public.qp_groups (name, invite_code_hash, owner_code_hash)
  values (${sqlText("Priests Quorum")}, ${sqlText(sha256(inviteCode))}, v_owner_hash)
  on conflict (invite_code_hash) do nothing;

  select id, owner_code_hash into v_group_id, v_owner_hash
  from public.qp_groups
  where invite_code_hash = ${sqlText(sha256(inviteCode))};
  if v_group_id is null or v_owner_hash <> ${sqlText(sha256(ownerCode))} then
    raise exception 'Existing invite code does not match the generated owner code';
  end if;

  insert into public.qp_events (
    id, group_id, original_title, source_url, source_tab, source_row, source_id,
    source_date, original_date_serial, date_caveat, event_date, year_confidence,
    status, scope, details, location, start_time
  ) values
      ${eventValues}
  on conflict (group_id, source_id, source_tab, source_row) do nothing;

  insert into public.qp_tasks (group_id, event_id, title, quantity, category, suggested)
  select v_group_id, event.id, seed.title, 1, seed.category, true
  from (values
      ${taskValues}
  ) as seed(source_id, source_tab, source_row, title, category)
  join public.qp_events event
    on event.group_id = v_group_id
   and event.source_id = seed.source_id
   and event.source_tab = seed.source_tab
   and event.source_row = seed.source_row
  on conflict (event_id, title) do nothing;
end;
$bootstrap$;
`;

await mkdir(privateDir, { recursive: true });
await writeFile(accessPath, `${JSON.stringify({ groupName: "Priests Quorum", inviteCode, ownerCode }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await writeFile(sqlPath, bootstrapSql, { flag: "wx", mode: 0o600 });
console.log(`Created private Supabase bootstrap files for 14 events and ${taskRows.length} suggested tasks.`);
console.log("Access codes are stored only in .private/access.json; bootstrap SQL contains only their SHA-256 hashes.");
console.log("Apply .private/bootstrap.sql in the Supabase SQL Editor, then copy the two codes from the private JSON into your secure group setup flow.");
