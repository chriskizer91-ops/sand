/**
 * Words: journal lines, place names, ages, firsts, and the Look sentence.
 * STUB (lead): the API is the contract; WP-D replaces the bodies and the word lists.
 */
import type { AgeId, PlaceKind, Road, SpeciesDef } from './speciesTypes';
import type { InspectInfo, JournalEntry } from '../engine/protocol';

export interface FirstDef {
  key: string;
  name: string;
}

/** Stamps on the Firsts page, in the order they are usually earned. */
export const FIRSTS: FirstDef[] = [
  { key: 'first-land', name: 'First land' },
  { key: 'first-life', name: 'First life' },
  { key: 'first-animal', name: 'First animal' },
  { key: 'first-tree', name: 'First tree' },
  { key: 'first-forest', name: 'First forest' },
];

export const AGES: { id: AgeId; name: string; line: string }[] = [
  { id: 'stone', name: 'The Age of Stone', line: 'There was only the sea. Then there was stone.' },
  { id: 'lichen', name: 'The Age of Lichen', line: 'The first life came on the wind.' },
  { id: 'green', name: 'The Age of Green', line: 'Green crept up from the cracks.' },
  { id: 'wings', name: 'The Age of Wings', line: 'Birds began to stay.' },
  { id: 'forest', name: 'The Age of Forests', line: 'The island grew a forest.' },
  { id: 'chain', name: 'The Age of the Chain', line: 'One island became many.' },
  { id: 'song', name: 'The Age of Song', line: 'The islands are full of voices.' },
];

export function ageName(age: AgeId): string {
  return AGES.find((a) => a.id === age)?.name ?? age;
}

export function firstName(key: string): string {
  return FIRSTS.find((f) => f.key === key)?.name ?? key;
}

/** Short label shown on the land when a place is recognised ("A sea cliff"). */
export function placeLabel(kind: PlaceKind): string {
  return kind.replace(/-/g, ' ');
}

/** For the Places page: name, what makes it (hint), who it brings. */
export function placeInfo(kind: PlaceKind): { name: string; makes: string; brings: string } {
  return { name: placeLabel(kind), makes: '', brings: '' };
}

export const ALL_PLACES: PlaceKind[] = [
  'lava-field', 'sea-cliff', 'sea-stack', 'beach', 'turtle-beach', 'dune', 'rock-shore', 'rock-basin', 'pond', 'salt-pond',
  'stream', 'lagoon', 'reef', 'seagrass', 'mangrove-shore', 'cloud-peak', 'rain-shadow', 'summit', 'warm-ground', 'islet', 'spit', 'sound',
];

export function roadWord(road: Road): string {
  return { wind: 'on the wind', sea: 'on the sea', raft: 'on a raft', bird: 'carried by a bird', flight: 'on its own wings', storm: 'in a storm' }[road];
}

/** The text of a journal entry (no year; the UI adds the year stamp). */
export function entryText(e: JournalEntry, species: readonly SpeciesDef[], islandName: (id: number) => string): string {
  const sp = e.species !== undefined ? species[e.species] : undefined;
  const isl = e.island !== undefined ? islandName(e.island) : 'your island';
  switch (e.kind) {
    case 'first-land':
      return 'Land broke the surface. Your island.';
    case 'arrival':
      return sp ? sp.text.arrive.replace('{place}', isl).replace('{isl}', isl) : 'Something arrived.';
    case 'visit':
      return sp ? sp.text.seen.replace('{place}', isl).replace('{isl}', isl) : 'Something visited.';
    case 'return':
      return sp ? sp.text.back.replace('{place}', isl).replace('{isl}', isl) : 'Something came back.';
    default:
      return e.kind;
  }
}

/** One plain sentence for Look on the ground. */
export function inspectText(info: InspectInfo, species: readonly SpeciesDef[]): string {
  void species;
  return info.depth > 0 ? `Sea, ${info.depth.toFixed(0)} m deep.` : `Land, ${info.height.toFixed(0)} m high.`;
}
