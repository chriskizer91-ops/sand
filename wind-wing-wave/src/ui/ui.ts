/**
 * The interface on top of the 3D view, in a calm field-notebook style (paper, ink, rounded
 * shapes; every icon drawn in code). See docs/ARCHITECTURE.md §6.9.
 *
 *   start screen   title, "Begin" (or "Continue your sea"), a soft progress bar
 *   top corners    the journal (book, with a soft dot for news) and the menu
 *   top centre     arrival cards (cards.ts) and the first-minute coach lines (onboarding.ts)
 *   bottom         the tool tray (tray.ts)
 *   on the land    place labels and the Look bubble (labels.ts)
 *   full screen    the journal (journal.ts) and the menu sheets (menu.ts)
 *
 * Watch mode fades everything except the cards; any touch brings it back.
 * main.ts owns the game state and calls in here; this class only shows things and reports
 * what the player asked for through UiActions.
 */
import { GAME_TITLE, GAME_VERSION, type BrushSize, type ToolId } from '../config';
import type { SpeciesDef } from '../content/speciesTypes';
import { entryText, inspectText, placeLabel } from '../content/stories';
import type { InspectInfo, JournalEntry, LifeInfo, PlaceEvent } from '../engine/protocol';
import type { WorldFields } from '../render/fields';
import type { Settings } from '../storage/storage';
import { Cards } from './cards';
import { el, iconButton, text } from './dom';
import { ICONS } from './icons';
import { Journal, entryIcon, isStamp, type JournalTab } from './journal';
import { WorldPins, type Projector } from './labels';
import { Sheets } from './menu';
import { Coach, Onboarding, type OnboardingState, type OnboardingView, type SeaSteps } from './onboarding';
import { SettingsPanel } from './settings';
import { capitalise } from './text';
import { Tray } from './tray';

export interface UiActions {
  start(): void;
  selectTool(t: ToolId): void;
  cycleSize(): void;
  undo(): void;
  /** Glide the camera to a point (cards, journal rows). */
  glideTo(x: number, z: number): void;
  /** The journal or the menu opened or closed (time pauses while either is open). */
  panelsChanged(): void;
  photo(): void;
  saveFile(): void;
  loadFile(): void;
  newSea(): void;
  runChecks(): void;
  rename(island: number, name: string): void;
  home(): void;
  /** A setting changed (it is already updated in the shared Settings object). */
  settingChanged(key: keyof Settings): void;
  click(): void;
  pageTurn(): void;
}

export interface UiDeps {
  actions: UiActions;
  species: readonly SpeciesDef[];
  fields: WorldFields;
  settings: Settings;
  touch: boolean;
  project: Projector;
}

export class Ui {
  private hud: HTMLDivElement;
  private startEl: HTMLDivElement;
  private progressBar: HTMLDivElement;
  private statusEl: HTMLParagraphElement;
  private beginBtn: HTMLButtonElement;
  private journalBtn: HTMLButtonElement;
  private toastEl: HTMLDivElement;
  private toastTimer = 0;
  /** Seconds a note with a button gets again when the player stops watching (0 = none waiting). */
  private toastHeld = 0;
  private watching = false;
  readonly tray: Tray;
  readonly cards: Cards;
  readonly pins: WorldPins;
  readonly journal: Journal;
  readonly sheets: Sheets;
  readonly onboarding: Onboarding;
  private coach: Coach;
  private coachView: OnboardingView = { line: null, key: 0, glow: false, hands: false };
  private actions: UiActions;
  private species: readonly SpeciesDef[];
  private entries: JournalEntry[] = [];
  private life: LifeInfo | null = null;
  private started = false;
  private refreshIn = 0;
  private busyWords: string | null = null;

