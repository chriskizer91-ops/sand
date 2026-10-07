/**
 * The menu and its sheets: settings, help, the checks page, about, and the "begin a new sea"
 * confirmation. One paper sheet slides in from the top right; sub-pages have a back arrow
 * to the menu. Time stops while it is open.
 */
import { GAME_TITLE, GAME_VERSION } from '../config';
import { ChecksPage } from './checks';
import { el, iconButton, text } from './dom';
import { ICONS } from './icons';
import { SettingsPanel } from './settings';

export type SheetName = 'menu' | 'settings' | 'help' | 'about' | 'checks' | 'confirm-new';

const TITLES: Record<SheetName, string> = {
  menu: 'Menu',
  settings: 'Settings',
  help: 'How to play',
  about: 'About',
  checks: 'Checks on this device',
  'confirm-new': 'Begin a new sea?',
};

export interface MenuActions {
  journal(): void;
  /** Glide out to see all the islands. */
  home(): void;
  photo(): void;
  saveFile(): void;
  loadFile(): void;
  newSea(): void;
  runChecks(): void;
  click(): void;
  /** The sheet opened or closed (time pauses while it is open). */
  openChanged(open: boolean): void;
}

export class Sheets {
  readonly root: HTMLDivElement;
  private sheet: HTMLDivElement;
  private title: HTMLHeadingElement;
  private back: HTMLButtonElement;
  private pages = new Map<SheetName, HTMLElement>();
  private current: SheetName | null = null;
  readonly checks: ChecksPage;
  private aboutText: HTMLParagraphElement;

