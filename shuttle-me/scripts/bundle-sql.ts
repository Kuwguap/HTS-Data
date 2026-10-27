/**
 * Bundle every migration into ONE script for the Supabase SQL editor (when the
 * CLI / MCP route is not available):
 *
 *   pnpm bundle:sql                 # writes .deploy/01-schema.sql
 *   pnpm bundle:sql -- --out x.sql
 *
 * The bundle first enables pg_cron + pg_net (so 0009_cron.sql is not skipped),
 * then applies supabase/migrations/*.sql in order. Every migration is idempotent,
 * so re-running the bundle on an already-migrated project is safe. The SQL editor
 * runs the whole script as one transaction: either everything applies or nothing.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "supabase/migrations");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

const out = path.resolve(ROOT, argValue("--out") ?? ".deploy/01-schema.sql");
const withExtensions = !process.argv.includes("--no-extensions"); // --no-extensions: local dry runs (no pg_cron/pg_net)
const files = readdirSync(DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

// A multi-statement script is ONE implicit transaction, and Postgres refuses to use an
// enum value added by `alter type … add value` inside the transaction that added it.
// So every migration that adds enum values is followed by an explicit commit/begin
// boundary; everything up to that point either lands or rolls back together.
const ADDS_ENUM_VALUE = /alter\s+type\s+[\w."]+\s+add\s+value/i;

const parts: string[] = [
  `-- Shuttle Me — database schema bundle (generated ${new Date().toISOString()})`,
  `-- Paste the WHOLE file into Supabase Dashboard → SQL Editor → New query → Run. Safe to re-run.`,
  `-- Transactions: the script commits after any migration that adds enum values (Postgres`,
  `-- cannot use a new enum value in the transaction that added it); on an error, everything`,
  `-- after the last commit rolls back and nothing further runs — fix and re-run the file.`,
  `begin;`,
  ``,
];
if (withExtensions) {
  parts.push(
    `-- Extensions needed by the minute ticker (0009_cron.sql is a no-op without them).`,
    `create extension if not exists pg_cron with schema pg_catalog;`,
    `grant usage on schema cron to postgres;`,
    `grant all privileges on all tables in schema cron to postgres;`,
    `create extension if not exists pg_net with schema extensions;`,
    ``,
  );
}
for (const f of files) {
  const sql = readFileSync(path.join(DIR, f), "utf8").trimEnd();
  parts.push(`-- ============================================================================`);
  parts.push(`-- ${f}`);
  parts.push(`-- ============================================================================`);
  parts.push(sql);
  parts.push(``);
  if (ADDS_ENUM_VALUE.test(sql)) {
    parts.push(`-- ${f} added enum values: commit so later statements may use them.`);
    parts.push(`commit;`);
    parts.push(`begin;`);
    parts.push(``);
  }
}
parts.push(`commit;`);

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, parts.join("\n") + "\n");
console.log(`${path.relative(ROOT, out)}: ${files.length} migrations, ${Math.round((parts.join("\n").length / 1024) * 10) / 10} KB`);