  constructor(d: UiDeps) {
    this.actions = d.actions;
    this.species = d.species;
    const a = d.actions;
    this.hud = document.getElementById('hud') as HTMLDivElement;

    // Corners: journal and menu.
    this.journalBtn = iconButton('round corner journal-btn', ICONS.journal, 'Journal (J)', () => {
      a.click();
      this.openJournal();
    });
    const menuBtn = iconButton('round corner menu-btn', ICONS.menu, 'Menu', () => {
      a.click();
      this.sheets.toggle();
    });
    this.hud.append(this.journalBtn, menuBtn);

    this.cards = new Cards(this.hud, { glideTo: (x, z) => a.glideTo(x, z), openJournal: () => this.openJournal(), click: () => a.click() });
    this.pins = new WorldPins(this.hud, d.project);
    this.onboarding = new Onboarding(new Set(d.settings.seen), (key) => {
      if (!d.settings.seen.includes(key)) d.settings.seen.push(key);
      a.settingChanged('seen');
    });
    this.coach = new Coach(this.hud, d.project, d.touch);
    this.tray = new Tray(this.hud, { selectTool: (t) => a.selectTool(t), cycleSize: () => a.cycleSize(), undo: () => a.undo(), click: () => a.click() });
    // Toasts sit above the menu sheets (saving from the menu still shows its note).
    this.toastEl = el('div', 'toast');
    this.toastEl.setAttribute('role', 'status');
    document.body.appendChild(this.toastEl);

    this.journal = new Journal(document.body, d.species, d.fields, {
      close: () => this.closeJournal(),
      glideTo: (x, z) => {
        this.closeJournal();
        a.glideTo(x, z);
      },
      flyTo: (x, z) => {
        this.closeJournal();
        a.glideTo(x, z);
      },
      rename: (id, name) => a.rename(id, name),
      saveFile: () => a.saveFile(),
      pageTurn: () => a.pageTurn(),
    });
    const settingsPanel = new SettingsPanel(
      d.settings,
      {
        changed: (key) => a.settingChanged(key),
        replayHints: () => {
          d.settings.seen.length = 0;
          this.onboarding.forgetSeen();
          a.settingChanged('seen');
        },
      },
      d.touch,
    );
    this.sheets = new Sheets(document.body, settingsPanel, {
      journal: () => this.openJournal(),
      home: () => a.home(),
      photo: () => a.photo(),
      saveFile: () => a.saveFile(),
      loadFile: () => a.loadFile(),
      newSea: () => a.newSea(),
      runChecks: () => a.runChecks(),
      click: () => a.click(),
      openChanged: () => a.panelsChanged(),
    });

    // Start screen.
    this.startEl = el('div', 'start');
    const card = el('div', 'start-card');
    card.appendChild(el('div', 'start-roads', `${ICONS.wind}${ICONS.wing}${ICONS.wave}`));
    card.appendChild(el('h1', '', 'Wind, Wing <span>&amp;</span> Wave'));
    card.appendChild(text('p', 'tag', 'Shape an island. Life will find it.'));
    const prog = el('div', 'progress', '<div></div>');
    this.progressBar = prog.firstElementChild as HTMLDivElement;
    this.statusEl = text('p', 'status', 'Filling the sea…');
    this.beginBtn = text('button', 'begin', 'Begin');
    this.beginBtn.type = 'button';
    this.beginBtn.disabled = true;
    this.beginBtn.addEventListener('click', () => a.start());
    card.append(prog, this.statusEl, this.beginBtn, text('p', 'tiny', `Made entirely in code · v${GAME_VERSION}`));
    this.startEl.appendChild(card);
    document.body.appendChild(this.startEl);
    document.title = GAME_TITLE;
  }

  // ---------- start ----------

  setProgress(done: number, total: number): void {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    this.progressBar.style.width = `${pct}%`;
    this.statusEl.textContent = pct < 100 ? `Filling the sea… ${pct}%` : 'Almost ready…';
  }

  /** The world is loaded (and shaders are ready): offer to begin. */
  setReady(resumed: boolean): void {
    this.progressBar.style.width = '100%';
    this.statusEl.textContent = resumed ? 'Your sea is just as you left it.' : 'The sea is ready.';
    this.beginBtn.textContent = resumed ? 'Continue your sea' : 'Begin';
    this.beginBtn.disabled = false;
    this.startEl.classList.add('ready');
  }

  hideStart(): void {
    this.started = true;
    this.startEl.classList.add('gone');
    setTimeout(() => (this.startEl.style.display = 'none'), 900);
    this.hud.classList.add('playing');
  }

  /** A load or new sea is replacing the world: a note that stays until it is ready. */
  setBusy(words: string | null): void {
    document.body.classList.toggle('busy', words !== null);
    if (words) this.toast(words, 60);
    else if (this.busyWords !== null && this.toastEl.textContent === this.busyWords) this.toast('', 0); // leave any newer note alone
    this.busyWords = words;
  }

  // ---------- tools ----------

  setTool(t: ToolId): void {
    this.tray.setTool(t);
  }
  setSize(s: BrushSize): void {
    this.tray.setSize(s);
  }
  setUndo(n: number): void {
    this.tray.setUndo(n);
  }
  setTrayFull(full: boolean): void {
    this.tray.setFull(full);
  }

  // ---------- the world's news ----------

  /** New journal entries (or, with `reset`, the whole journal of a loaded or new sea). */
  addJournal(entries: readonly JournalEntry[], reset: boolean, firstLand: boolean): void {
    if (reset) {
      this.entries = [...entries];
      this.cards.clear();
    } else {
      for (const e of entries) {
        this.entries.push(e);
        // While the journal is open the story is right there: no card needed.
        if (!e.headline || !this.started || this.journal.open) continue;
        this.cards.push({
          id: e.id,
          year: e.year,
          text: entryText(e, this.species, this.islandName),
          icon: entryIcon(e),
          x: e.x,
          z: e.z,
          grand: isStamp(e),
        });
        if (e.kind !== 'first-land') this.onboarding.journalStory(firstLand);
        this.journalBtn.classList.add('news');
      }
    }
    this.journal.entries = this.entries;
    this.journal.touch();
  }

  get journalEntries(): readonly JournalEntry[] {
    return this.entries;
  }

  setLife(life: LifeInfo | null): void {
    this.life = life;
    this.journal.life = life;
    this.journal.touch();
  }

