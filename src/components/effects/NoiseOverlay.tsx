/**
 * NoiseOverlay — fixed app-wide grain texture.
 *
 * Adds an SVG fractal noise layer at ~2.5% opacity over the entire
 * viewport. It's the difference between "flat plastic" and "real
 * surface". Mounted once at the app root.
 *
 * Why a component instead of just .noise-overlay class on body? It
 * lets React mount + unmount it cleanly for printing / Storybook /
 * tests that need a clean DOM.
 */
export function NoiseOverlay() {
  return <div aria-hidden className="noise-overlay" />;
}