  constructor(
    parent: HTMLElement,
    readonly settings: SettingsPanel,
    private actions: MenuActions,
  ) {
    this.root = el('div', 'sheet-wrap');
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close();
    });
    this.sheet = el('div', 'sheet');
    this.sheet.setAttribute('role', 'dialog');
    const head = el('div', 'sheet-head');
    this.back = iconButton('round small', ICONS.back, 'Back to the menu', () => this.open('menu'));
    this.title = text('h2', '', '');
    head.append(this.back, this.title, iconButton('round small', ICONS.close, 'Close', () => this.close()));
    this.sheet.appendChild(head);

    // The menu itself.
    const menu = el('div', 'sheet-page menu');
    const item = (icon: string, label: string, fn: () => void, cls = '') => {
      const b = iconButton(`menu-item ${cls}`, icon, label, () => {
        actions.click();
        fn();
      }, true);
      menu.appendChild(b);
    };
    item(ICONS.back, 'Back to the island', () => this.close());
    item(ICONS.journal, 'Journal', () => {
      this.close();
      actions.journal();
    });
    item(ICONS.home, 'See all your islands', () => {
      this.close();
      actions.home();
    });
    item(ICONS.camera, 'Take a photo', () => {
      this.close();
      actions.photo();
    });
    item(ICONS.settings, 'Settings', () => this.open('settings'));
    item(ICONS.save, 'Save to a file', () => actions.saveFile());
    item(ICONS.load, 'Open a saved file', () => {
      this.close();
      actions.loadFile();
    });
    item(ICONS.help, 'How to play', () => this.open('help'));
    item(ICONS.checks, 'Run the checks on this device', () => {
      this.open('checks');
      actions.runChecks();
    });
    item(ICONS.sea, 'Begin a new sea', () => this.open('confirm-new'), 'danger');
    item(ICONS.info, 'About', () => this.open('about'));
    menu.appendChild(text('p', 'small', 'Your sea saves itself every minute. A file is a copy you can keep anywhere.'));

    // Help: one card in plain words.
    const help = el('div', 'sheet-page help');
    help.innerHTML = `
      <h3>Shape the land</h3>
      <p>Pick a tool at the bottom, then touch and hold the sea or the land.</p>
      <ul>
        <li><b>Lava</b> pours molten rock. It glows, flows and cools into black rock.</li>
        <li><b>Rock</b> stays exactly where it lands: cliffs, sea stacks, pond rims.</li>
        <li><b>Sand</b> slides into soft slopes. At the water's edge it makes a beach.</li>
        <li><b>Hands</b> smooth the land. <b>Scoop</b> carves bays, ponds and channels.</li>
        <li><b>Look</b> (the eye) tells you what anything is and why it lives there.</li>
        <li><b>Undo</b> takes back your last changes, and brings back any life they buried.</li>
      </ul>
      <h3>Move around, like a maps app</h3>
      <p class="note">New since Sandcastle Cays: two fingers now slide the map instead of swinging around it.</p>
      <ul>
        <li><b>Phone:</b> one finger uses the tool. Two fingers drag to move, pinch to zoom, twist to turn. A quick two-finger tap flies there.</li>
        <li><b>Laptop:</b> click and drag uses the tool. Two-finger swipe moves, pinch or the mouse wheel zooms, right-drag turns and tilts, right-click flies there.</li>
        <li><b>Keys:</b> W A S D or arrows move, Q E turn, R F tilt, 1 to 6 pick tools, [ ] change size, Ctrl+Z undo, J journal, hold Space to look, H shows all your islands, P takes a photo.</li>
      </ul>
      <h3>Watch</h3>
      <p>Leave it be for a minute and the buttons fade. The view drifts to where life is happening. Touch to come back.</p>
      <h3>Life</h3>
      <p>You never place life. Wind, sea and birds bring it. The shape you make decides who stays, and your journal says who came, who stayed, and why.</p>`;

    // About.
    const about = el('div', 'sheet-page about');
    about.appendChild(text('h3', '', GAME_TITLE));
    this.aboutText = text('p', '', `Version ${GAME_VERSION}`);
    about.appendChild(this.aboutText);
    about.appendChild(text('p', '', 'Everything you see and hear is made in code: no pictures, no recordings.'));
    about.appendChild(text('p', 'small', '"Wind, Wing & Wave" is a working name.'));

    // Begin a new sea.
    const confirmNew = el('div', 'sheet-page confirm');
    confirmNew.appendChild(text('p', '', 'Your islands, their life and their story will give way to open water. This can’t be undone.'));
    confirmNew.appendChild(iconButton('wide-btn', ICONS.save, 'Save a copy first', () => actions.saveFile(), true));
    confirmNew.appendChild(
      iconButton(
        'wide-btn danger',
        ICONS.sea,
        'Begin a new sea',
        () => {
          this.close();
          actions.newSea();
        },
        true,
      ),
    );
    confirmNew.appendChild(iconButton('wide-btn', ICONS.back, 'Keep this sea', () => this.open('menu'), true));

    this.checks = new ChecksPage(() => actions.runChecks());
    this.pages.set('menu', menu);
    this.pages.set('settings', settings.root);
    this.pages.set('help', help);
    this.pages.set('about', about);
    this.pages.set('checks', this.checks.root);
    this.pages.set('confirm-new', confirmNew);
    for (const p of this.pages.values()) this.sheet.appendChild(p);
    this.root.appendChild(this.sheet);
    parent.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.current !== null;
  }
  get page(): SheetName | null {
    return this.current;
  }

  setAbout(line: string): void {
    this.aboutText.textContent = line;
  }

  open(name: SheetName): void {
    const was = this.current;
    this.current = name;
    for (const [k, p] of this.pages) p.classList.toggle('on', k === name);
    this.title.textContent = TITLES[name];
    this.back.style.visibility = name === 'menu' ? 'hidden' : '';
    if (name === 'settings') this.settings.refresh();
    this.root.classList.add('open');
    this.sheet.scrollTop = 0;
    if (!was) this.actions.openChanged(true);
  }

  close(): void {
    if (!this.current) return;
    this.current = null;
    this.root.classList.remove('open');
    this.actions.openChanged(false);
  }

  toggle(): void {
    if (this.current) this.close();
    else this.open('menu');
  }
}
