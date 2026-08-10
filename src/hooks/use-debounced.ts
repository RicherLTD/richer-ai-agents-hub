import { useEffect, useState } from "react";

/**
 * Debounce a rapidly-changing value (search boxes) so it only feeds the
 * react-query key — and therefore the network — once the user pauses.
 *
 * Extracted from `pages/Leads.tsx`, which had the only copy until the CRM
 * warming screen needed the same behaviour.
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
