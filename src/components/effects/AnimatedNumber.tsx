/**
 * AnimatedNumber — Mercury-style count-up animation on the value.
 *
 * Animates from 0 (or the previous value) to the target over `duration`
 * using requestAnimationFrame + ease-out curve. Lands on the exact
 * target — no rounding drift.
 *
 * Important: only animates when the value actually changes AND prefers-
 * reduced-motion is not set. Server-rendered / initial render just
 * shows the value to avoid layout shift.
 */
import { useEffect, useRef, useState } from "react";

interface Props {
  value: number;
  /** ms to animate over. 600-800ms feels premium without dragging. */
  duration?: number;
  /** Optional formatter — defaults to Intl with Hebrew locale + tabular grouping. */
  format?: (n: number) => string;
  /** Pass-through className for the rendered <span>. */
  className?: string;
}

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

const defaultFormat = (n: number): string =>
  new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 }).format(Math.round(n));

export function AnimatedNumber({ value, duration = 700, format = defaultFormat, className }: Props) {
  const [display, setDisplay] = useState<number>(value);
  const previousRef = useRef<number>(value);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    // Respect prefers-reduced-motion — instant snap, no animation.
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(value);
      previousRef.current = value;
      return;
    }
    const from = previousRef.current;
    const to = value;
    if (from === to) return;
    const startTime = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOut(progress);
      const current = from + (to - from) * eased;
      setDisplay(current);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(to);
        previousRef.current = to;
      }
    };
    frameRef.current = requestAnimationFrame(tick);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [value, duration]);

  return <span className={className}>{format(display)}</span>;
}
