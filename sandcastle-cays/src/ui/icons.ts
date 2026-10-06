/** Little icons, drawn as SVG paths in code (no image files). */

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  /** A cupped hand scooping, with grains flying. */
  dig: svg(
    '<path d="M4 13c0 4 3.5 7 8 7s8-3 8-7" fill="currentColor" fill-opacity=".18"/><path d="M4 13h16"/><path d="M8 13c.5-2 2-3 4-3s3.5 1 4 3" fill="currentColor" fill-opacity=".35"/><circle cx="7" cy="6" r=".9" fill="currentColor"/><circle cx="11.5" cy="4" r=".9" fill="currentColor"/><circle cx="16" cy="6.5" r=".9" fill="currentColor"/>',
  ),
  /** A mound with sand pouring onto it. */
  pile: svg(
    '<path d="M3 20c2.5-5 5.5-8 9-8s6.5 3 9 8z" fill="currentColor" fill-opacity=".25"/><path d="M12 3v2.2M12 7.5v1.6M10.3 5.2l.5 1.5M13.7 5.2l-.5 1.5"/>',
  ),
  /** An open hand, patting. */
  pat: svg(
    '<path d="M7 12V6.5a1.3 1.3 0 0 1 2.6 0V11M9.6 10.5V5a1.3 1.3 0 0 1 2.6 0v5.5M12.2 10.5V6a1.3 1.3 0 0 1 2.6 0v5M14.8 11V8.5a1.3 1.3 0 0 1 2.6 0V14c0 3.5-2.5 6-6 6h-.5c-2.3 0-3.6-1-4.8-2.6L4 14a1.4 1.4 0 0 1 2.2-1.7L7 13.3" fill="currentColor" fill-opacity=".15"/><path d="M3 22h18" opacity=".6"/>',
  ),
  undo: svg('<path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h9.5a5 5 0 0 1 0 10H11"/>'),
  home: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><path d="M9 16l3-6 3 6" opacity=".7"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  camera: svg('<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  bucket: svg('<path d="M5 8h14l-1.6 12H6.6z" fill="currentColor" fill-opacity=".18"/><path d="M5 8c0-3 3-5 7-5s7 2 7 5"/>'),
};

export function sizeIcon(size: 0 | 1 | 2): string {
  const r = [3, 5, 7.5][size];
  return svg(`<circle cx="12" cy="12" r="${r}" fill="currentColor" fill-opacity=".3"/>`);
}
