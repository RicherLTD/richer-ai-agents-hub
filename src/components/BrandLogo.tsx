import { cn } from "@/lib/utils";

interface BrandLogoProps {
  /** Tailwind size classes (default: `h-8 w-8`). */
  className?: string;
  /** Optional alt text for accessibility. */
  alt?: string;
}

/**
 * Brand mark for "מערכת ריצ'ר AI". Replaces the previous Sparkles icon
 * everywhere it was used as a system / brand indicator (sidebar header,
 * agent selector, header chips, login page hero).
 *
 * Source: `/public/logo.png` (uploaded by the operator).
 */
export function BrandLogo({ className, alt = "מערכת ריצ'ר AI" }: BrandLogoProps) {
  return (
    <img
      src="/logo.png"
      alt={alt}
      className={cn("h-8 w-8 object-contain", className)}
      draggable={false}
    />
  );
}
