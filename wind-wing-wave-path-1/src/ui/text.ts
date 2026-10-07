/**
 * Small words used across the interface: tool names, size names, first-use lines, and
 * year formatting. Story text (journal lines, places, the Look sentence) lives in
 * content/stories.ts; this file is only the interface's own voice.
 */
import type { BrushSize, ToolId } from '../config';

export const TOOL_ORDER: readonly ToolId[] = ['lava', 'rock', 'sand', 'hands', 'scoop', 'look'];

export const TOOL_NAMES: Record<ToolId, string> = {
  lava: 'Lava',
  rock: 'Rock',
  sand: 'Sand',
  hands: 'Hands',
  scoop: 'Scoop',
  look: 'Look',
};

/** One short line the first time each tool is chosen. */
export const TOOL_LINES: Record<ToolId, string> = {
  lava: 'Hold to pour lava. It cools into new rock.',
  rock: 'Rock stays where it lands. Hold for a cliff, drag for a wall.',
  sand: 'Sand slides into soft slopes. Pour it at the water for a beach.',
  hands: 'Hands smooth the land. Slow and gentle on rock.',
  scoop: 'Scoop carves bays, ponds and channels.',
  look: 'Tap anything to learn what it is.',
};

export const SIZE_NAMES: readonly [string, string, string] = ['Pinch', 'Handful', 'Armful'];

/** "1,204" */
export function yearNumber(y: number): string {
  return Math.max(0, Math.floor(y)).toLocaleString('en-US');
}

/** "Year 1,204" */
export function formatYear(y: number): string {
  return `Year ${yearNumber(y)}`;
}

export function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
