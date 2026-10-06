/**
 * The journal: every story, with its year, and the pacing of cards (critique-fun §5).
 *
 * The page shows an entry as a card when `headline` is set. Cards are rationed so the game
 * stays calm:
 * - at most one card every ~35 s;
 * - "couldn't stay" cards at most one per 60 s (the rest are journal-only);
 * - firsts (stamps), storms, ages and the ending always get a card;
 * - a species' first arrival always gets a card in the opening minutes; later it waits up to
 *   40 s for a gap instead of being lost among other news.
 * Times are play seconds (eco step time at the current pace), so pacing follows the game, not
 * the wall clock.
 */
import type { JournalEntry } from '../engine/protocol';

/** How much an entry wants to be a card. */
export type Want = 'always' | 'first' | 'normal' | 'visit' | 'never';

export const CARD_GAP = 35;
const NORMAL_GAP = 40;
const VISIT_GAP = 60;
const HOLD = 40;
/** Opening play time in which every first arrival is a card. */
export const OPENING = 240;

export type EntryDraft = Omit<JournalEntry, 'id' | 'headline'>;

export class JournalBook {
  entries: JournalEntry[] = [];
  /** New entries not yet taken by the engine stream. */
  pending: JournalEntry[] = [];
  private held: { e: EntryDraft; until: number }[] = [];
  nextId = 1;
  lastCard = -1e9;
  lastVisitCard = -1e9;
  /** Play time of first land (for the opening). */
  openedAt = 0;

  /** Add an entry now (play time `now`); returns it, or null while it waits for a card gap. */
  add(d: EntryDraft, want: Want, now: number): JournalEntry | null {
    const wantCard = d.first !== undefined ? 'always' : want;
    switch (wantCard) {
      case 'always':
        return this.push(d, true, now);
      case 'first':
        if (now - this.openedAt < OPENING || now - this.lastCard >= CARD_GAP) return this.push(d, true, now);
        if (this.held.length < 3) {
          this.held.push({ e: d, until: now + HOLD });
          return null;
        }
        return this.push(d, false, now);
      case 'normal':
        return this.push(d, now - this.lastCard >= NORMAL_GAP, now);
      case 'visit': {
        const card = now - this.lastVisitCard >= VISIT_GAP && now - this.lastCard >= 15;
        if (card) this.lastVisitCard = now;
        return this.push(d, card, now);
      }
      default:
        return this.push(d, false, now);
    }
  }

  /** Release held entries when a gap opens (or as journal-only when they waited too long). */
  tick(now: number): void {
    if (this.held.length === 0) return;
    const h = this.held[0];
    if (now - this.lastCard >= CARD_GAP) {
      this.held.shift();
      this.push(h.e, true, now);
    } else if (now >= h.until) {
      this.held.shift();
      this.push(h.e, false, now);
    }
  }

  /** Flush anything held (before saving). */
  flushHeld(now: number): void {
    while (this.held.length > 0) this.push((this.held.shift() as { e: EntryDraft }).e, false, now);
  }

  private push(d: EntryDraft, headline: boolean, now: number): JournalEntry {
    const e: JournalEntry = { ...d, id: this.nextId++, headline };
    if (headline) this.lastCard = now;
    this.entries.push(e);
    this.pending.push(e);
    return e;
  }

  /** Entries of a kind (checks and the director). */
  count(pred: (e: JournalEntry) => boolean): number {
    let n = 0;
    for (const e of this.entries) if (pred(e)) n++;
    return n;
  }
}
