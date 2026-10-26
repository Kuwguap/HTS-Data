import Link from "next/link";
import type { ReactNode } from "react";

export type AppHeaderProps = {
  /** Large 28px title ("Today", "Trips"). */
  title: ReactNode;
  /** Grey 17px line above the title ("Good morning, Ama"). */
  greeting?: ReactNode;
  /** Right slot: a <LiveChip>, <RoundButton>s… */
  right?: ReactNode;
  /** Back link; renders a round "‹" button on the left. */
  back?: string;
  className?: string;
};

/** Sticky page header with the large iOS title. */
export function AppHeader({ title, greeting, right, back, className }: AppHeaderProps) {
  return (
    <header className={["k-header", className ?? ""].join(" ").trim()}>
      <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
        {back ? <RoundButton href={back} label="Back">‹</RoundButton> : null}
        <div style={{ minWidth: 0 }}>
          {greeting ? <div className="k-greeting">{greeting}</div> : null}
          <h1 className="k-title k-title--page">{title}</h1>
        </div>
      </div>
      {right ? <div className="flex items-center gap-2" style={{ flex: "0 0 auto" }}>{right}</div> : null}
    </header>
  );
}

export type RoundButtonProps = {
  /** Accessible name. */
  label: string;
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  /** Red count badge in the corner. */
  badge?: ReactNode;
  className?: string;
};

/**
 * 36px white round icon button for header slots (emoji or glyph inside). The
 * element itself is a 44px tap target (.k-hit); the circle is its face.
 */
export function RoundButton({ label, children, href, onClick, badge, className }: RoundButtonProps) {
  const cls = ["k-hit", "k-hit--36", className ?? ""].join(" ").trim();
  const faceStyle = {
    width: 36,
    height: 36,
    borderRadius: 999,
    background: "var(--surface)",
    color: "var(--text)",
    boxShadow: "var(--shadow)",
    fontSize: 18,
    fontWeight: 700,
    lineHeight: 1,
  };
  const inner = (
    <>
      <span className="k-hit-face" aria-hidden="true" style={faceStyle}>
        {children}
      </span>
      {/* Same spot as before relative to the circle: the tap box is 4px larger on every side. */}
      {badge ? <span style={{ position: "absolute", top: 0, right: -2 }}>{badge}</span> : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} aria-label={label} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" aria-label={label} onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}
