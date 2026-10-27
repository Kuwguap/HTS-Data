/**
 * Create (or repair) the first admin account with the service role.
 *
 *   pnpm seed:admin -- --username office --name "Hostel Office" --pin 2468
 *   ADMIN_USERNAME=office ADMIN_FULL_NAME="Hostel Office" ADMIN_PIN=2468 pnpm seed:admin
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and PIN_PEPPER from .env.local
 * (then .env). Idempotent: if the username already exists its PIN is reset and the
 * profile is forced to role admin / active.
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { createClient, type User } from "@supabase/supabase-js";
import type { Database } from "../src/lib/db.types";
import { derivePassword, isValidPin, isValidUsername, normalizeUsername, usernameToEmail } from "../src/lib/auth/pin";

const ROOT = path.resolve(__dirname, "..");
loadEnv({ path: path.join(ROOT, ".env.local"), quiet: true });
loadEnv({ path: path.join(ROOT, ".env"), quiet: true });

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} (put it in .env.local)`);
    process.exit(1);
  }
  return v;
}

async function findUserByEmail(
  admin: ReturnType<typeof createClient<Database>>,
  email: string,
): Promise<User | null> {
  // No direct "get by email" in the admin API: page through users (small project).
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 1000) break;
  }
  return null;
}

async function main(): Promise<void> {
  const username = normalizeUsername(argValue("--username") ?? process.env.ADMIN_USERNAME ?? "");
  const fullName = (argValue("--name") ?? process.env.ADMIN_FULL_NAME ?? "").trim();
  const pin = (argValue("--pin") ?? process.env.ADMIN_PIN ?? "").trim();

  if (!isValidUsername(username)) {
    console.error("Username must be 3–20 lowercase letters, digits or underscores (--username / ADMIN_USERNAME)");
    process.exit(1);
  }
  if (fullName.length < 2) {
    console.error("Full name is required (--name / ADMIN_FULL_NAME)");
    process.exit(1);
  }
  if (!isValidPin(pin)) {
    console.error("PIN must be 4–6 digits (--pin / ADMIN_PIN)");
    process.exit(1);
  }

  const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const secretKey = required("SUPABASE_SECRET_KEY");
  const pepper = required("PIN_PEPPER");

  const admin = createClient<Database>(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const email = usernameToEmail(username);
  const password = derivePassword(username, pin, pepper);
  const metadata = { username, full_name: fullName };

  let userId: string;
  let created = false;

  const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: metadata,
    app_metadata: { role: "admin" },
  });

  if (!createError && createdUser.user) {
    userId = createdUser.user.id;
    created = true;
  } else {
    const existing = await findUserByEmail(admin, email);
    if (!existing) {
      throw new Error(`createUser failed: ${createError?.message ?? "unknown error"}`);
    }
    userId = existing.id;
    const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
      password,
      email_confirm: true,
      user_metadata: { ...existing.user_metadata, ...metadata },
      app_metadata: { ...existing.app_metadata, role: "admin" },
    });
    if (updateError) throw new Error(`updateUserById failed: ${updateError.message}`);
  }

  // The auth trigger creates the profile on insert; upsert makes this safe either way
  // and promotes an existing account to admin.
  const { error: profileError } = await admin.from("profiles").upsert(
    {
      id: userId,
      username,
      full_name: fullName,
      role: "admin",
      is_active: true,
      onboarded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (profileError) throw new Error(`profiles upsert failed: ${profileError.message}`);

  // Clear any lockout left over from failed attempts with the old PIN.
  await admin.from("login_attempts").delete().eq("username", username);

  console.log(`${created ? "Created" : "Updated"} admin account`);
  console.log(`  username : ${username}`);
  console.log(`  name     : ${fullName}`);
  console.log(`  user id  : ${userId}`);
  console.log(`  PIN      : set (${pin.length} digits)`);
  console.log("Log in at /login with that username and PIN.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
