/**
 * Every icon in the interface, drawn as SVG paths in code (no image files).
 * Line icons use `currentColor`, so CSS decides their ink.
 */
import { AnimalModel, PlantModel, roadFamily, type Road, type RoadFamily, type SpeciesDef } from '../content/speciesTypes';
import type { BrushSize, ToolId } from '../config';

const svg = (body: string, size = 26) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const soft = 'fill="currentColor" fill-opacity=".18"';

export const ICONS = {
  /** A little volcano with a lava run and sparks. */
  lava: svg(`<path d="M3 20l5.5-9h7L21 20z" ${soft}/><path d="M8.5 11c1.2-1.6 2-2.2 3.5-2.2s2.3.6 3.5 2.2"/><path d="M12.3 11.2c-.6 1.8.9 2.7.1 4.4-.5 1.1-.1 2.3.6 4.2"/><path d="M12 6V3.8M9.2 6.6 7.8 5M14.8 6.6 16.2 5"/>`),
  /** Two boulders, one resting on the other. */
  rock: svg(`<path d="M3.5 20l1.8-6.2 5.4-2.3 4.4 3.2 1 5.3z" ${soft}/><path d="M12.6 11.6l2.6-4.4 4.6.8 1.2 5.6-3.3 2.4"/><path d="M7.5 15.5l2 1.2"/>`),
  /** A mound with grains pouring onto it. */
  sand: svg(`<path d="M3 20c2.5-5 5.5-8 9-8s6.5 3 9 8z" ${soft}/><path d="M12 3v2.2M12 7.5v1.6M10.3 5.2l.5 1.5M13.7 5.2l-.5 1.5"/>`),
  /** An open hand, smoothing. */
  hands: svg(`<path d="M7 12V6.5a1.3 1.3 0 0 1 2.6 0V11M9.6 10.5V5a1.3 1.3 0 0 1 2.6 0v5.5M12.2 10.5V6a1.3 1.3 0 0 1 2.6 0v5M14.8 11V8.5a1.3 1.3 0 0 1 2.6 0V14c0 3.5-2.5 6-6 6h-.5c-2.3 0-3.6-1-4.8-2.6L4 14a1.4 1.4 0 0 1 2.2-1.7L7 13.3" ${soft}/>`),
  /** A cupped scoop lifting earth away. */
  scoop: svg(`<path d="M4 13c0 4 3.5 7 8 7s8-3 8-7" ${soft}/><path d="M4 13h16"/><path d="M8 13c.5-2 2-3 4-3s3.5 1 4 3" fill="currentColor" fill-opacity=".35"/><circle cx="7" cy="6" r=".9" fill="currentColor"/><circle cx="11.5" cy="4" r=".9" fill="currentColor"/><circle cx="16" cy="6.5" r=".9" fill="currentColor"/>`),
  /** An eye: Look. */
  look: svg(`<path d="M2 12s3.6-6.2 10-6.2S22 12 22 12s-3.6 6.2-10 6.2S2 12 2 12z" ${soft}/><circle cx="12" cy="12" r="3.1"/><circle cx="13" cy="11" r=".8" fill="currentColor"/>`),
  undo: svg('<path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h9.5a5 5 0 0 1 0 10H11"/>'),
  /** An open notebook. */
  journal: svg(`<path d="M3.5 5.5c3-1.2 6-1 8.5 1 2.5-2 5.5-2.2 8.5-1v13.5c-3-1.2-6-1-8.5 1-2.5-2-5.5-2.2-8.5-1z" ${soft}/><path d="M12 6.5v13"/><path d="M6 9h3.5M6 12h3.5M14.5 9H18"/>`),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  camera: svg('<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  /** A folded paper map. */
  chart: svg(`<path d="M3 6.5l6-2.3 6 2.3 6-2.3v13.3l-6 2.3-6-2.3-6 2.3z" ${soft}/><path d="M9 4.2v13.3M15 6.5v13.3"/>`),
  /** A target: glide there. */
  glide: svg('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>'),
  /** Frame the islands. */
  home: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><path d="M8 15c1.5-.2 2.2-1 3-3l1-2 1.5 2.5 1-1 1.5 3.5"/>'),
  wind: svg('<path d="M3 9h11a3 3 0 1 0-3-3"/><path d="M3 13h15a3 3 0 1 1-3 3"/><path d="M3 17h6"/>'),
  wave: svg('<path d="M2 14c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 5 3"/><path d="M2 18.5c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2" opacity=".55"/><path d="M8 8.5c1.2-2.6 4-3.6 6.4-2.6"/>'),
  wing: svg('<path d="M2 10.5c2.6-1.6 5.2-1 7.2 2 .8.9 1.8 1.3 2.8 1.3s2-.4 2.8-1.3c2-3 4.6-3.6 7.2-2"/><path d="M15 6.5c1.2-.8 2.4-.9 3.4-.4" opacity=".55"/>'),
  storm: svg(`<path d="M7 15a4 4 0 1 1 1-7.9A5 5 0 0 1 17.5 9 3.5 3.5 0 0 1 17 16H7z" ${soft}/><path d="M9 18.5l-1 2M13 18.5l-1 2M17 18.5l-1 2"/>`),
  land: svg(`<path d="M2 18c3 0 4.2-1 6-4.5L11 8l3 4 2-2 6 8z" ${soft}/><path d="M2 20.5h20" opacity=".5"/>`),
  star: svg(`<path d="M12 3.2l2.6 5.5 6 .7-4.5 4.1 1.2 6L12 16.5l-5.3 3 1.2-6-4.5-4.1 6-.7z" ${soft}/>`),
  /** The sun rising: a new Age. */
  age: svg('<path d="M3.5 17.5h17"/><path d="M7 17.5a5 5 0 0 1 10 0" fill="currentColor" fill-opacity=".18"/><path d="M12 6.5v2.2M5.7 9.6l1.5 1.5M18.3 9.6l-1.5 1.5"/>'),
  pin: svg(`<path d="M12 21s-6-6-6-11a6 6 0 0 1 12 0c0 5-6 11-6 11z" ${soft}/><circle cx="12" cy="10" r="2.2"/>`),
  save: svg('<path d="M12 4v10.5M7.5 10l4.5 4.5 4.5-4.5"/><path d="M4 16.5v3.5h16v-3.5"/>'),
  load: svg('<path d="M12 15V4.5M7.5 9L12 4.5 16.5 9"/><path d="M4 16.5v3.5h16v-3.5"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.6a2.4 2.4 0 0 1 4.8 0c0 1.7-2.4 2-2.4 4"/><circle cx="12" cy="17" r=".9" fill="currentColor"/>'),
  checks: svg('<path d="M8.5 3.5h7v3h-7z"/><path d="M6.5 5H5v16h14V5h-1.5"/><path d="M8.8 13.5l2.2 2.2 4.4-4.6"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".9" fill="currentColor"/>'),
  settings: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  sea: svg('<path d="M2 16c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 5 3"/><circle cx="12" cy="7.5" r="2.4" fill="currentColor" fill-opacity=".4"/><path d="M12 2.5v1.3M7 7.5H5.7M18.3 7.5H17M8.5 4l.9.9M15.5 4l-.9.9"/>'),
} as const;

export type IconName = keyof typeof ICONS;

export const TOOL_ICON: Record<ToolId, string> = {
  lava: ICONS.lava,
  rock: ICONS.rock,
  sand: ICONS.sand,
  hands: ICONS.hands,
  scoop: ICONS.scoop,
  look: ICONS.look,
};

/** The size button: one, two or three soft circles. */
export function sizeIcon(size: BrushSize): string {
  const r = [3, 5.2, 7.8][size];
  return svg(`<circle cx="12" cy="12" r="${r}" fill="currentColor" fill-opacity=".28"/><circle cx="12" cy="12" r="${r}"/>`);
}

export function familyIcon(f: RoadFamily): string {
  return f === 'wind' ? ICONS.wind : f === 'wave' ? ICONS.wave : ICONS.wing;
}

export function roadIcon(r: Road): string {
  return familyIcon(roadFamily(r));
}

// ---------- field-guide silhouettes ----------

const sil = (body: string) => `<svg viewBox="0 0 48 48" aria-hidden="true">${body}</svg>`;

/** Simple filled shapes, one per kind of body. They are tinted by CSS (`fill: currentColor`). */
const SILHOUETTE = {
  tree: sil('<path d="M22 46h4l-.6-15h-2.8z"/><circle cx="24" cy="20" r="12"/><circle cx="14" cy="25" r="7"/><circle cx="34" cy="25" r="7"/>'),
  palm: sil('<path d="M23 46c0-12 1-22 3-30h2c-2 8-2.6 18-2.4 30z"/><path d="M27 15c-6-5-14-5-19 0 6-1 12 0 19 2zM27 15c6-6 13-6 18-1-6-1-12-.5-18 3zM27 15c-2-6-1-10 3-13 0 4-1 8-2 13zM27 15c-7 1-12 5-14 11 3-4 8-7 14-9zM27 15c6 1 11 5 13 11-3-4-8-7-13-9z"/>'),
  fern: sil('<path d="M24 46c0-8-2-16-12-24 3 0 6 2 8 4-2-5-6-9-12-11 6-1 11 2 14 7 0-7-2-12-5-16 5 2 7 9 7 16 2-6 6-11 12-12-4 3-7 8-8 13 4-4 9-5 14-4-6 2-10 6-12 11-1 5-1 11-1 16z"/>'),
  grass: sil('<path d="M10 46c2-10 2-20-2-30 4 8 6 18 6 30zM18 46c0-14 2-26 6-38-2 14-2 26-2 38zM26 46c2-12 6-22 14-30-6 10-8 20-9 30zM34 46c0-8 2-14 8-20-4 8-4 14-4 20z"/>'),
  herb: sil('<path d="M23 46h2V22h-2z"/><path d="M24 34c-4-1-8-4-9-9 5 1 8 4 9 9zM24 30c4-1 8-4 9-9-5 1-8 4-9 9z"/><circle cx="24" cy="16" r="5"/><circle cx="18" cy="14" r="3.4"/><circle cx="30" cy="14" r="3.4"/><circle cx="24" cy="9" r="3.4"/>'),
  coral: sil('<path d="M22 46h4v-10l6-6v-9h-3v8l-3 3V18h-4v14l-4-4v-8h-3v9l7 7z"/><circle cx="30.5" cy="19" r="2.5"/><circle cx="24" cy="16" r="2.6"/><circle cx="16.5" cy="18.5" r="2.5"/>'),
  seagrass: sil('<path d="M12 46c-2-10 4-16 0-30 4 8 2 18 4 30zM20 46c-1-14 5-22 2-36 5 10 1 24 2 36zM28 46c0-12 6-18 4-30 4 8 0 20-1 30zM36 46c0-8 3-12 2-20 3 6 1 14 0 20z"/>'),
  tint: sil('<path d="M4 44c2-10 10-16 20-16s18 6 20 16z" opacity=".55"/><circle cx="16" cy="32" r="3.5"/><circle cx="26" cy="30" r="4.5"/><circle cx="34" cy="35" r="3"/><circle cx="21" cy="37" r="2.5"/>'),
  seabird: sil('<path d="M2 20c8-4 15-2 20 6 1 1 1.5 1.4 2 1.4s1-.4 2-1.4c5-8 12-10 20-6-7 0-12 3-16 10-2 3-4 4-6 4s-4-1-6-4C14 23 9 20 2 20z"/>'),
  bird: sil('<path d="M14 30c0-8 6-13 13-13 3 0 5 1 7 3l6-1-4 4c0 9-7 15-16 15l-8 6 2-7c-1-2-0-5 0-7z"/><path d="M20 46h2v-4h-2zM25 46h2v-4h-2z"/>'),
  wader: sil('<path d="M28 6c3 0 5 2 5 4l7 1-7 2c-1 3-3 5-3 9 0 5-4 9-10 9-5 0-8-3-8-6l10-2c2-3 2-7 1-11 0-4 2-6 5-6z"/><path d="M20 31h2v15h-2zM25 31h2v15h-2z"/>'),
  fish: sil('<path d="M6 24c6-8 16-11 26-6l10-6-3 12 3 12-10-6c-10 5-20 2-26-6z"/><circle cx="14" cy="22" r="1.6" fill="#fff"/>'),
  turtle: sil('<ellipse cx="24" cy="26" rx="13" ry="10"/><circle cx="39" cy="24" r="4"/><path d="M14 18l-6-6 2 8zM14 34l-6 6 2-8zM32 18l6-6-2 8zM32 34l6 6-2-8z"/>'),
  crab: sil('<ellipse cx="24" cy="28" rx="11" ry="7"/><path d="M8 18c-3-4-2-8 2-9-2 3-1 6 2 7zM40 18c3-4 2-8-2-9 2 3 1 6-2 7z"/><path d="M12 16l3 7M36 16l-3 7M13 30l-8 4M13 33l-7 7M35 30l8 4M35 33l7 7" stroke="currentColor" stroke-width="2.4"/>'),
  lizard: sil('<path d="M6 30c6-6 14-8 22-7l10-3c3 0 5 1 5 3s-2 3-5 3l-8 2c-6 4-12 6-24 2z"/><path d="M16 26l-4-6M16 31l-4 6M28 25l3-6M28 30l3 6" stroke="currentColor" stroke-width="2.4"/><path d="M6 30C4 36 6 42 12 44" stroke="currentColor" stroke-width="2.4" fill="none"/>'),
  insect: sil('<path d="M24 14v22" stroke="currentColor" stroke-width="2.6"/><path d="M23 22c-6-10-16-12-18-6-1 5 7 9 18 8zM25 22c6-10 16-12 18-6 1 5-7 9-18 8zM23 26c-5 2-12 8-9 12 2 3 8-2 9-10zM25 26c5 2 12 8 9 12-2 3-8-2-9-10z"/>'),
  spider: sil('<circle cx="24" cy="27" r="6"/><circle cx="24" cy="18" r="4"/><path d="M19 24L8 16l-2 6M19 27L6 28l-1 6M19 30l-9 8 1 5M29 24l11-8 2 6M29 27l13 1 1 6M29 30l9 8-1 5" stroke="currentColor" stroke-width="2.2" fill="none"/><path d="M24 2v12" stroke="currentColor" stroke-width="1" fill="none"/>'),
  snail: sil('<circle cx="26" cy="24" r="10"/><path d="M6 36c4 0 10-1 14-2h20c3 0 4 2 2 3H6z"/><path d="M10 35c-1-5 0-9 2-11l1 2c-1 2-1 5 0 9z"/>'),
  whale: sil('<path d="M4 26c4-8 14-12 26-10 6 1 9 4 10 8l6-6-2 9 2 9-6-5c-4 6-14 8-24 6C9 36 5 32 4 26z"/>'),
  bat: sil('<path d="M24 20c2 0 3 2 3 4 4-6 12-8 19-5-4 1-6 3-6 6-3-2-6-1-8 2-2-2-5-1-6 2-1-3-4-4-6-2-2-3-5-4-8-2 0-3-2-5-6-6 7-3 15-1 19 5 0-2 1-4 3-4z"/>'),
  seal: sil('<path d="M8 38c0-10 8-18 18-20 2-6 6-9 10-8 3 1 4 4 3 6l-4 2c0 8-4 16-12 20z"/><path d="M8 38c-3 0-5 2-5 4h14z"/>'),
} as const;

export type SilhouetteName = keyof typeof SILHOUETTE;

/** Which silhouette suits a species. */
export function silhouetteFor(sp: SpeciesDef): SilhouetteName {
  if (sp.plant) {
    const m = sp.plant.model;
    if (m === PlantModel.Tint) return 'tint';
    if (m === PlantModel.Palm || m === PlantModel.Pandanus) return 'palm';
    if (m === PlantModel.Fern || m === PlantModel.TreeFern || m === PlantModel.Silversword) return 'fern';
    if (m === PlantModel.Grass || m === PlantModel.DuneGrass || m === PlantModel.Sedge) return 'grass';
    if (m === PlantModel.Seagrass) return 'seagrass';
    if (m === PlantModel.Coral) return 'coral';
    if (m === PlantModel.Herb || m === PlantModel.Vine || m === PlantModel.Mat || m === PlantModel.Lily || m === PlantModel.Epiphyte || m === PlantModel.Cactus)
      return 'herb';
    return 'tree';
  }
  if (sp.animal) {
    const m = sp.animal.model;
    if (m === AnimalModel.Seabird || m === AnimalModel.Frigatebird) return 'seabird';
    if (m === AnimalModel.Wader || m === AnimalModel.Shorebird) return 'wader';
    if (m === AnimalModel.SmallBird || m === AnimalModel.Duck) return 'bird';
    if (m === AnimalModel.FishShoal || m === AnimalModel.Ray || m === AnimalModel.Shark) return 'fish';
    if (m === AnimalModel.SeaTurtle || m === AnimalModel.Tortoise) return 'turtle';
    if (m === AnimalModel.Crab) return 'crab';
    if (m === AnimalModel.Lizard) return 'lizard';
    if (m === AnimalModel.Spider) return 'spider';
    if (m === AnimalModel.Snail) return 'snail';
    if (m === AnimalModel.Whale || m === AnimalModel.Dolphin) return 'whale';
    if (m === AnimalModel.Bat) return 'bat';
    if (m === AnimalModel.Seal) return 'seal';
    return 'insect';
  }
  return sp.kind === 'plant' ? 'herb' : 'bird';
}

export function silhouette(name: SilhouetteName): string {
  return SILHOUETTE[name];
}

/** The colour a found species is drawn in (its leaf or body colour), as CSS. */
export function speciesColor(sp: SpeciesDef): string {
  const c = sp.plant?.leaf ?? sp.animal?.colors[0] ?? 0x6f6a5e;
  return `#${c.toString(16).padStart(6, '0')}`;
}
