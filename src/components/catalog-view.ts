import type { Action, PlaylistEntry, ResumeEntry, ResumeKind, VodPlayback } from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { attrSelectorEscape, html, raw, Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import { t } from '../i18n';
import { VirtualGrid } from '../utils/virtual-grid';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { SidebarList, applyFavoriteOrder, type SidebarEntry } from './sidebar-list';
import { groupIcon } from './group-icon';
import { createLogger } from '../utils/logger';

const log = createLogger('Catalog');

const CATALOG_GRID_COLUMN_STRIDE = 244;
const CATALOG_GRID_ROW_STRIDE = 395;
const CATALOG_GRID_OVERSCAN_ROWS = 2;
const CATALOG_GRID_VIEWPORT_WIDTH = 1760;
const CATALOG_GRID_VIEWPORT_HEIGHT = 900;
const GRID_SNAP_DELAY_MS = 95;
// Row stride mirrors channel-list.css's .group-item (60px + 4px vertical margin
// each side) — the sidebar reuses that CSS wholesale, so the geometry must match.
const SIDEBAR_ROW_STRIDE = 68;
const SIDEBAR_OVERSCAN = 8;
const SIDEBAR_VIEWPORT_FALLBACK = 900;

// Pinned sidebar entries always shown above the real Xtream categories.
const CONTINUE_ID = '__continue__';
const WATCHLIST_ID = '__watchlist__';

export interface CatalogHandlers {
  onRevealTabBar: () => void;
  onBack: () => void;
  onPlayVod: (req: Omit<VodPlayback, 'onBack'>) => void;
}

type Mode = 'grid' | 'detail';

// Shared sidebar+grid machinery for the Xtream catalog sections (Movies,
// Series): a left category sidebar (reusing the same SidebarList component and
// row markup as the Live channel list) next to a poster grid, and a detail
// screen, driven by one SpatialNav across both modes. Continue Watching and
// Watchlist are pinned sidebar entries backed by pre-rendered tiles rather than
// a lazily-loaded category. Up at the top row hands off to the tab bar; Back
// from the grid leaves the section; Back from detail returns to the grid.
// Subclasses supply the catalog loaders, item accessors, and the detail
// rendering / playback specifics.
export abstract class CatalogView<C extends { id: string; name: string }, I> {
  protected nav: SpatialNav;
  protected account: PlaylistEntry | null = null;
  protected mode: Mode = 'grid';
  protected categories: C[] = [];
  protected resume: ResumeEntry[] = [];
  protected itemsByCategory: Record<string, I[]> = {};
  protected deepLinkBack: (() => void) | null = null;
  private activeEntryId = '';
  private sidebarEntries: SidebarEntry[] = [];
  private continueTilesCache: Safe[] = [];
  private watchlistTilesCache: Safe[] = [];
  private gridFocusIndex = 0;
  private readonly gridVirtualizer = new VirtualGrid({
    columnStride: CATALOG_GRID_COLUMN_STRIDE,
    rowStride: CATALOG_GRID_ROW_STRIDE,
    overscanRows: CATALOG_GRID_OVERSCAN_ROWS,
    fallbackViewportWidth: CATALOG_GRID_VIEWPORT_WIDTH,
    fallbackViewportHeight: CATALOG_GRID_VIEWPORT_HEIGHT,
  });
  private gridScrollFrame: number | null = null;
  private readonly sidebar = new SidebarList({
    itemSize: SIDEBAR_ROW_STRIDE,
    overscan: SIDEBAR_OVERSCAN,
    fallbackViewportSize: SIDEBAR_VIEWPORT_FALLBACK,
  });
  private sidebarScrollFrame: number | null = null;
  protected readonly scrollGuard = new VirtualScrollGuard();
  private gridSnapTimer: ReturnType<typeof setTimeout> | null = null;
  private requestController: AbortController | null = null;

  constructor(protected container: HTMLElement, protected handlers: CatalogHandlers) {
    this.nav = new SpatialNav(container, (el) => this.onFocusChanged(el));
    this.container.addEventListener('mouseleave', () => this.nav.clearHighlight());
    this.container.addEventListener('scroll', (event: Event) => {
      const target = event.target as HTMLElement;
      if (this.handleExtraScroll(target)) return;
      if (this.mode === 'grid' && target.classList.contains('group-list')) {
        const offset = this.sidebar.readUserScrollOffset(target);
        if (offset === null) return;
        this.sidebar.setScrollOffset(offset);
        if (this.sidebarScrollFrame === null) {
          this.sidebarScrollFrame = requestAnimationFrame(() => {
            this.sidebarScrollFrame = null;
            if (this.mode === 'grid') this.renderGrid(false);
          });
        }
        return;
      }
      if (this.mode !== 'grid' || !target.classList.contains('catalog-main')) return;
      const scrollTop = this.scrollGuard.readUserOffset(target, 'vertical');
      if (scrollTop === null) return;
      const track = this.container.querySelector<HTMLElement>('.catalog-grid-track');
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, scrollTop - this.gridTrackStart(target, track)),
      );
      this.scheduleGridSnap(target);
      if (this.gridScrollFrame !== null) return;
      this.gridScrollFrame = requestAnimationFrame(() => {
        this.gridScrollFrame = null;
        if (this.mode === 'grid') this.renderGrid(false);
      });
    }, true);
  }

  // --- subclass configuration ---
  protected abstract readonly kicker: string;             // grid-title fallback, e.g. 'Movies'
  protected abstract readonly catalogSection: 'movies' | 'series'; // favorite-category storage scope
  protected abstract readonly resumeKind: ResumeKind;     // which resume entries this section owns
  protected abstract readonly emptyMessage: string;       // no catalog on the account
  protected abstract readonly gridEmptyMessage: string;   // empty category grid
  protected abstract loadCategories(
    account: PlaylistEntry,
    signal: AbortSignal,
  ): Promise<C[]>;
  protected abstract loadItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<I[]>;
  protected abstract itemId(item: I): string;
  protected abstract itemName(item: I): string;
  protected abstract itemPoster(item: I): string;
  protected abstract itemCategoryId(item: I): string;
  protected abstract openDetail(item: I): Promise<void>;
  protected abstract renderDetail(restoreFocus?: boolean): void;
  protected abstract clearDetail(): void;                 // drop detail state on deep-link back
  // Section-specific selects (play/resume/season/episode). Returns true if handled.
  protected abstract selectExtra(el: HTMLElement): boolean;
  protected moveExtraFocus(_action: Action): boolean { return false; }
  protected handleExtraScroll(_target: HTMLElement): boolean { return false; }
  protected onRequestSessionReset(): void {}
  // Pre-rendered tiles for the pinned Continue Watching / Watchlist sidebar
  // entries — already-built markup (not `I` items), since a resumed episode or
  // a watchlist entry can carry section-specific attributes (e.g. Series routes
  // a Continue tile straight to episode playback, bypassing series detail).
  protected abstract continueTiles(): Safe[];
  protected abstract watchlistTiles(): Safe[];
  // A tile id that isn't in a loaded category (Continue/Watchlist); default none.
  protected fallbackItem(_id: string): I | null { return null; }

  setAccount(account: PlaylistEntry): void {
    if (this.account?.id !== account.id) {
      this.requestController?.abort();
      this.onRequestSessionReset();
    }
    this.account = account;
  }

  protected get requestSignal(): AbortSignal | null {
    return this.requestController?.signal ?? null;
  }

  protected requestFailed(context: string, err: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) return false;
    log.error(
      `${context} failed`,
      'event=xtream.view.load.failed',
      `operation=${context.toLowerCase().replace(/\s+/g, '_')}`,
      err,
    );
    return true;
  }

  private beginRequests(): AbortSignal {
    this.requestController?.abort();
    this.onRequestSessionReset();
    this.requestController = new AbortController();
    return this.requestController.signal;
  }

  refreshPlaybackState(): void {
    if (this.mode === 'detail') this.renderDetail();
  }

  deactivate(): void {
    this.requestController?.abort();
    this.requestController = null;
    this.onRequestSessionReset();
  }

  async open(account: PlaylistEntry): Promise<void> {
    const signal = this.beginRequests();
    this.account = account;
    this.deepLinkBack = null;
    this.mode = 'grid';
    this.categories = [];
    this.itemsByCategory = {};
    this.activeEntryId = '';
    this.gridFocusIndex = 0;
    this.sidebar.setScrollOffset(0);
    this.gridVirtualizer.setScrollOffset(0);
    this.resume = StorageService.getResumeList(account.id).filter((e) => e.kind === this.resumeKind);
    this.renderLoading();
    try {
      this.categories = await this.loadCategories(account, signal);
      if (signal.aborted || this.account?.id !== account.id) return;
      this.refreshPseudoTiles();
      this.activeEntryId = this.resume.length
        ? CONTINUE_ID
        : this.categories[0]?.id ?? (this.watchlistTilesCache.length ? WATCHLIST_ID : '');
      if (this.activeEntryId && this.activeEntryId !== CONTINUE_ID && this.activeEntryId !== WATCHLIST_ID) {
        this.itemsByCategory[this.activeEntryId] = await this.loadItems(account, this.activeEntryId, signal);
        if (signal.aborted || this.account?.id !== account.id) return;
      }
      this.renderGrid();
    } catch (err) {
      if (signal.aborted) return;
      log.error(
        'Catalog browse load failed',
        'event=xtream.view.load.failed',
        'operation=browse',
        err,
      );
      if (this.account?.id === account.id) this.renderGrid();
    }
  }

  // Deep-link entry (from Search): open this item's detail directly. Back returns
  // to the caller via onDetailBack (no grid is loaded underneath).
  async openItem(account: PlaylistEntry, item: I, onDetailBack: () => void): Promise<void> {
    this.beginRequests();
    this.account = account;
    this.deepLinkBack = onDetailBack;
    await this.openDetail(item);
  }

  handleAction(action: Action): void {
    if (this.moveExtraFocus(action)) return;
    if (this.mode === 'grid') {
      switch (action) {
        case 'up':
          if (this.moveVirtualFocus(-1)) return;
          if (!this.nav.move('up')) this.handlers.onRevealTabBar();
          return;
        case 'down':
          if (this.moveVirtualFocus(1)) return;
          this.nav.move('down');
          return;
        case 'left':
          if (this.focusedInGrid()) this.handleGridHorizontal('left');
          else this.nav.move('left');
          return;
        case 'right':
          if (this.focusedInGrid()) this.handleGridHorizontal('right');
          else this.nav.move('right');
          return;
        case 'select':
          this.onSelect();
          return;
        case 'green':
          this.toggleFocusedCategoryFavorite();
          return;
        case 'back':
          this.onBack();
          return;
        default:
          return;
      }
    }
    switch (action) {
      case 'up':
        if (!this.nav.move('up')) this.handlers.onRevealTabBar();
        return;
      case 'down':
      case 'left':
      case 'right':
        this.nav.move(action);
        return;
      case 'select':
        this.onSelect();
        return;
      case 'back':
        this.onBack();
        return;
      default:
        return;
    }
  }

  private onBack(): void {
    if (this.mode === 'detail') {
      if (this.deepLinkBack) { const back = this.deepLinkBack; this.deepLinkBack = null; this.clearDetail(); back(); return; }
      this.clearDetail();
      this.renderGrid();
      return;
    }
    this.handlers.onBack();
  }

  private onSelect(): void {
    const el = this.nav.focused;
    if (!el || !this.account) return;
    if (el.dataset.group !== undefined) {
      void this.selectEntry(el.dataset.group);
      return;
    }
    if (this.selectExtra(el)) return;
    if (el.dataset.itemId !== undefined) {
      const item = this.findItem(el.dataset.categoryId ?? '', el.dataset.itemId);
      if (item) void this.openDetail(item);
    }
  }

  private toggleFocusedCategoryFavorite(): void {
    const focused = this.nav.focused;
    if (!this.account || focused?.dataset.favoritable !== 'true' || focused.dataset.favoriteKey === undefined) {
      return;
    }
    StorageService.toggleCatalogFavorite(this.account.id, this.catalogSection, focused.dataset.favoriteKey);
    this.renderGrid();
  }

  private focusedInGrid(): boolean {
    return !!this.nav.focused?.closest('[data-grid-index]');
  }

  // Keep gridFocusIndex in sync with whatever grid cell ends up focused (click,
  // hover, or a nav.move landing inside the grid).
  private onFocusChanged(el: HTMLElement | null): void {
    const gridCell = el?.closest<HTMLElement>('[data-grid-index]');
    if (gridCell?.dataset.gridIndex !== undefined) {
      this.gridFocusIndex = parseInt(gridCell.dataset.gridIndex, 10);
    }
  }

  protected findItem(categoryId: string, id: string): I | null {
    const inCat = this.itemsByCategory[categoryId] ?? [];
    return inCat.find((x) => this.itemId(x) === id) ?? this.fallbackItem(id);
  }

  // Switch the sidebar selection: pseudo entries are already in memory; a real
  // category lazily loads its items the first time it's opened, exactly as the
  // former per-category grid drill-in did.
  private async selectEntry(id: string): Promise<void> {
    if (id === this.activeEntryId) return;
    this.activeEntryId = id;
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    if (id !== CONTINUE_ID && id !== WATCHLIST_ID && !this.itemsByCategory[id]) {
      const account = this.account;
      const signal = this.requestSignal;
      if (!account || !signal || signal.aborted) return;
      this.renderLoading();
      try {
        this.itemsByCategory[id] = await this.loadItems(account, id, signal);
      } catch (err) {
        if (signal.aborted) return;
        log.error(
          'Catalog category load failed',
          'event=xtream.view.load.failed',
          'operation=category',
          err,
        );
        this.itemsByCategory[id] = [];
      }
      if (signal.aborted || this.account?.id !== account.id) return;
    }
    this.renderGrid();
  }

  // Deterministically focuses the sidebar row for the category currently shown
  // in the grid — not the geometrically nearest row, nor whatever the sidebar
  // last remembered — since the two panes scroll independently and neither
  // proxy reliably points at the active category. Ensures the row is rendered
  // (it's virtualized) before it's queried from the DOM.
  private focusActiveSidebarEntry(): void {
    const position = this.sidebar.positionOf(this.sidebarEntries, this.activeEntryId);
    if (position < 0) return;
    const list = this.container.querySelector<HTMLElement>('.group-list');
    this.sidebar.ensureVisible(position, list?.clientHeight || SIDEBAR_VIEWPORT_FALLBACK);
    this.renderGrid(false);
    const target = this.container.querySelector<HTMLElement>(`[data-group-position="${position}"]`);
    if (target) this.nav.focus(target);
  }

  private handleGridHorizontal(direction: 'left' | 'right'): void {
    const itemCount = this.currentItemCount();
    if (!itemCount) return;
    const track = this.container.querySelector<HTMLElement>('.catalog-grid-track');
    const viewportWidth = track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
    const next = this.gridVirtualizer.getAdjacentIndex(this.gridFocusIndex, direction, itemCount, viewportWidth);
    if (next !== this.gridFocusIndex) {
      this.nav.move(direction);
      return;
    }
    if (direction === 'left') this.focusActiveSidebarEntry();
  }

  // Up/down within whichever pane holds focus: the sidebar's row list, or the
  // grid's rows. Both are virtualized, so a boundary (top/bottom) returns false
  // and the caller falls back to geometric `nav.move`.
  private moveVirtualFocus(delta: -1 | 1): boolean {
    const focused = this.nav.focused;
    const rawGroupPosition = focused?.dataset.groupPosition;
    if (rawGroupPosition !== undefined) {
      const list = this.container.querySelector<HTMLElement>('.group-list');
      const next = this.sidebar.moveFocusIndex(
        delta,
        this.sidebarEntries.length,
        parseInt(rawGroupPosition, 10),
        list?.clientHeight || SIDEBAR_VIEWPORT_FALLBACK,
      );
      if (next === null) return false;
      this.renderGrid(false);
      const target = this.container.querySelector<HTMLElement>(`[data-group-position="${next}"]`);
      if (target) this.nav.focus(target);
      return true;
    }
    if (!this.focusedInGrid()) return false;
    const itemCount = this.currentItemCount();
    if (!itemCount) return false;
    const track = this.container.querySelector<HTMLElement>('.catalog-grid-track');
    const view = this.container.querySelector<HTMLElement>('.catalog-main');
    const viewportWidth = track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
    const direction = delta < 0 ? 'up' : 'down';
    const next = this.gridVirtualizer.getAdjacentIndex(this.gridFocusIndex, direction, itemCount, viewportWidth);
    if (next === this.gridFocusIndex) return false;
    this.gridFocusIndex = next;
    this.gridVirtualizer.ensureVisible(next, viewportWidth, view?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT);
    this.renderGrid(false);
    const target = this.container.querySelector<HTMLElement>(`[data-grid-index="${next}"] [data-focusable]`);
    if (target) this.nav.focus(target);
    return true;
  }

  protected posterCell(name: string, poster: string): Safe {
    return poster
      ? html`<img class="catalog-poster" src="${poster}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : html`<div class="catalog-poster catalog-poster-empty">${name.charAt(0)}</div>`;
  }

  protected tile(item: I): Safe {
    const id = this.itemId(item);
    const cat = this.itemCategoryId(item);
    return html`
      <div class="catalog-tile" data-focusable data-key="i:${cat}:${id}"
           data-item-id="${id}" data-category-id="${cat}">
        <div class="catalog-poster-wrap">${this.posterCell(this.itemName(item), this.itemPoster(item))}</div>
        <div class="catalog-tile-name">${this.itemName(item)}</div>
      </div>
    `;
  }

  private renderLoading(): void {
    morph(this.container, html`
      <div class="catalog-view catalog-loading">
        <p class="catalog-hint">${t('common.loading')}</p>
      </div>
    `);
  }

  private refreshPseudoTiles(): void {
    this.continueTilesCache = this.continueTiles();
    this.watchlistTilesCache = this.watchlistTiles();
  }

  private buildSidebarEntries(): SidebarEntry[] {
    const entries: SidebarEntry[] = [
      {
        id: CONTINUE_ID,
        label: t('catalog.continueWatching'),
        count: this.continueTilesCache.length,
        icon: raw(groupIcon(t('catalog.continueWatching'), 'recently-watched')),
      },
      {
        id: WATCHLIST_ID,
        label: t('common.watchlist'),
        count: this.watchlistTilesCache.length,
        icon: raw(groupIcon(t('common.watchlist'), 'favorites')),
      },
      ...this.categories.map((c) => ({
        id: c.id,
        label: c.name,
        icon: raw(groupIcon(c.name)),
        favoritable: true,
      })),
    ];
    const favoriteIds = this.account
      ? StorageService.getCatalogFavorites(this.account.id, this.catalogSection)
      : [];
    return applyFavoriteOrder(entries, favoriteIds);
  }

  private currentTitle(): string {
    if (this.activeEntryId === CONTINUE_ID) return t('catalog.continueWatching');
    if (this.activeEntryId === WATCHLIST_ID) return t('common.watchlist');
    return this.categories.find((c) => c.id === this.activeEntryId)?.name ?? this.kicker;
  }

  private currentItemCount(): number {
    if (this.activeEntryId === CONTINUE_ID) return this.continueTilesCache.length;
    if (this.activeEntryId === WATCHLIST_ID) return this.watchlistTilesCache.length;
    return (this.itemsByCategory[this.activeEntryId] ?? []).length;
  }

  private currentTileAt(index: number): Safe | null {
    if (this.activeEntryId === CONTINUE_ID) return this.continueTilesCache[index] ?? null;
    if (this.activeEntryId === WATCHLIST_ID) return this.watchlistTilesCache[index] ?? null;
    const item = (this.itemsByCategory[this.activeEntryId] ?? [])[index];
    return item ? this.tile(item) : null;
  }

  protected renderGrid(restoreFocus = true): void {
    this.mode = 'grid';
    // Captured before morph so a favorite toggle (which can reorder the
    // sidebar) or a category select still finds the same row afterward — the
    // id is stable even though its position isn't.
    const wantedKey = this.nav.focused?.getAttribute('data-key') ?? null;
    if (this.account) {
      this.resume = StorageService.getResumeList(this.account.id).filter((e) => e.kind === this.resumeKind);
    }
    this.refreshPseudoTiles();
    const hasContent = this.categories.length > 0
      || this.continueTilesCache.length > 0
      || this.watchlistTilesCache.length > 0;
    if (!hasContent) {
      morph(this.container, html`
        <div class="catalog-view catalog-empty">
          <p class="catalog-hint">${this.emptyMessage}</p>
        </div>
      `);
      this.nav.clearDetachedFocus();
      return;
    }

    this.sidebarEntries = this.buildSidebarEntries();
    if (!this.sidebarEntries.some((entry) => entry.id === this.activeEntryId)) {
      this.activeEntryId = this.sidebarEntries[0].id;
    }
    const itemCount = this.currentItemCount();
    this.gridFocusIndex = Math.max(0, Math.min(this.gridFocusIndex, itemCount - 1));

    const previousSidebarList = this.container.querySelector<HTMLElement>('.group-list');
    this.sidebar.captureScrollOffset(previousSidebarList);
    const sidebarViewportHeight = previousSidebarList?.clientHeight || SIDEBAR_VIEWPORT_FALLBACK;
    const wantedSidebarPosition = wantedKey?.indexOf('g:') === 0
      ? this.sidebar.positionOf(this.sidebarEntries, wantedKey.slice(2))
      : -1;
    if (restoreFocus && wantedSidebarPosition >= 0) {
      this.sidebar.ensureVisible(wantedSidebarPosition, sidebarViewportHeight);
    }

    const previousView = this.container.querySelector<HTMLElement>('.catalog-main');
    const previousTrack = this.container.querySelector<HTMLElement>('.catalog-grid-track');
    if (restoreFocus && previousView) {
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, previousView.scrollTop - this.gridTrackStart(previousView, previousTrack)),
      );
    }
    const viewportWidth = previousTrack?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
    const viewportHeight = previousView?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
    if (restoreFocus && itemCount) {
      this.gridVirtualizer.ensureVisible(this.gridFocusIndex, viewportWidth, viewportHeight);
    }
    const range = this.gridVirtualizer.getRange(itemCount, viewportWidth, viewportHeight);
    const cellIndices: number[] = [];
    for (let i = range.start; i < range.end; i++) cellIndices.push(i);

    morph(this.container, html`
      <div class="catalog-view catalog-grid">
        <div class="sidebar" data-nav-container>
          ${this.sidebar.render(this.sidebarEntries, this.activeEntryId, sidebarViewportHeight)}
        </div>
        <div class="catalog-main" data-nav-container data-nav-enter="last-focused">
          <h1 class="catalog-grid-title">${this.currentTitle()}</h1>
          ${itemCount === 0
            ? html`<p class="catalog-hint">${this.gridEmptyMessage}</p>`
            : html`
              <div class="catalog-grid-track"
                   style="height:${this.gridVirtualizer.getTotalSize(itemCount, viewportWidth)}px">
                ${cellIndices.map((index) => {
                  const tile = this.currentTileAt(index);
                  if (!tile) return '';
                  const position = this.gridVirtualizer.getItemPosition(index, range.columns);
                  return html`
                    <div class="catalog-grid-cell"
                         data-key="grid:${index}"
                         data-grid-index="${index}"
                         style="left:${position.left}px;top:${position.top}px">
                      ${tile}
                    </div>
                  `;
                })}
              </div>
            `}
        </div>
      </div>
    `);
    this.sidebar.applyScrollOffset(this.container.querySelector<HTMLElement>('.group-list'));
    const view = this.container.querySelector<HTMLElement>('.catalog-main');
    const track = this.container.querySelector<HTMLElement>('.catalog-grid-track');
    const viewOffset = this.gridVirtualizer.scrollOffset === 0
      ? 0
      : this.gridVirtualizer.scrollOffset + this.gridTrackStart(view, track);
    if (view) this.scrollGuard.syncOffset(view, 'vertical', viewOffset);
    if (restoreFocus) {
      const target = (wantedKey
        ? this.container.querySelector<HTMLElement>(`[data-key="${attrSelectorEscape(wantedKey)}"]`)
        : null) ?? this.container.querySelector<HTMLElement>(
        `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`,
      );
      this.nav.focus(target);
    } else this.nav.clearDetachedFocus();
  }

  private scheduleGridSnap(view: HTMLElement): void {
    if (this.gridSnapTimer !== null) clearTimeout(this.gridSnapTimer);
    this.gridSnapTimer = setTimeout(() => {
      this.gridSnapTimer = null;
      if (this.mode !== 'grid') return;
      const itemCount = this.currentItemCount();
      const track = this.container.querySelector<HTMLElement>('.catalog-grid-track');
      const viewportWidth = track?.clientWidth || CATALOG_GRID_VIEWPORT_WIDTH;
      const viewportHeight = view.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT;
      const maxOffset = Math.max(
        0,
        this.gridVirtualizer.getTotalSize(itemCount, viewportWidth) - viewportHeight,
      );
      const snapped = Math.min(
        maxOffset,
        Math.round(this.gridVirtualizer.scrollOffset / CATALOG_GRID_ROW_STRIDE)
          * CATALOG_GRID_ROW_STRIDE,
      );
      if (snapped === this.gridVirtualizer.scrollOffset) return;
      this.gridVirtualizer.setScrollOffset(snapped);
      this.renderGrid(false);
    }, GRID_SNAP_DELAY_MS);
  }

  private gridTrackStart(
    view: HTMLElement | null,
    track: HTMLElement | null,
  ): number {
    if (!view || !track) return 0;
    return Math.max(
      0,
      track.getBoundingClientRect().top
        - view.getBoundingClientRect().top
        + view.scrollTop,
    );
  }
}
