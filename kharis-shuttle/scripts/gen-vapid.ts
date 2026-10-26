/**
 * Generate a VAPID key pair for Web Push and print the env lines to paste into
 * .env.local (and the Vercel project settings).
 *
 *   pnpm vapid
 *   pnpm vapid -- --subject mailto:office@kharis-courts.example
 *
 * Generate once and keep the pair: changing it invalidates every existing
 * push subscription (students would have to enable reminders again).
 */
import webpush from "web-push";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

const subject = argValue("--subject") ?? process.env.VAPID_SUBJECT ?? "mailto:admin@example.com";
if (!/^(mailto:|https:)/.test(subject)) {
  console.error("VAPID_SUBJECT must be a mailto: address or an https: URL");
  process.exit(1);
}

const keys = webpush.generateVAPIDKeys();

process.stdout.write(
  [
    `NEXT_PUBLIC_VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    `VAPID_SUBJECT=${subject}`,
    "",
  ].join("\n"),
);
