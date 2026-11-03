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
  /** A notebook with a shell on the cover. */
  book: svg('<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" fill="currentColor" fill-opacity=".15"/><path d="M5 17a3 3 0 0 1 3-3h11"/><path d="M10 8.5c1-1.5 3-1.5 4 0" /><path d="M9.5 10h5"/>'),
  /** A folded chart. */
  chart: svg('<path d="M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2z" fill="currentColor" fill-opacity=".15"/><path d="M9 4v14M15 6v14"/><circle cx="12" cy="11" r="1.2" fill="currentColor"/>'),
  /** A tiller / steering. */
  helm: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>'),
  /** An anchor. */
  anchor: svg('<circle cx="12" cy="5" r="2"/><path d="M12 7v13M8 10h8M5 14c1 4 4 6 7 6s6-2 7-6"/>'),
  /** Sails up / down. */
  sailUp: svg('<path d="M12 3v15M12 4l7 12h-7" fill="currentColor" fill-opacity=".2"/><path d="M5 20h14"/><path d="M5 9l2-3 2 3" opacity=".8"/>'),
  sailDown: svg('<path d="M12 3v15M12 11l5 5h-5" fill="currentColor" fill-opacity=".2"/><path d="M5 20h14"/><path d="M5 6l2 3 2-3" opacity=".8"/>'),
  /** The outboard: a propeller with an arrow ahead / astern. */
  motorUp: svg('<circle cx="8" cy="14" r="1.6" fill="currentColor"/><path d="M8 12.4c-1-3 1-5 2-3.2M8 15.6c1 3-1 5-2 3.2M9.6 14c3 1 5-1 3.2-2" /><path d="M15 9h6M18 6l3 3-3 3"/>'),
  motorDown: svg('<circle cx="16" cy="14" r="1.6" fill="currentColor"/><path d="M16 12.4c-1-3 1-5 2-3.2M16 15.6c1 3-1 5-2 3.2M17.6 14c3 1 5-1 3.2-2" /><path d="M9 9H3M6 6L3 9l3 3"/>'),
  /** A woven basket. */
  /** A bowl with steam: food in the larder. */
  food: svg('<path d="M4 12h16c0 4-3.6 7-8 7s-8-3-8-7z" fill="currentColor" fill-opacity=".2"/><path d="M9 9c-.8-1 .8-2 0-3M12 9c-.8-1 .8-2 0-3M15 9c-.8-1 .8-2 0-3"/>'),
  /** A drop of water. */
  water: svg('<path d="M12 3.5c3 4 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.5-6 5.5-10z" fill="currentColor" fill-opacity=".2"/><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5" opacity=".7"/>'),
  /** A fishing rod with its line and a hook. */
  rod: svg('<path d="M4 20L18 4"/><path d="M18 4c1.5 4 1.5 9 0 12"/><path d="M18 16c0 1.5-1 2.5-2.2 2.5S14 17.5 14 16.5" /><circle cx="6.5" cy="17.5" r="1.6"/>'),
  /** A mallet: the workbench. */
  mallet: svg('<path d="M10 14l-6 6"/><path d="M9.5 6.5l4-4 8 8-4 4z" fill="currentColor" fill-opacity=".2"/><path d="M11.5 12.5l2-2"/>'),
  basket: svg('<path d="M4 10h16l-2 9H6z" fill="currentColor" fill-opacity=".18"/><path d="M8 10c0-3 1.8-5 4-5s4 2 4 5"/><path d="M5 13.5h14M6 16.5h12" opacity=".6"/>'),
  /** Standing up from the sand. */
  stand: svg('<circle cx="12" cy="4.5" r="2"/><path d="M12 7v7M12 14l-3 6M12 14l3 6M8 10l4-2 4 2"/>'),
  /** Jump / climb: an arrow up. */
  up: svg('<path d="M12 19V6M6.5 11.5L12 6l5.5 5.5"/>'),
  /** A hand reaching to take something. */
  grab: svg('<path d="M7 12V7.5a1.3 1.3 0 0 1 2.6 0V11M9.6 11V5.5a1.3 1.3 0 0 1 2.6 0V11M12.2 11V6.5a1.3 1.3 0 0 1 2.6 0V12M14.8 12V9a1.3 1.3 0 0 1 2.6 0v5c0 3.5-2.5 6-6 6H11c-2.3 0-3.6-1-4.8-2.6L4 14.5a1.4 1.4 0 0 1 2.2-1.7l.8 1"/>'),
  bucket: svg('<path d="M5 8h14l-1.6 12H6.6z" fill="currentColor" fill-opacity=".18"/><path d="M5 8c0-3 3-5 7-5s7 2 7 5"/>'),
};

export function sizeIcon(size: 0 | 1 | 2): string {
  const r = [3, 5, 7.5][size];
  return svg(`<circle cx="12" cy="12" r="${r}" fill="currentColor" fill-opacity=".3"/>`);
}
