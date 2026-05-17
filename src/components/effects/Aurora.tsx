/**
 * Aurora — decorative gradient mesh anchored to the top of a page.
 *
 * Renders a fixed-position, pointer-events-none container with three
 * large radial gradient blobs. Soft, never moves on scroll (so it
 * feels like a backdrop, not parallax), fades to canvas at ~50%
 * page height.
 *
 * Use on Home, Login, Coach. Skip on dense data pages (tables) where
 * it competes with the data.
 */
import { cn } from "@/lib/utils";

interface AuroraProps {
  /** "soft" is lower opacity for in-app surfaces; default is for Login. */
  variant?: "default" | "soft";
  /** Override z-index. Defaults to 0 (behind content). */
  className?: string;
}

export function Aurora({ variant = "default", className }: AuroraProps) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 h-[560px]",
        variant === "soft" ? "aurora-soft" : "aurora",
        // Fade to canvas at the bottom so the seam is invisible.
        "[mask-image:linear-gradient(to_bottom,black_0%,black_70%,transparent_100%)]",
        className,
      )}
    />
  );
}
