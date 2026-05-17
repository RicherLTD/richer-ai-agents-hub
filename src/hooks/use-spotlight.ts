/**
 * useSpotlight — radial gradient that follows the cursor inside an element.
 *
 * Sets CSS custom properties --mx and --my (in percent) on the ref
 * target. Pair with the `.spotlight` utility in index.css which uses
 * those vars as the center of a radial-gradient on a ::before layer.
 *
 * Usage:
 *   const ref = useSpotlight<HTMLDivElement>();
 *   <div ref={ref} className="spotlight relative">...</div>
 *
 * Why CSS vars instead of inline style? Avoids React re-renders on
 * every mouse move; the browser handles the paint.
 */
import { useEffect, useRef } from "react";

export function useSpotlight<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * 100;
      const my = ((e.clientY - rect.top) / rect.height) * 100;
      el.style.setProperty("--mx", `${mx}%`);
      el.style.setProperty("--my", `${my}%`);
    };
    el.addEventListener("mousemove", handleMove);
    return () => el.removeEventListener("mousemove", handleMove);
  }, []);

  return ref;
}