  setYear(year: number, yearsPerSecond: number): void {
    if (year !== this.journal.year) this.journal.touch();
    this.journal.year = year;
    this.journal.yps = yearsPerSecond;
  }

  setCamera(x: number, z: number, yaw: number): void {
    this.journal.camX = x;
    this.journal.camZ = z;
    this.journal.camYaw = yaw;
  }

  /** A place was recognised: a soft label on the land. */
  place(ev: PlaceEvent, groundY: number): void {
    this.pins.label(capitalise(placeLabel(ev.kind)), ev.x, groundY, ev.z);
  }

  /** The answer to a Look tap. */
  look(info: InspectInfo): void {
    const names: string[] = [];
    for (const id of [info.layers.canopy, info.layers.shrub, info.layers.herb, info.layers.ground]) {
      const sp = id >= 0 ? this.species[id] : undefined;
      if (sp && !names.includes(sp.name)) names.push(sp.name);
    }
    this.pins.look(inspectText(info, this.species), names, info.x, Math.max(info.height, 0), info.z);
  }

  private islandName = (id: number): string => this.life?.islands.find((i) => i.id === id)?.name ?? 'your island';

  // ---------- panels ----------

  get journalOpen(): boolean {
    return this.journal.open;
  }
  get menuOpen(): boolean {
    return this.sheets.isOpen;
  }

  openJournal(tab?: JournalTab): void {
    if (this.journal.open) return;
    this.sheets.close();
    this.pins.closeLook();
    this.cards.clear();
    this.journalBtn.classList.remove('news');
    this.journal.setOpen(true, tab);
    this.actions.pageTurn();
    this.actions.panelsChanged();
  }

  closeJournal(): void {
    if (!this.journal.open) return;
    this.journal.setOpen(false);
    this.actions.panelsChanged();
  }

  toggleJournal(): void {
    if (this.journal.open) this.closeJournal();
    else this.openJournal();
  }

  /** Escape: close whatever is open, the top-most first. */
  escape(): void {
    if (this.sheets.isOpen) this.sheets.close();
    else if (this.journal.open) this.closeJournal();
    else this.pins.closeLook();
  }

  // ---------- messages ----------

  /**
   * A short note above the tray. A note with a button (keep a copy, save to a file) matters:
   * in watch mode it still shows, softly, and if its time runs out while the player is only
   * watching it waits for them and gets its full time again when they come back.
   */
  toast(words: string, seconds = 2.6, action?: { label: string; run: () => void }): void {
    clearTimeout(this.toastTimer);
    this.toastHeld = 0;
    this.toastEl.textContent = words;
    if (action) {
      const b = text('button', 'toast-btn', action.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        clearTimeout(this.toastTimer);
        this.toastHeld = 0;
        this.toastEl.classList.remove('show');
        action.run();
      });
      this.toastEl.appendChild(b);
    }
    this.toastEl.classList.toggle('show', !!words && seconds > 0);
    this.toastEl.classList.toggle('has-action', !!action);
    if (words && seconds > 0) this.toastTimer = window.setTimeout(() => this.toastEnd(!!action, seconds), seconds * 1000);
  }

  private toastEnd(hasAction: boolean, seconds: number): void {
    if (hasAction && this.watching) this.toastHeld = seconds;
    else this.toastEl.classList.remove('show');
  }

  /** A new Age began: a gentle note to keep a copy (on screen once, and in the journal until saved). */
  nudgeKeepCopy(): void {
    this.journal.setNudge(true);
    this.toast('A new age began. Keep a copy of your sea?', 12, { label: 'Save a copy', run: () => this.actions.saveFile() });
  }

  /** A copy was saved to a file: the nudge has done its job. */
  copySaved(): void {
    this.journal.setNudge(false);
  }

  setWatching(on: boolean): void {
    this.watching = on;
    document.body.classList.toggle('watching', on);
    if (on) this.pins.closeLook();
    else if (this.toastHeld > 0) {
      // A note with a button ran out while the player was only watching: its full time again.
      const seconds = this.toastHeld;
      this.toastHeld = 0;
      this.toastTimer = window.setTimeout(() => this.toastEnd(true, seconds), seconds * 1000);
    }
  }

  /** The sea now in play: its first-minute steps and the field-guide hints it has sharpened. */
  setSea(steps: SeaSteps, directHints: readonly unknown[]): void {
    this.onboarding.setSea(steps);
    this.journal.guide.hints.restore(directHints);
    this.journal.touch();
  }

  /** Species whose field-guide hints have reached the direct line in this sea (for the save). */
  get directHints(): number[] {
    return this.journal.guide.hints.ids;
  }

  // ---------- per frame ----------

  update(dt: number, state: OnboardingState): void {
    const panels = this.journal.open || this.sheets.isOpen;
    this.cards.update(dt, panels || !this.started);
    this.pins.update(dt);
    this.coach.update(this.onboarding.update(dt, state, this.coachView));
    this.refreshIn -= dt;
    if (this.refreshIn <= 0) {
      this.refreshIn = 0.4;
      this.journal.refresh();
    }
  }

  setGlow(x: number, z: number): void {
    this.coach.setGlow(x, z);
  }
}
