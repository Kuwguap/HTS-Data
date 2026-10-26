"use client";

import { useCallback, useState, type CSSProperties } from "react";
import { ART, type ArtKey } from "@/lib/constants";

export type ArtProps = {
  /** Key into the ART map (lib/constants). */
  k?: ArtKey;
  /** Custom glyph when not using a key. */
  emoji?: string;
  /** Custom image when not using a key; `null` disables the image. */
  src?: string | null;
  /** Box size in px (square). The emoji is scaled to fit it. */
  size?: number;
  /** Accessible name. Omit for decorative art (aria-hidden). */
  label?: string;
  className?: string;
  style?: CSSProperties;
};

/**
 * The Krab "art" pattern: an emoji renders immediately, the glossy 3D WebP
 * fades in on top once loaded, and the emoji stays if the image 404s.
 *
 * ```tsx
 * <Art k="bus" size={36} />
 * <Art emoji="📤" size={28} label="Share" />
 * ```
 */
export function Art({ k, emoji, src, size = 32, label, className, style }: ArtProps) {
  const entry = k ? ART[k] : undefined;
  const glyph = emoji ?? entry?.emoji ?? "•";
  const image = src === null ? undefined : (src ?? entry?.src);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // Cached images can finish before React attaches onLoad; catch that here.
  const imgRef = useCallback((el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth > 0) setLoaded(true);
  }, []);

  const showImage = Boolean(image) && !failed;
  return (
    <span
      className={["k-art", loaded && showImage ? "is-loaded" : "", className ?? ""].join(" ").trim()}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.78), ...style }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <span className="k-art-glyph">{glyph}</span>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- static webp with an emoji fallback, no optimisation wanted
        <img
          ref={imgRef}
          className="k-art-img"
          src={image}
          alt=""
          width={size}
          height={size}
          decoding="async"
          loading="lazy"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}
