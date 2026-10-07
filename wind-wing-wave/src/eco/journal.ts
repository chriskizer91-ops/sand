/**
 * The journal: every story, with its year, and the pacing of cards (critique-fun §5).
 *
 * The page shows an entry as a card when `headline` is set. Cards are rationed so the game
 * stays calm:
 * - at most one ordinary card every ~40 s; the rest are journal-only;
 * - "couldn't stay" cards at most one per 60 s, and only into a quiet moment (35 s after any
 *   other card): a species' first failed visit is always written, but most are journal-only;
 * - first stamps, storms, Ages and the ending always get a card, and so does a visitor coming
 *   back (the payoff the player built for); they wait their turn instead of being dropped;
 * - a species' first arrival waits up to 40 s for its card (in the opening minutes it needs
 *   only the short gap below, later a quiet moment), and is written journal-only if none comes:
 *   the next arrival card then says how many more came meanwhile (params.more);
 * - every card is at least 15 s after the one before, so even the busy opening of a new island
 *   shows at most four a minute.
 * A card that waits is written when it is shown, with the year it is shown in, so the journal
 * always reads in order. Times are play seconds (real, unpaused seconds), so the pacing is the
 * same whatever the pace of the years.
 */
import type { JournalEntry } from '../engine/protocol';

/** How much an entry wants to be a card. */
export type Want = 'always' | 'return' | 'first' | 'normal' | 'visit' | 'never';

/** Gap after any card before an ordinary story, a waiting first arrival or a return gets one. */
export const CARD_GAP = 35;
/** Gap every card keeps after the last one, even those that always come. */
export const MIN_GAP = 15;
const NORMAL_GAP = 40;
const VISIT_GAP = 60;
/** How long a first arrival and a return wait for their card (play s). */
const HOLD_FIRST = 40;
const HOLD_RETURN = 150;
/** Opening play time in which every first arrival is a card. */
export const OPENING = 240;

export type EntryDraft = Omit<JournalEntry, 'id' | 'headline'>;

/** An entry waiting for its card. */
export interface HeldEntry {
  e: EntryDraft;
  want: Want;
  /** Play time after which it is written journal-only (Infinity: it always gets its card). */
  until: number;
}

export class JournalBook {
  entries: JournalEntry[] = [];
  /** New entries not yet taken by the engine stream. */
  pending: JournalEntry[] = [];
  held: HeldEntry[] = [];
  nextId = 1;
  lastCard = -1e9;
  lastVisitCard = -1e9;
  /** Play time of first land (for the opening). */
  openedAt = 0;
  /** First arrivals written journal-only since the last arrival card ("and N more" on the next one). */
  folded = 0;

  /** Add an entry now (play time `now`, current `year`); returns it, or null while it waits for its card. */
  add(d: EntryDraft, want: Want, now: number, year: number): JournalEntry | null {
    const w: Want = d.first !== undefined ? 'always' : want;
    switch (w) {
      case 'always':
      case 'return':
      case 'first':
        if (this.held.length === 0 && now - this.lastCard >= this.gapFor(w, now)) return this.push(d, true, now, year);
        this.hold({ e: d, want: w, until: w === 'always' ? Infinity : now + (w === 'return' ? HOLD_RETURN : HOLD_FIRST) });
        return null;
      case 'normal':
        return this.push(d, now - this.lastCard >= NORMAL_GAP, now, year);
      case 'visit': {
        const card = now - this.lastVisitCard >= VISIT_GAP && now - this.lastCard >= CARD_GAP;
        if (card) this.lastVisitCard = now;
        return this.push(d, card, now, year);
      }
      default:
        return this.push(d, false, now, year);
    }
  }

  /** Show the next waiting card when its gap opens; write the ones that waited too long journal-only. */
  tick(now: number, year: number): void {
    for (let i = 0; i < this.held.length; ) {
      const h = this.held[i];
      if (now >= h.until) {
        this.held.splice(i, 1);
        if (h.want === 'first' && h.e.kind === 'arrival') this.folded++;
        this.push(h.e, false, now, year);
      } else i++;
    }
    const h = this.held[0];
    if (h && now - this.lastCard >= this.gapFor(h.want, now)) {
      this.held.shift();
      this.push(h.e, true, now, year);
    }
  }

  /** The quiet a card of this kind needs after the last one. */
  private gapFor(want: Want, now: number): number {
    if (want === 'always') return MIN_GAP;
    if (want === 'first' && now - this.openedAt < OPENING) return MIN_GAP;
    return CARD_GAP;
  }

  /** Cards wait in the order things happened, so the story never runs ahead of itself. */
  private hold(h: HeldEntry): void {
    this.held.push(h);
  }

  private push(d: EntryDraft, headline: boolean, now: number, year: number): JournalEntry {
    const e: JournalEntry = { ...d, year: Math.max(d.year, year), id: this.nextId++, headline };
    if (headline) this.lastCard = now;
    if (headline && d.kind === 'arrival' && this.folded > 0) {
      e.params = { ...d.params, more: this.folded };
      this.folded = 0;
    }
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
