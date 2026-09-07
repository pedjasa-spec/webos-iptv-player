import { describe, it, expect } from 'vitest';
import { SidebarList, applyFavoriteOrder, type SidebarEntry } from './sidebar-list';

function entry(id: string, favoritable = true): SidebarEntry {
  return { id, label: id, favoritable };
}

describe('applyFavoriteOrder', () => {
  it('keeps non-favoritable (pinned/builtin) entries first, untouched', () => {
    const entries = [entry('all', false), entry('favs', false), entry('News'), entry('Sports')];
    const result = applyFavoriteOrder(entries, ['Sports']);
    expect(result.map((e) => e.id)).toEqual(['all', 'favs', 'Sports', 'News']);
    expect(result[0].favorite).toBeUndefined();
    expect(result[1].favorite).toBeUndefined();
  });

  it('hoists favorited entries above the rest, in mark order', () => {
    const entries = [entry('News'), entry('Sports'), entry('Music'), entry('Kids')];
    // Marked Music first, then Sports.
    const result = applyFavoriteOrder(entries, ['Music', 'Sports']);
    expect(result.map((e) => e.id)).toEqual(['Music', 'Sports', 'News', 'Kids']);
    expect(result[0].favorite).toBe(true);
    expect(result[1].favorite).toBe(true);
  });

  it('leaves unfavorited entries in the given (server/discovery) order', () => {
    const entries = [entry('C'), entry('A'), entry('B')];
    const result = applyFavoriteOrder(entries, []);
    expect(result.map((e) => e.id)).toEqual(['C', 'A', 'B']);
  });

  it('ignores a matching id on a non-favoritable entry', () => {
    const entries = [entry('all', false), entry('News')];
    const result = applyFavoriteOrder(entries, ['all']);
    expect(result.map((e) => e.id)).toEqual(['all', 'News']);
    expect(result[0].favorite).toBeUndefined();
  });

  it('matches by favoriteKey when set, not by id', () => {
    const withKey: SidebarEntry = { id: 'source:News', label: 'News', favoritable: true, favoriteKey: 'News' };
    const result = applyFavoriteOrder([entry('Sports'), withKey], ['News']);
    expect(result.map((e) => e.id)).toEqual(['source:News', 'Sports']);
    expect(result[0].favorite).toBe(true);
  });

  it('supports an unlimited number of favorites', () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(`g${i}`));
    const favoriteIds = entries.map((e) => e.id).reverse();
    const result = applyFavoriteOrder(entries, favoriteIds);
    expect(result.map((e) => e.id)).toEqual(favoriteIds);
    expect(result.every((e) => e.favorite)).toBe(true);
  });
});

describe('SidebarList marker rendering', () => {
  it('shows the favorite star only on entries marked favorite', () => {
    const list = new SidebarList({ itemSize: 68, overscan: 4, fallbackViewportSize: 900 });
    const entries: SidebarEntry[] = [
      { id: 'News', label: 'News', favoritable: true, favorite: true },
      { id: 'Sports', label: 'Sports', favoritable: true },
    ];
    const html = String(list.render(entries, 'News', 900));
    const newsRow = html.slice(0, html.indexOf('Sports'));
    const sportsRow = html.slice(html.indexOf('Sports'));
    expect(newsRow).toContain('group-favorite-star');
    expect(sportsRow).not.toContain('group-favorite-star');
  });

  it('marks favoritable rows with data-favoritable and data-favorite-key', () => {
    const list = new SidebarList({ itemSize: 68, overscan: 4, fallbackViewportSize: 900 });
    const entries: SidebarEntry[] = [
      { id: 'source:News', label: 'News', favoritable: true, favoriteKey: 'News' },
      { id: 'builtin:all', label: 'All' },
    ];
    const html = String(list.render(entries, 'source:News', 900));
    const newsRow = html.slice(0, html.indexOf('builtin:all'));
    expect(newsRow).toContain('data-favoritable="true"');
    expect(newsRow).toContain('data-favorite-key="News"');
    const allRow = html.slice(html.indexOf('builtin:all'));
    expect(allRow).toContain('data-favoritable=""');
    expect(allRow).toContain('data-favorite-key="builtin:all"');
  });
});
