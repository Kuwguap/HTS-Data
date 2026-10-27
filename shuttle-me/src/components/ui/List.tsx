import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Caption } from "./Caption";

export type ListProps = ComponentPropsWithoutRef<"div"> & {
  /** Small uppercase grey heading rendered above the group. */
  caption?: ReactNode;
  /** Something on the caption's right (e.g. a "See all" link). */
  captionAction?: ReactNode;
  children?: ReactNode;
};

/**
 * iOS grouped list: a white 14px-rounded surface whose `<Row>` children are
 * separated by 0.5px hairlines.
 *
 * ```tsx
 * <List caption="Departures">
 *   <Row title="7:30 AM" subtitle="12 seats left" trailing={<Button pill size="sm">Book</Button>} />
 * </List>
 * ```
 */
export function List({ caption, captionAction, className, children, ...rest }: ListProps) {
  const list = (
    <div className={["k-list", className ?? ""].join(" ").trim()} {...rest}>
      {children}
    </div>
  );
  if (!caption) return list;
  return (
    <div>
      <Caption action={captionAction}>{caption}</Caption>
      {list}
    </div>
  );
}
