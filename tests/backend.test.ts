import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const databases: PGlite[] = [];

async function database() {
  const db = new PGlite();
  databases.push(db);
  // Supabase provides these roles and pgcrypto. PGlite has gen_random_uuid built in.
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  const schema = (await readFile(resolve(root, "backend/schema.sql"), "utf8"))
    .replace(/^create extension if not exists pgcrypto;\s*/m, "");
  await db.exec(schema);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("planner database security invariants", () => {
  it("keeps planner objects isolated from pre-existing public tables", async () => {
    const db = new PGlite();
    databases.push(db);
    await db.exec("create table public.groups (marker text); insert into public.groups values ('existing app');");
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    const schema = (await readFile(resolve(root, "backend/schema.sql"), "utf8"))
      .replace(/^create extension if not exists pgcrypto;\s*/m, "");
    await db.exec(schema);

    const existing = await db.query("select marker from public.groups");
    const plannerObjects = await db.query("select to_regclass('public.qp_groups') as name");
    expect(existing.rows).toEqual([{ marker: "existing app" }]);
    expect(plannerObjects.rows[0].name).toBe("qp_groups");
  });

  it("denies public table and RPC privileges while granting the claim RPC to service_role", async () => {
    const db = await database();
    const permissions = await db.query(`
      select
        has_table_privilege('anon', 'public.qp_events', 'select') as anon_can_read_events,
        has_table_privilege('authenticated', 'public.qp_sessions', 'select') as authenticated_can_read_sessions,
        has_function_privilege('anon', 'public.qp_claim_task(uuid,uuid,uuid,boolean)', 'execute') as anon_can_claim,
        has_function_privilege('authenticated', 'public.qp_claim_task(uuid,uuid,uuid,boolean)', 'execute') as authenticated_can_claim,
        has_function_privilege('service_role', 'public.qp_claim_task(uuid,uuid,uuid,boolean)', 'execute') as service_can_claim
    `);
    expect(permissions.rows[0]).toEqual({
      anon_can_read_events: false,
      authenticated_can_read_sessions: false,
      anon_can_claim: false,
      authenticated_can_claim: false,
      service_can_claim: true,
    });
  });

  it("grants service_role schema usage and CRUD on only the six planner tables", async () => {
    const db = new PGlite();
    databases.push(db);
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create table public.unrelated (id integer);");
    const schema = (await readFile(resolve(root, "backend/schema.sql"), "utf8"))
      .replace(/^create extension if not exists pgcrypto;\s*/m, "");
    await db.exec(schema);

    const schemaUsage = await db.query("select has_schema_privilege('service_role', 'public', 'usage') as can_use_public");
    expect(schemaUsage.rows[0].can_use_public).toBe(true);

    const tablePrivileges = await db.query(`
      select c.relname,
        has_table_privilege('service_role', c.oid, 'select') as can_select,
        has_table_privilege('service_role', c.oid, 'insert') as can_insert,
        has_table_privilege('service_role', c.oid, 'update') as can_update,
        has_table_privilege('service_role', c.oid, 'delete') as can_delete
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    `);
    const expectedTables = ["qp_events", "qp_groups", "qp_members", "qp_rsvps", "qp_sessions", "qp_tasks"];
    expect(tablePrivileges.rows.map((row) => row.relname)).toEqual(["unrelated", ...expectedTables].sort());
    for (const row of tablePrivileges.rows) {
      const shouldHaveAccess = expectedTables.includes(row.relname);
      expect([row.can_select, row.can_insert, row.can_update, row.can_delete], row.relname)
        .toEqual(Array(4).fill(shouldHaveAccess));
    }
  });

  it("executes the SECURITY INVOKER claim RPC as service_role with the granted privileges", async () => {
    const db = await database();
    const group = "10000000-0000-4000-8000-000000000001";
    const event = "20000000-0000-4000-8000-000000000001";
    const task = "30000000-0000-4000-8000-000000000001";
    const member = "40000000-0000-4000-8000-000000000001";
    await db.query("insert into public.qp_groups (id,name,invite_code_hash,owner_code_hash) values ($1,'Synthetic group','invite hash','owner hash')", [group]);
    await db.query("insert into public.qp_members (id,group_id,display_name) values ($1,$2,'Synthetic member')", [member, group]);
    await db.query("insert into public.qp_events (id,group_id,original_title,source_url,source_tab,source_row,source_id,source_date,event_date,year_confidence) values ($1,$2,'Synthetic event','https://example.invalid','Synthetic',1,'synthetic','2026-10-20','2026-10-20','certain')", [event, group]);
    await db.query("insert into public.qp_tasks (id,group_id,event_id,title) values ($1,$2,$3,'Synthetic task')", [task, group, event]);

    const securityMode = await db.query(`select not p.prosecdef as is_security_invoker
      from pg_proc p where p.oid = 'public.qp_claim_task(uuid,uuid,uuid,boolean)'::regprocedure`);
    expect(securityMode.rows[0].is_security_invoker).toBe(true);

    await db.exec("set role service_role");
    let claimed;
    try {
      claimed = await db.query("select id,claimed_by from public.qp_claim_task($1,$2,$3,true)", [task, group, member]);
    } finally {
      await db.exec("reset role");
    }
    expect(claimed?.rows).toEqual([{ id: task, claimed_by: member }]);
  });

  it("serializes competing claims and lets only the claimant release their own task", async () => {
    const db = await database();
    const group = "10000000-0000-4000-8000-000000000001";
    const event = "20000000-0000-4000-8000-000000000001";
    const task = "30000000-0000-4000-8000-000000000001";
    const memberA = "40000000-0000-4000-8000-000000000001";
    const memberB = "40000000-0000-4000-8000-000000000002";
    const otherGroup = "10000000-0000-4000-8000-000000000002";
    await db.query("insert into public.qp_groups (id,name,invite_code_hash,owner_code_hash) values ($1,'Synthetic group','invite hash','owner hash'), ($2,'Other group','other invite','other owner')", [group, otherGroup]);
    await db.query("insert into public.qp_members (id,group_id,display_name) values ($1,$3,'Member A'),($2,$3,'Member B')", [memberA, memberB, group]);
    await db.query("insert into public.qp_events (id,group_id,original_title,source_url,source_tab,source_row,source_id,source_date,event_date,year_confidence) values ($1,$2,'Synthetic event','https://example.invalid','Synthetic',1,'synthetic','2026-10-20','2026-10-20','certain')", [event, group]);
    await db.query("insert into public.qp_tasks (id,group_id,event_id,title) values ($1,$2,$3,'Synthetic task')", [task, group, event]);

    const race = await Promise.all([
      db.query("select id,claimed_by from public.qp_claim_task($1,$2,$3,true)", [task, group, memberA]),
      db.query("select id,claimed_by from public.qp_claim_task($1,$2,$3,true)", [task, group, memberB]),
    ]);
    const winners = race.flatMap((result) => result.rows);
    expect(winners).toHaveLength(1);
    const winner = winners[0].claimed_by;
    const loser = winner === memberA ? memberB : memberA;

    const stolen = await db.query("select id from public.qp_claim_task($1,$2,$3,true)", [task, group, loser]);
    const outsiderRelease = await db.query("select id from public.qp_claim_task($1,$2,$3,false)", [task, group, loser]);
    expect(stolen.rows).toEqual([]);
    expect(outsiderRelease.rows).toEqual([]);
    expect((await db.query("select claimed_by from public.qp_tasks where id=$1", [task])).rows[0].claimed_by).toBe(winner);

    const wrongGroupRelease = await db.query("select id from public.qp_claim_task($1,$2,$3,false)", [task, otherGroup, winner]);
    const wrongGroupClaim = await db.query("select id from public.qp_claim_task($1,$2,$3,true)", [task, otherGroup, loser]);
    expect(wrongGroupRelease.rows).toEqual([]);
    expect(wrongGroupClaim.rows).toEqual([]);
    expect((await db.query("select claimed_by from public.qp_tasks where id=$1", [task])).rows[0].claimed_by).toBe(winner);
    const release = await db.query("select id,claimed_by from public.qp_claim_task($1,$2,$3,false)", [task, group, winner]);
    expect(release.rows).toEqual([{ id: task, claimed_by: null }]);
  });
});

describe("public frontend data boundary", () => {
  it("does not import the researched schedule into source or public assets", async () => {
    const frontendFiles: string[] = [];
    async function collect(directory: string) {
      for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
        const relative = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await collect(relative);
        else frontendFiles.push(relative);
      }
    }
    await collect("src");
    await collect("public");
    frontendFiles.push("index.html");
    const contents = await Promise.all(frontendFiles.map((file) => readFile(resolve(root, file), "utf8")));
    const frontend = contents.join("\n");
    expect(frontend).not.toMatch(/research\/schedules\.json|\.\.\/research\/schedules/);
    expect(frontend).not.toContain('from "./research/');
  });
});
