"use client";

import { useId, type ComponentPropsWithRef, type ReactNode } from "react";

type Base = {
  /** Uppercase grey label above the control. */
  label?: ReactNode;
  /** Grey help text under the control. */
  help?: ReactNode;
  /** Red error text; also sets aria-invalid. */
  error?: ReactNode;
  /** Wrapper class. */
  wrapClassName?: string;
};

export type InputFieldProps = Base & { as?: "input"; pin?: boolean } & ComponentPropsWithRef<"input">;
export type SelectFieldProps = Base & { as: "select" } & ComponentPropsWithRef<"select">;
export type TextareaFieldProps = Base & { as: "textarea" } & ComponentPropsWithRef<"textarea">;
export type FieldProps = InputFieldProps | SelectFieldProps | TextareaFieldProps;

/**
 * Labelled form control in the Krab style (14px radius, 16px text so iOS
 * doesn't zoom). `pin` turns an input into the big centred numeric PIN box.
 *
 * ```tsx
 * <Field label="Username" name="username" autoComplete="username" />
 * <Field label="PIN" pin name="pin" type="password" />
 * <Field as="select" label="Pickup point">{options}</Field>
 * ```
 */
export function Field(props: FieldProps) {
  const autoId = useId();
  const { label, help, error, wrapClassName } = props;
  const id = props.id ?? autoId;
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(" ") || undefined;
  const invalid = error ? true : undefined;

  let control: ReactNode;
  if (props.as === "select") {
    const { as: _as, label: _l, help: _h, error: _e, wrapClassName: _w, className, ...rest } = props;
    control = (
      <select id={id} className={["k-field k-select", className ?? ""].join(" ").trim()} aria-invalid={invalid} aria-describedby={describedBy} {...rest} />
    );
  } else if (props.as === "textarea") {
    const { as: _as, label: _l, help: _h, error: _e, wrapClassName: _w, className, ...rest } = props;
    control = (
      <textarea
        id={id}
        className={["k-field", className ?? ""].join(" ").trim()}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        rows={rest.rows ?? 3}
        {...rest}
      />
    );
  } else {
    const { as: _as, label: _l, help: _h, error: _e, wrapClassName: _w, pin, className, ...rest } = props;
    const pinProps = pin
      ? {
          inputMode: "numeric" as const,
          pattern: "[0-9]*",
          maxLength: 6,
          autoComplete: rest.autoComplete ?? "off",
          placeholder: rest.placeholder ?? "••••",
        }
      : {};
    control = (
      <input
        id={id}
        className={["k-field", pin ? "k-field--pin" : "", className ?? ""].filter(Boolean).join(" ")}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        {...pinProps}
        {...rest}
      />
    );
  }

  return (
    <div className={wrapClassName}>
      {label ? (
        <label className="k-label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      {control}
      {error ? (
        <div className="k-error" id={errorId} role="alert">
          {error}
        </div>
      ) : null}
      {help ? (
        <div className="k-help" id={helpId}>
          {help}
        </div>
      ) : null}
    </div>
  );
}
