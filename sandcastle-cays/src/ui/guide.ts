/**
 * Guidance on screen:
 *
 * - The "next step" line (top left): the goal you're on in Ida's notebook,
 *   with a line on how to do it. Tap it (or press N) to open the notebook.
 * - Tips: a small card under it that pops up when something is first
 *   useful ("This is the ladder down into the water…"). Each shows once, then
 *   fades by itself after long enough to read it.
 * - The notebook itself: Ida's notes, chapter by chapter, with the goals
 *   ticked off and the rewards.
 */
import { ICONS } from './icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

export interface NotebookPage {
  title: string;
  /** done: finished; now: the chapter you're on; later: not reached yet. */
  state: 'done' | 'now' | 'later';
  note: string;
  goals: { text: string; how: string; done: boolean; progress?: string }[];
  reward: string;
  doneLine: string;
}

export class Guide {
  private next: HTMLButtonElement;
  private nextGoal: HTMLSpanElement;
  private nextHow: HTMLSpanElement;
  private tipEl: HTMLDivElement;
  private tipTitle: HTMLElement;
  private tipText: HTMLElement;
  private tipTimer = 0;
  private queue: { title: string; text: string }[] = [];
  private lastNext = '';
  private howUntil = 0;
  readonly panel: HTMLDivElement;
  private body: HTMLDivElement;

  constructor(
    private actions: { open(): void; close(): void; click(): void },
    private touch: boolean,
  ) {
    const root = document.getElementById('fphud') ?? document.body;
    this.next = el('button', { id: 'nextstep', class: 'hide', 'aria-label': 'Next step: open the notebook' }) as HTMLButtonElement;
    this.next.innerHTML = `<span class="lbl">${ICONS.notebook ?? ''}Next</span><span class="goal"></span><span class="how"></span>`;
    this.nextGoal = this.next.querySelector('.goal') as HTMLSpanElement;
    this.nextHow = this.next.querySelector('.how') as HTMLSpanElement;
    this.next.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.next.addEventListener('click', () => {
      actions.click();
      actions.open();
    });
    this.tipEl = el('div', { id: 'tipcard', role: 'status', 'aria-live': 'polite' });
    this.tipTitle = el('b');
    this.tipText = el('span');
    const ok = el('button', { class: 'ok' }, 'Got it');
    ok.addEventListener('pointerdown', (e) => e.stopPropagation());
    ok.addEventListener('click', () => {
      actions.click();
      this.hideTip();
    });
    this.tipEl.append(this.tipTitle, this.tipText, ok);
    // One column at the top left: the next step, and a tip under it.
    const col = el('div', { id: 'guidecol' });
    col.append(this.next, this.tipEl);
    root.append(col);

    this.panel = el('div', { class: 'panel hidden', id: 'notebook', role: 'dialog', 'aria-label': 'Ida’s notebook' });
    const h = el('h2', {}, 'Ida’s notebook');
    const close = el('button', { class: 'round', style: 'width:36px;height:36px;box-shadow:none', 'aria-label': 'Close' }, ICONS.close);
    close.addEventListener('click', () => actions.close());
    h.appendChild(close);
    this.body = el('div');
    this.panel.append(h, this.body);
    document.body.appendChild(this.panel);
  }

  get open(): boolean {
    return !this.panel.classList.contains('hidden');
  }

  show(on: boolean): void {
    this.panel.classList.toggle('hidden', !on);
  }

  /** The next-step line: the goal, and how (shown for a while when the goal is new, and whenever `showHow`). */
  setNext(goal: string | null, how: string, time: number, showHow = false): void {
    this.next.classList.toggle('hide', !goal);
    if (!goal) return;
    if (goal !== this.lastNext) {
      this.lastNext = goal;
      this.nextGoal.textContent = goal;
      this.nextHow.textContent = how;
      this.howUntil = time + 30;
      this.next.classList.remove('flash');
      void this.next.offsetWidth;
      this.next.classList.add('flash');
    }
    this.next.classList.toggle('open', showHow || time < this.howUntil);
  }

  /** Show the how-to line again for a while (after a tip, or when you seem stuck). */
  remind(time: number, seconds = 20): void {
    this.howUntil = Math.max(this.howUntil, time + seconds);
  }

  /** Pop up a tip (queued if one is showing). */
  tip(title: string, text: string): void {
    if (this.tipEl.classList.contains('show')) {
      if (!this.queue.some((q) => q.title === title)) this.queue.push({ title, text });
      return;
    }
    this.tipTitle.textContent = title;
    this.tipText.innerHTML = text;
    this.tipEl.classList.add('show');
    clearTimeout(this.tipTimer);
    // Long enough to read it twice over.
    const words = text.split(/\s+/).length;
    this.tipTimer = window.setTimeout(() => this.hideTip(), Math.max(7000, words * 420));
  }

  get tipShowing(): boolean {
    return this.tipEl.classList.contains('show');
  }

  private hideTip(): void {
    clearTimeout(this.tipTimer);
    this.tipEl.classList.remove('show');
    const n = this.queue.shift();
    if (n) window.setTimeout(() => this.tip(n.title, n.text), 450);
  }

  /** Hide the guide while building or on the start screen. */
  setVisible(on: boolean): void {
    this.next.style.visibility = on ? '' : 'hidden';
    this.tipEl.style.visibility = on ? '' : 'hidden';
  }

  render(intro: string, pages: NotebookPage[], ending: string | null): void {
    const b = this.body;
    b.innerHTML = '';
    b.appendChild(el('p', { class: 'idanote' }, intro));
    pages.forEach((p, i) => {
      const sec = el('div', { class: `chapter ${p.state}` });
      if (p.state === 'later') {
        sec.innerHTML = `<h3>Chapter ${i + 1}</h3><p class="small">The next pages are stuck together. Finish the chapter before to read on.</p>`;
        b.appendChild(sec);
        return;
      }
      sec.appendChild(el('h3', {}, `Chapter ${i + 1}: ${p.title}${p.state === 'done' ? ' <span class="tick">✓</span>' : ''}`));
      if (p.state === 'now') sec.appendChild(el('p', { class: 'idanote' }, p.note));
      const ul = el('ul', { class: 'goals' });
      for (const g of p.goals) {
        const li = el('li', { class: g.done ? 'done' : '' });
        li.innerHTML = `<span class="box">${g.done ? '✓' : ''}</span><span><b>${g.text}</b>${g.progress ? ` <span class="small">${g.progress}</span>` : ''}${!g.done && p.state === 'now' ? `<br><span class="how">${g.how}</span>` : ''}</span>`;
        ul.appendChild(li);
      }
      sec.appendChild(ul);
      sec.appendChild(el('p', { class: 'reward' }, `${p.state === 'done' ? 'Ida left you' : 'Ida will leave you'}: ${p.reward}`));
      if (p.state === 'done') sec.appendChild(el('p', { class: 'idanote small' }, p.doneLine));
      b.appendChild(sec);
    });
    if (ending) b.appendChild(el('p', { class: 'idanote' }, ending));
    b.appendChild(el('p', { class: 'small' }, this.touch ? 'Tap the “Next” line any time to open the notebook.' : 'Press N any time to open the notebook.'));
  }
}
