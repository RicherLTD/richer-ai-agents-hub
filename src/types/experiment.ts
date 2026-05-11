/**
 * Experiment type re-exports — A/B test definitions live in
 * `public.experiments` and conversations carry a free-text
 * `experiment_variant` column linking them to a variant.
 */
import type { Database } from "./database";

export type Experiment = Database["public"]["Tables"]["experiments"]["Row"];
