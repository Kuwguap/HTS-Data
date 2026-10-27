/**
 * Print SQL that creates staff accounts directly in Supabase Auth — for when the
 * service-role route (`pnpm seed:admin`) cannot reach the project and the SQL editor
 * is the only way in.
 *
 *   pnpm seed:sql -- --user office:"Hostel Office":admin:2468 --user driver:"Shuttle Driver":driver:1357
 *   pnpm seed:sql -- --user office:"Hostel Office":admin:2468 --out .deploy/02-accounts.sql
 *
 * Each --user is username:full name:role:pin (role student|driver|admin). The PIN is
 * never written out: the script derives the Supabase Auth password exactly as the
 * app does (HMAC-SHA256 with PIN_PEPPER from .env.local) and the SQL bcrypt-hashes
 * it with pgcrypto, so the output is safe to keep. Idempotent per username: an
 * existing account gets its password, metadata and role refreshed.
 *
 * Why the extra columns: GoTrue scans the four token columns that have no default
 * (confirmation_token, recovery_token, email_change_token_new, email_change) as
 * non-null strings, so they are set to ''; every other column keeps its default.
 * An auth.identities row keeps the account visible to the Auth dashboard and the
 * email provider.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { derivePassword, isValidPin, isValidUsername, normalizeUsername, usernameToEmail } from "../src/lib/auth/pin";

const ROOT = path.resolve(__dirname, "..");
loadEnv({ path: path.join(ROOT, ".env.local"), quiet: true });
loadEnv({ path: path.join(ROOT, ".env"), quiet: true });

type Spec = { username: string; fullName: string; role: "student" | "driver" | "admin"; pin: string };

function parseUsers(): Spec[] {
  const specs: Spec[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== "--user") continue;
    const raw = process.argv[i + 1] ?? "";
    const [u, name, role, pin] = raw.split(":");
    const username = normalizeUsername(u ?? "");
    if (!isValidUsername(username)) throw new Error(`bad username in --user ${raw}`);
    if (!name || name.trim().length < 2) throw new Error(`full name missing in --user ${raw}`);
    if (role !== "student" && role !== "driver" && role !== "admin") throw new Error(`role must be student|driver|admin in --user ${raw}`);
    if (!isValidPin(pin ?? "")) throw new Error(`PIN must be 4–6 digits in --user ${raw}`);
    specs.push({ username, fullName: name.trim(), role, pin: pin! });
  }
  if (specs.length === 0) throw new Error("pass at least one --user username:full name:role:pin");
  return specs;
}

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

const pepper = process.env.PIN_PEPPER;
if (!pepper || pepper.length < 32) {
  console.error("PIN_PEPPER (32+ chars) must be set in .env.local — the same value the deployed app uses");
  process.exit(1);
}

const specs = parseUsers();
const blocks = specs.map((s) => {
  const email = usernameToEmail(s.username);
  const password = derivePassword(s.username, s.pin, pepper);
  const userMeta = JSON.stringify({ username: s.username, full_name: s.fullName });
  const appMeta = JSON.stringify({ provider: "email", providers: ["email"], role: s.role });
  const onboarded = s.role === "admin" ? "now()" : "null";
  return `-- ${s.role}: ${s.username} (${s.fullName})
do $$
declare
  v_id uuid;
begin
  select id into v_id from auth.users where email = ${lit(email)};
  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', ${lit(email)},
      crypt(${lit(password)}, gen_salt('bf', 10)), now(),
      ${lit(appMeta)}::jsonb, ${lit(userMeta)}::jsonb, now(), now(),
      '', '', '', ''
    );
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      gen_random_uuid(), v_id, v_id::text,
      jsonb_build_object('sub', v_id::text, 'email', ${lit(email)}, 'email_verified', true, 'phone_verified', false),
      'email', now(), now(), now()
    );
  else
    update auth.users
       set encrypted_password = crypt(${lit(password)}, gen_salt('bf', 10)),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || ${lit(appMeta)}::jsonb,
           raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || ${lit(userMeta)}::jsonb,
           updated_at = now()
     where id = v_id;
  end if;

  -- The auth trigger creates the profile on insert; this makes the role/name authoritative either way.
  insert into public.profiles (id, username, full_name, role, is_active, onboarded_at)
  values (v_id, ${lit(s.username)}, ${lit(s.fullName)}, ${lit(s.role)}::public.user_role, true, ${onboarded})
  on conflict (id) do update
    set full_name = excluded.full_name,
        role = excluded.role,
        is_active = true,
        onboarded_at = coalesce(public.profiles.onboarded_at, excluded.onboarded_at);
  delete from public.login_attempts where username = ${lit(s.username)};
end
$$;`;
});

const sql = `-- Shuttle Me — staff accounts (generated ${new Date().toISOString()}). Safe to re-run.
-- Run AFTER the schema bundle. Contains bcrypt hashes only; the PINs were given to you separately.
${blocks.join("\n\n")}

select p.username, p.full_name, p.role, p.is_active, (u.email_confirmed_at is not null) as confirmed
  from public.profiles p join auth.users u on u.id = p.id
 where p.username in (${specs.map((s) => lit(s.username)).join(", ")})
 order by p.role desc, p.username;
`;

const out = argValue("--out");
if (out) {
  const file = path.resolve(ROOT, out);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, sql);
  console.log(`${path.relative(ROOT, file)}: ${specs.length} account(s)`);
} else {
  process.stdout.write(sql);
}
