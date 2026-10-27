"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Avatar, Button, Empty, Field, FilterPills, List, Pill, Row, SegmentedControl, Sheet, Switch, useToast } from "@/components/ui";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import type { Profile, UserRole } from "@/lib/db.types";

type Filter = "all" | "student" | "driver" | "admin" | "deactivated";
type Props = { users: Profile[]; meId: string; initialFilter?: Filter; initialQuery?: string };

const ROLE_TONE: Record<UserRole, "neutral" | "teal" | "purple"> = { student: "neutral", driver: "teal", admin: "purple" };
const ROLE_LABEL: Record<UserRole, string> = { student: "Student", driver: "Driver", admin: "Admin" };

export function UsersList({ users: initialUsers, meId, initialFilter = "all", initialQuery = "" }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [users, setUsers] = useState(initialUsers);
  const [q, setQ] = useState(initialQuery);
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"role" | "active" | "pin" | null>(null);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | undefined>();

  const selected = users.find((u) => u.id === selectedId) ?? null;

  const counts = useMemo(() => {
    const c = { all: 0, student: 0, driver: 0, admin: 0, deactivated: 0 };
    for (const u of users) {
      if (!u.is_active) {
        c.deactivated++;
        continue;
      }
      c.all++;
      c[u.role]++;
    }
    return c;
  }, [users]);

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return users.filter((u) => {
      if (filter === "deactivated" ? u.is_active : !u.is_active) return false;
      if (filter !== "all" && filter !== "deactivated" && u.role !== filter) return false;
      if (!term) return true;
      return [u.full_name, u.username, u.room ?? "", u.phone ?? ""].some((v) => v.toLowerCase().includes(term));
    });
  }, [users, q, filter]);

  const patchUser = (next: Profile) => setUsers((list) => list.map((u) => (u.id === next.id ? next : u)));

  async function changeRole(role: UserRole) {
    if (!selected || selected.role === role) return;
    setBusy("role");
    try {
      const res = await api.post<{ user: Profile }>(`/api/admin/users/${selected.id}/role`, { role });
      patchUser({ ...selected, ...res.user });
      toast(`✅ ${selected.full_name.split(" ")[0]} is now a ${ROLE_LABEL[role].toLowerCase()}`, { tone: "green" });
      router.refresh();
    } catch (err) {
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(null);
    }
  }

  async function changeActive(is_active: boolean) {
    if (!selected) return;
    if (!is_active && !window.confirm(`Deactivate ${selected.full_name}? They will be logged out and can't book until reactivated.`)) return;
    setBusy("active");
    try {
      const res = await api.post<{ user: Profile }>(`/api/admin/users/${selected.id}/active`, { is_active });
      patchUser({ ...selected, ...res.user });
      toast(is_active ? "✅ Account reactivated" : "⏸ Account deactivated");
      router.refresh();
    } catch (err) {
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(null);
    }
  }

  async function resetPin(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBusy("pin");
    setPinError(undefined);
    try {
      await api.post(`/api/admin/users/${selected.id}/pin`, { pin });
      toast(`🔑 PIN reset for @${selected.username}`, { tone: "green" });
      setPin("");
    } catch (err) {
      if (err instanceof ApiClientError) setPinError(err.fieldError("pin"));
      toast(`⚠️ ${errorMessage(err)}`, { tone: "red" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Field type="search" placeholder="Search name, username, room, phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" autoComplete="off" />
      <FilterPills
        aria-label="Filter people"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: "All", count: counts.all },
          { value: "student", label: "Students", count: counts.student },
          { value: "driver", label: "Drivers", count: counts.driver },
          { value: "admin", label: "Admins", count: counts.admin },
          { value: "deactivated", label: "Deactivated", count: counts.deactivated },
        ]}
      />

      <List caption={`${visible.length} ${visible.length === 1 ? "person" : "people"}`}>
        {visible.length === 0 ? (
          <Empty art="team" title="Nobody matches" hint={q ? "Try a different search." : "People appear here once they register."} />
        ) : (
          visible.map((u) => (
            <Row
              key={u.id}
              leading={<Avatar name={u.full_name} />}
              title={`${u.full_name}${u.id === meId ? " (you)" : ""}`}
              subtitle={[`@${u.username}`, u.room ? `Room ${u.room}` : null, u.phone].filter(Boolean).join(" · ")}
              trailing={
                u.role !== "student" ? (
                  <Pill tone={ROLE_TONE[u.role]} sm>
                    {ROLE_LABEL[u.role]}
                  </Pill>
                ) : !u.is_active ? (
                  <Pill tone="red" sm>
                    Off
                  </Pill>
                ) : undefined
              }
              onClick={() => {
                setSelectedId(u.id);
                setPin("");
                setPinError(undefined);
              }}
              chevron
            />
          ))
        )}
      </List>

      <Sheet open={selected !== null} onClose={() => setSelectedId(null)} title={selected?.full_name ?? ""}>
        {selected ? (
          <>
            <List>
              <Row label="Username" value={`@${selected.username}`} />
              <Row label="Room" value={selected.room ?? "—"} />
              <Row
                label="Phone"
                value={
                  selected.phone ? (
                    <a href={`tel:${selected.phone.replace(/\s+/g, "")}`} className="k-link" style={{ minHeight: 0 }}>
                      📞 {selected.phone}
                    </a>
                  ) : (
                    "—"
                  )
                }
              />
              {/* Staff alerts are duty alerts: delivery never reads reminders_enabled for drivers/admins. */}
              <Row label="Reminders" value={selected.role === "student" ? (selected.reminders_enabled ? "On" : "Off") : "Always on"} />
              <Row label="Joined" value={new Date(selected.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} />
            </List>

            <div>
              <span className="k-label">Role</span>
              <SegmentedControl
                aria-label="Role"
                value={selected.role}
                onChange={changeRole}
                options={[
                  { value: "student", label: "Student", disabled: selected.id === meId || busy !== null },
                  { value: "driver", label: "Driver", disabled: selected.id === meId || busy !== null },
                  { value: "admin", label: "Admin", disabled: selected.id === meId || busy !== null },
                ]}
              />
              {selected.id === meId ? <div className="k-help">You can&apos;t change your own role.</div> : null}
            </div>

            <List>
              <Row
                title="Active"
                subtitle={selected.is_active ? "Can log in and book" : "Logged out, can't book"}
                trailing={<Switch checked={selected.is_active} disabled={selected.id === meId || busy !== null} onChange={changeActive} label="Active" />}
              />
            </List>

            <form onSubmit={resetPin} className="flex flex-col gap-2">
              <Field label="Reset PIN" pin type="text" value={pin} onChange={(e) => setPin(e.target.value)} error={pinError} help="Tell them the new 4–6 digit PIN in person. Any lockout is cleared." />
              <Button variant="secondary" type="submit" loading={busy === "pin"} disabled={pin.length < 4}>
                🔑 Set new PIN
              </Button>
            </form>
          </>
        ) : null}
      </Sheet>
    </>
  );
}
