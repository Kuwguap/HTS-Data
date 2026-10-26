export const APP_NAME = "Shuttle Me";
export const APP_SHORT_NAME = "Shuttle Me";
export const APP_DESCRIPTION = "Reserve a seat, get reminders and track the Kharis Courts Hostel shuttle live.";
export const THEME_COLOR = "#0070dd";
export const BACKGROUND_COLOR = "#f2f2f7";

/** Where each role lands after login. */
export const HOME_BY_ROLE = {
  student: "/app",
  driver: "/driver",
  admin: "/admin",
} as const;

/** Icon keys → /public/icons paths. Emoji is the fallback glyph rendered first. */
export const ART = {
  bus: { emoji: "🚌", src: "/icons/bus.webp" },
  campus: { emoji: "🏫", src: "/icons/campus.webp" },
  hostel: { emoji: "🏠", src: "/icons/hostel.webp" },
  seat: { emoji: "💺", src: "/icons/seat.webp" },
  cash: { emoji: "💵", src: "/icons/cash.webp" },
  ticket: { emoji: "🎟️", src: "/icons/ticket.webp" },
  calendar: { emoji: "📅", src: "/icons/calendar.webp" },
  bell: { emoji: "🔔", src: "/icons/krab/bell.webp" },
  clock: { emoji: "⏰", src: "/icons/krab/clock.webp" },
  pin: { emoji: "📍", src: "/icons/krab/map_pin.webp" },
  route: { emoji: "🗺️", src: "/icons/krab/route.webp" },
  steering: { emoji: "🛞", src: "/icons/krab/steering.webp" },
  hand: { emoji: "✋", src: "/icons/krab/raised_hand.webp" },
  megaphone: { emoji: "📣", src: "/icons/krab/megaphone.webp" },
  team: { emoji: "👥", src: "/icons/krab/team.webp" },
  roles: { emoji: "🧑‍💼", src: "/icons/krab/roles.webp" },
  gear: { emoji: "⚙️", src: "/icons/krab/gear.webp" },
  check: { emoji: "✅", src: "/icons/krab/check.webp" },
  flag: { emoji: "🏁", src: "/icons/krab/checkered_flag.webp" },
  chat: { emoji: "💬", src: "/icons/krab/chat.webp" },
  key: { emoji: "🔑", src: "/icons/krab/key.webp" },
  track: { emoji: "🛰️", src: "/icons/krab/track_drivers.webp" },
  phone: { emoji: "📞", src: "/icons/krab/phone_handset.webp" },
  receipt: { emoji: "🧾", src: "/icons/krab/receipt.webp" },
  party: { emoji: "🎉", src: "/icons/krab/party_popper.webp" },
  memo: { emoji: "📝", src: "/icons/krab/memo.webp" },
  compass: { emoji: "🧭", src: "/icons/krab/compass.webp" },
  sos: { emoji: "🆘", src: "/icons/krab/sos_button.webp" },
  wave: { emoji: "👋", src: "/icons/krab/waving_hand.webp" },
} as const;

export type ArtKey = keyof typeof ART;
