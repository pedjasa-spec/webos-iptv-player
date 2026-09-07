import { html, raw, type Safe } from '../utils/dom';
import { VirtualList, type VirtualListOptions } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';

export interface SidebarEntry {
  id: string;
  label: string;
  count?: number;
  icon?: Safe;
  hidden?: boolean;
  grabbed?: boolean;
  renaming?: boolean;
  /** True for a real (non-builtin/non-pinned) row: eligible to be favorited. */
  favoritable?: boolean;
  /** Set by `applyFavoriteOrder`; drives the visible star marker. */
  favorite?: boolean;
  /** Stable identity for favorite tracking when `id` can change (e.g. a
   *  renamed Live group); defaults to `id` when the caller has no such need. */
  favoriteKey?: string;
}

/**
 * Hoists favorited rows above the rest, in the order the user favorited them;
 * non-favoritable rows (builtin/pinned entries a caller always puts first,
 * e.g. Favorites/Recently Watched or Continue Watching/Watchlist) keep their
 * given position, and unfavorited rows keep the server/discovery order the
 * caller handed in. Shared so Live, Movies, and Series sort identically —
 * each caller supplies its own persisted `favoriteIds`.
 */
export function applyFavoriteOrder<T extends SidebarEntry>(
  entries: T[],
  favoriteIds: string[],
): T[] {
  const rank = new Map(favoriteIds.map((id, index) => [id, index]));
  const pinned: T[] = [];
  const favorited: T[] = [];
  const rest: T[] = [];
  for (const entry of entries) {
    if (!entry.favoritable) { pinned.push(entry); continue; }
    const key = entry.favoriteKey ?? entry.id;
    if (rank.has(key)) favorited.push({ ...entry, favorite: true });
    else rest.push(entry);
  }
  favorited.sort((a, b) =>
    rank.get(a.favoriteKey ?? a.id)! - rank.get(b.favoriteKey ?? b.id)!);
  return [...pinned, ...favorited, ...rest];
}

/**
 * The virtualized, focusable vertical list used for the left-edge group/category
 * picker. Owns row virtualization, its row template, and the scroll-offset
 * bookkeeping; the up/down focus math and cross-container hand-off stay with
 * the owning view's own `SpatialNav`, since selection semantics (filter a list
 * vs. lazily load a category) differ per caller.
 */
export class SidebarList {
  private readonly virtualizer: VirtualList;
  private readonly scrollGuard = new VirtualScrollGuard();

  constructor(options: VirtualListOptions) {
    this.virtualizer = new VirtualList(options);
  }

  get scrollOffset(): number {
    return this.virtualizer.scrollOffset;
  }

  setScrollOffset(offset: number): void {
    this.virtualizer.setScrollOffset(offset);
  }

  /** Capture the DOM's current scrollTop before building the next render. */
  captureScrollOffset(listEl: HTMLElement | null): void {
    if (listEl) this.virtualizer.setScrollOffset(listEl.scrollTop);
  }

  /** After morph: re-assert the intended scrollTop (morph can reset it). */
  applyScrollOffset(listEl: HTMLElement | null): void {
    if (listEl) this.scrollGuard.syncOffset(listEl, 'vertical', this.virtualizer.scrollOffset);
  }

  /** Feed a native `scroll` event; null means it's an echo of our own syncOffset. */
  readUserScrollOffset(listEl: HTMLElement): number | null {
    return this.scrollGuard.readUserOffset(listEl, 'vertical');
  }

  ensureVisible(position: number, viewportHeight: number): boolean {
    return this.virtualizer.ensureVisible(position, viewportHeight);
  }

  centerOn(position: number, viewportHeight: number): void {
    this.virtualizer.centerOn(position, viewportHeight);
  }

  /**
   * Next focus position after an up/down nudge, or null at the boundary (the
   * caller then falls back to geometric `nav.move`). Ensures the target row is
   * rendered before the caller queries it from the DOM.
   */
  moveFocusIndex(
    delta: number,
    entryCount: number,
    currentPosition: number,
    viewportHeight: number,
  ): number | null {
    const next = currentPosition + delta;
    if (next < 0 || next >= entryCount) return null;
    this.virtualizer.ensureVisible(next, viewportHeight);
    return next;
  }

  /** Position of `id` within `entries`, or -1 when absent. */
  positionOf(entries: SidebarEntry[], id: string): number {
    return entries.findIndex(entry => entry.id === id);
  }

  render(entries: SidebarEntry[], activeId: string, viewportHeight: number): Safe {
    const range = this.virtualizer.getRange(entries.length, viewportHeight);
    return html`
      <div class="group-list">
        <div class="group-list-spacer"
             style="height:${this.virtualizer.getTotalSize(entries.length)}px">
          ${entries.slice(range.start, range.end).map((entry, offset) => {
            const position = range.start + offset;
            return this.renderRow(entry, position, entry.id === activeId);
          })}
        </div>
      </div>
    `;
  }

  private renderRow(entry: SidebarEntry, position: number, active: boolean): Safe {
    return html`
      <div class="group-item ${active ? 'active' : ''} ${entry.hidden ? 'hidden-entry' : ''} ${
        entry.grabbed ? 'grabbed' : ''}"
           data-key="g:${entry.id}"
           data-focusable data-group="${entry.id}" data-group-position="${position}"
           data-favoritable="${entry.favoritable ? 'true' : ''}"
           data-favorite-key="${entry.favoriteKey ?? entry.id}"
           style="top:${this.virtualizer.getItemOffset(position)}px">
        <span class="group-icon">${entry.icon ?? ''}</span>
        ${entry.renaming
          ? html`<input class="edit-text-input" type="text" value="${entry.label}">`
          : html`<span class="group-name">${entry.label}</span>`}
        ${entry.favorite ? html`<span class="group-favorite-star" aria-hidden="true">${raw('&#9733;')}</span>` : ''}
        ${entry.count !== undefined ? html`<span class="group-count">${entry.count}</span>` : ''}
      </div>
    `;
  }
}
