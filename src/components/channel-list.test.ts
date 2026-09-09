// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Channel } from '../types';
import type { RecentlyWatchedItem } from '../services/recently-watched';

const {
  data,
  customization,
  playlistMock,
  epgMock,
  storageMock,
  recentMock,
  toastMock,
  healthMock,
} = vi.hoisted(() => {
  const mk = (o: Partial<Channel>): Channel => ({
    id: '', name: '', logo: '', group: '', url: '', extras: null,
    playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0, ...o,
  });
  const channels: Channel[] = [
    mk({ id: 'a', name: 'Alpha', group: 'News', url: 'http://host/a' }),
    mk({ id: 'b', name: 'Bravo', group: 'Sports', url: 'http://host/b' }),
    mk({ id: 'c', name: 'Charlie', group: 'News', url: 'http://host/c' }),
  ];
  const raw = channels.slice();
  const data = { channels, raw, favorites: [] as string[], includeHidden: false };
  const customization = { record: null as unknown };

  return {
    data,
    customization,
    playlistMock: {
      channels,
      groupsRevision: 0,
      playlistTabs: [] as { id: string; name: string }[],
      getGroupsForPlaylist: () => ['News', 'Sports'],
      getGroupKeyForDisplay: (display: string) => display,
      getByGroup: (_group: string, _playlist?: string): Channel[] => channels,
      getGroupCount: (_group: string, _playlist?: string) => channels.length,
      indexOf: (ch: Channel) => channels.indexOf(ch),
      indexOfKey: (_key: string) => -1,
      getByIndex: (i: number) => channels[i] ?? null,
      applyCustomization: vi.fn(),
      setIncludeHidden: vi.fn(),
    },
    epgMock: { findChannelId: () => null, getNowPlaying: () => null },
    storageMock: {
      getFavorites: () => data.favorites,
      setFavorites: vi.fn((favorites: string[]) => {
        data.favorites = favorites;
        return true;
      }),
      toggleFavorite: vi.fn((key: string) => {
        const index = data.favorites.indexOf(key);
        if (index >= 0) data.favorites.splice(index, 1);
        else data.favorites.push(key);
        return index < 0;
      }),
      getShowHiddenChannels: () => false,
      getChannelCustomization: () => customization.record,
      setChannelCustomization: vi.fn((d: unknown) => { customization.record = d; }),
      clearChannelCustomization: vi.fn(() => { customization.record = null; }),
    },
    recentMock: {
      items: [] as RecentlyWatchedItem[],
      getItems: vi.fn(() => recentMock.items),
      catchupInfo: vi.fn(),
    },
    toastMock: { showToast: vi.fn() },
    healthMock: {
      records: {} as Record<string, 'healthy' | 'suspect' | 'unavailable'>,
      getRecord: vi.fn((channel: Channel) => {
        const status = healthMock.records[channel.url];
        return status ? { status } : null;
      }),
    },
  };
});

vi.mock('../services/playlist-service', () => ({ PlaylistService: playlistMock }));
vi.mock('../services/epg-service', () => ({ EpgService: epgMock }));
vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('../services/recently-watched', () => ({ RecentlyWatchedService: recentMock }));
vi.mock('./toast', () => ({ showToast: toastMock.showToast }));
vi.mock('../services/channel-health', () => ({ ChannelHealthService: healthMock }));

import { ChannelList } from './channel-list';
import { setLocale } from '../i18n';
import { channelKey } from '../utils/channel';
import { UNCATEGORIZED_GROUP } from '../types';
import { ChannelCustomizationService, groupKeyOf } from '../services/channel-customization';

playlistMock.indexOfKey = (key: string) => data.channels
  .findIndex(ch => channelKey(ch) === key);
playlistMock.getGroupKeyForDisplay = (display: string): string => {
  for (const key of ChannelCustomizationService.customGroups) {
    if (ChannelCustomizationService.groupLabel(key) === display) return key;
  }
  for (const channel of data.channels) {
    if (channel.group === display) return groupKeyOf(channel);
  }
  return display;
};
playlistMock.getByGroup = (group: string, playlist?: string): Channel[] => {
  const channels = playlist
    ? data.channels.filter(channel => channel.playlistIds.includes(playlist))
    : data.channels;
  if (group === 'builtin:all' || group === 'builtin:recently-watched') return channels;
  if (group === 'builtin:favorites') {
    return channels.filter(channel => data.favorites.includes(channelKey(channel)));
  }
  if (group.indexOf('folder:') === 0) {
    const folderKey = group.slice('folder:'.length);
    return channels.filter(channel =>
      ChannelCustomizationService.folderFor(channelKey(channel)) === folderKey);
  }
  return channels.filter(channel => channel.group === group.slice('source:'.length));
};

// Mirror PlaylistService: re-derive the visible list from the customization record.
playlistMock.applyCustomization = vi.fn(() => {
  const next = ChannelCustomizationService.applyTo(data.raw, data.includeHidden);
  data.channels.splice(0, data.channels.length, ...next);
  playlistMock.groupsRevision++;
});
playlistMock.setIncludeHidden = vi.fn((on: boolean) => {
  if (data.includeHidden === on) return;
  data.includeHidden = on;
  playlistMock.applyCustomization();
});
playlistMock.getGroupsForPlaylist = (playlist?: string) => {
  const keys: string[] = [];
  const channels = playlist
    ? data.channels.filter(ch => ch.playlistIds.includes(playlist))
    : data.channels;
  for (const ch of channels) {
    const key = groupKeyOf(ch);
    if (key && keys.indexOf(key) < 0) keys.push(key);
  }
  if (!playlist) {
    for (const key of ChannelCustomizationService.customGroups) {
      if (keys.indexOf(key) < 0) keys.push(key);
    }
  }
  return ChannelCustomizationService.sortGroupKeys(keys)
    .map(key => ChannelCustomizationService.groupLabel(key));
};

let container: HTMLElement;
let onSelect: ReturnType<typeof vi.fn>;
let list: ChannelList;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  data.favorites = [];
  data.includeHidden = false;
  data.raw.forEach(ch => { ch.playlistIds = []; });
  data.raw[2].group = 'News';
  delete data.raw[2].sourceGroup;
  delete data.raw[2].groupKey;
  customization.record = null;
  ChannelCustomizationService.reload();
  playlistMock.applyCustomization();
  recentMock.items = [];
  recentMock.getItems.mockClear();
  recentMock.catchupInfo.mockReset();
  toastMock.showToast.mockClear();
  healthMock.records = {};
  playlistMock.playlistTabs = [];
  storageMock.toggleFavorite.mockClear();
  storageMock.setFavorites.mockClear();
  storageMock.setChannelCustomization.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  onSelect = vi.fn();
  list = new ChannelList(container, onSelect);
});

function channelItems(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.channel-main .channel-item'));
}

function hover(el: HTMLElement): void {
  el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
}

describe('ChannelList.render', () => {
  // With no channels the entry point falls through to the first focusable,
  // taken in DOM order with no geometry to fall back on — so measurement is
  // the only thing keeping focus off an invisible control. Rects are stubbed
  // because jsdom has no layout.
  it('an empty list falls back to the first visible focusable', () => {
    const savedChannels = data.channels.slice();
    const savedByGroup = playlistMock.getByGroup;
    const savedCount = playlistMock.getGroupCount;
    playlistMock.getByGroup = () => [];
    playlistMock.getGroupCount = () => 0;
    data.channels.length = 0;

    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function stub(this: Element): DOMRect {
      const collapsed = this.classList.contains('channel-edit-btn');
      const size = collapsed ? 0 : 100;
      return { width: size, height: size, top: 0, left: 0, bottom: size, right: size } as DOMRect;
    };
    try {
      list.render();
    } finally {
      Element.prototype.getBoundingClientRect = original;
      playlistMock.getByGroup = savedByGroup;
      playlistMock.getGroupCount = savedCount;
      data.channels.push(...savedChannels);
    }

    expect(container.querySelector('.channel-edit-btn')!.classList.contains('focused')).toBe(false);
    expect(container.querySelector('.group-item')!.classList.contains('focused')).toBe(true);
  });

  it('initial focus is the first channel when channels exist', () => {
    list.render();
    expect(channelItems()[0].classList.contains('focused')).toBe(true);
  });

  it('renders no title heading or settings gear (the tab bar owns those)', () => {
    list.render();
    expect(container.querySelector('.sidebar-title')).toBeNull();
    expect(container.querySelector('.settings-btn')).toBeNull();
  });

  it('renders the channel count and all channels for the default group', () => {
    list.render();
    expect(container.querySelector('.channel-count')?.textContent).toBe('3 channels');
    expect(channelItems()).toHaveLength(3);
    expect(container.textContent).toContain('Alpha');
  });

  it('renders persisted channel health status', () => {
    healthMock.records['http://host/a'] = 'suspect';
    list.render();

    const dot = channelItems()[0].querySelector('.channel-health-dot');
    expect(dot?.textContent).toBe('');
    expect(dot?.getAttribute('aria-label')).toBe('Suspect');
    expect(dot?.classList)
      .toContain('suspect');
  });

  it('renders normal channel and group content without editor inputs', () => {
    list.render();

    expect(channelItems()[0].querySelector('.channel-name')?.textContent).toBe('Alpha');
    expect(container.querySelector('[data-group="source:News"] .group-name')?.textContent)
      .toBe('News');
    expect(container.querySelector('.edit-text-input')).toBeNull();
  });

  it('opens channel editing from the pencil button', () => {
    list.render();
    const edit = container.querySelector<HTMLElement>('.channel-edit-btn');
    expect(edit?.querySelector('img')?.getAttribute('src')).toBe('assets/icons/pencil.svg');
    hover(edit!);
    list.handleAction('select');
    expect(list.isEditing).toBe(true);
    expect(container.querySelector('.channel-edit-btn')).toBeNull();
  });

  it('keeps the header (pencil + count) intact once a folder exists', () => {
    ChannelCustomizationService.setGroup(channelKey(data.channels[0]), 'Custom');
    playlistMock.applyCustomization();
    list.render();
    expect(container.querySelector('.channel-count')?.textContent).toBe('3 channels');
    const edit = container.querySelector<HTMLElement>('.channel-edit-btn');
    expect(edit?.querySelector('img')?.getAttribute('src')).toBe('assets/icons/pencil.svg');
  });

  it('uses the singular channel count for a one-channel playlist', () => {
    const removed = playlistMock.channels.splice(1);
    try {
      list.render();
      expect(container.querySelector('.channel-count')?.textContent).toBe('1 channel');
    } finally {
      playlistMock.channels.push(...removed);
    }
  });

  it('renders no inline search magnifier (the tab bar owns search)', () => {
    list.render();
    expect(container.querySelector('.channel-search')).toBeNull();
    expect(container.querySelector('.search-icon')).toBeNull();
  });

  it('renders a bounded window for 50,000 channels', () => {
    const original = data.raw.slice();
    data.raw.splice(0, data.raw.length);
    for (let i = 0; i < 50_000; i++) {
      data.raw.push({
        ...original[0],
        id: `ch${String(i)}`,
        name: `Channel ${String(i)}`,
        url: `http://host/${String(i)}`,
      });
    }
    try {
      playlistMock.applyCustomization();
      list.render();

      expect(channelItems().length).toBeLessThan(50);
      expect(container.querySelector<HTMLElement>('.channel-list-spacer')?.style.height)
        .toBe('4400000px');
    } finally {
      data.raw.splice(0, data.raw.length, ...original);
      playlistMock.applyCustomization();
    }
  });

  it('renders the group list including All, Favorites, and Recently Watched', () => {
    list.render();
    const groups = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
      .map(g => g.dataset.group);
    expect(groups).toEqual([
      'builtin:all',
      'builtin:favorites',
      'builtin:recently-watched',
      'source:News',
      'source:Sports',
    ]);
  });

  it('rebuilds cached builtin group labels after a language change', () => {
    list.render();
    expect(container.querySelector('[data-group="builtin:recently-watched"] .group-name')?.textContent)
      .toBe('Recently Watched');

    setLocale('zh-CN');
    list.render();

    expect(container.querySelector('[data-group="builtin:recently-watched"] .group-name')?.textContent)
      .toBe('最近观看');
  });

  it('localizes the ungrouped bucket while leaving provider group names alone', () => {
    const original = playlistMock.getGroupsForPlaylist;
    playlistMock.getGroupsForPlaylist = () => ['Uncategorized', UNCATEGORIZED_GROUP];
    playlistMock.groupsRevision++;
    try {
      setLocale('en');
      list.render();
      const labels = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
        .filter(g => g.dataset.group?.indexOf('source:') === 0)
        .map(g => g.querySelector('.group-name')?.textContent);
      expect(labels).toEqual(['Uncategorized', 'Uncategorized']);

      setLocale('zh-CN');
      playlistMock.groupsRevision++;
      list.render();
      const zh = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
        .filter(g => g.dataset.group?.indexOf('source:') === 0)
        .map(g => g.querySelector('.group-name')?.textContent);
      expect(zh).toEqual(['Uncategorized', '未分类']);
    } finally {
      setLocale('en');
      playlistMock.getGroupsForPlaylist = original;
      playlistMock.groupsRevision++;
    }
  });

  it('renders a bounded group window for 50,000 groups', () => {
    const original = playlistMock.getGroupsForPlaylist;
    playlistMock.getGroupsForPlaylist = () =>
      Array.from({ length: 50_000 }, (_, index) => `Group ${String(index)}`);
    playlistMock.groupsRevision++;
    try {
      list.render();
      expect(container.querySelectorAll('.group-item').length).toBeLessThan(60);
      expect(container.querySelector<HTMLElement>('.group-list-spacer')?.style.height)
        .toBe('3400204px');
    } finally {
      playlistMock.getGroupsForPlaylist = original;
      playlistMock.groupsRevision++;
    }
  });

  it('marks favorites with a star', () => {
    data.favorites = [channelKey(data.channels[0])];
    list.render();
    const alpha = channelItems()[0].querySelector('.channel-name')!;
    expect(alpha.textContent).toContain('★');
  });

  it('shows an empty state when a group has no channels', () => {
    data.favorites = [];
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:favorites"]')!);
    list.handleAction('select');
    expect(container.querySelector('.empty-state')?.textContent).toBe('No channels found');
  });

  it('renders distinct live and Catch-up rows in Recently Watched', () => {
    const live = {
      kind: 'live' as const,
      channel: data.channels[0],
      channelIndex: 0,
      updatedAt: 2000,
    };
    const catchup = {
      kind: 'catchup' as const,
      channel: data.channels[1],
      channelIndex: 1,
      updatedAt: 1000,
      progress: {
        channelKey: channelKey(data.channels[1]),
        progStart: 1000,
        progEnd: 3_601_000,
        title: 'Program Alpha',
        description: '',
        icon: '',
        position: 600,
        duration: 3600,
        updatedAt: 1000,
        completed: false,
      },
    };
    recentMock.items = [live, catchup];

    list.render();
    const spacer = container.querySelector('.channel-list-spacer');
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');

    expect(channelItems()).toHaveLength(2);
    expect(channelItems()[0]).not.toBe(spacer);
    expect(channelItems()[0].querySelector('.recent-kind-badge')?.textContent).toBe('LIVE');
    expect(channelItems()[1].querySelector('.recent-kind-badge')?.textContent).toBe('CATCH-UP');
    expect(channelItems()[1].textContent).toContain('Program Alpha');
    expect(channelItems()[1].textContent).toContain('Resume at 10:00');
    expect(container.querySelector('.channel-list-scroll')?.classList.contains('recent-list'))
      .toBe(true);
    expect(container.querySelector('.channel-list-spacer')).toBeNull();
  });

  it('resets a deep channel scroll before showing Recently Watched', () => {
    recentMock.items = [{
      kind: 'live',
      channel: data.channels[0],
      channelIndex: 0,
      updatedAt: 1000,
    }];
    list.render();
    const main = container.querySelector<HTMLElement>('.channel-main')!;
    main.scrollTop = 20_000;

    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');

    expect(main.scrollTop).toBe(0);
    expect(channelItems()).toHaveLength(1);
  });

  it('shows the Recently Watched empty state', () => {
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    expect(container.querySelector('.empty-state')?.textContent).toBe('Nothing watched yet');
  });

  it('shows the pencil disabled (not hidden) in Recently Watched', () => {
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    const btn = container.querySelector('.channel-edit-btn');
    expect(btn).not.toBeNull();
    expect(btn?.classList.contains('disabled')).toBe(true);
    expect(btn?.getAttribute('aria-disabled')).toBe('true');
    expect(btn?.hasAttribute('data-focusable')).toBe(false);
    expect(container.querySelector('.channel-edit-btn-spacer')).toBeNull();
    list.handleAction('yellow');
    expect(list.isEditing).toBe(false);
    expect(container.querySelector('.edit-hints')).toBeNull();
  });

  it('falls back to All when Settings opens editing from Recently Watched', () => {
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    list.enterEditMode(); // Settings' "Edit channel list" calls with no group
    expect(list.isEditing).toBe(true);
    expect(container.querySelector('[data-group="builtin:all"]')?.classList.contains('active'))
      .toBe(true);
    expect(channelItems()).toHaveLength(3);
  });

  it('opens Settings-driven channel editing scoped to the currently selected group', () => {
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="source:Sports"]')!);
    list.handleAction('select');
    list.enterEditMode(); // no explicit group — same call Settings makes
    expect(list.isEditing).toBe(true);
    expect(container.querySelector('[data-group="source:Sports"]')?.classList.contains('active'))
      .toBe(true);
    expect(channelItems()).toHaveLength(1);
    expect(container.textContent).toContain('Bravo');
  });

  it('escapes a malicious channel name instead of rendering live HTML (XSS)', () => {
    playlistMock.channels[0].name = '<img src=x onerror="window.__xss=1">';
    try {
      list.render();
      expect(container.querySelector('.channel-main img')).toBeNull();
      expect(container.querySelector('.channel-name')?.textContent)
        .toContain('<img src=x onerror=');
    } finally {
      playlistMock.channels[0].name = 'Alpha';
    }
  });

  it('removes a failed channel logo and does not restore it on later renders', () => {
    playlistMock.channels[0].logo = 'http://host/broken.png';
    try {
      list.render();
      const logo = container.querySelector<HTMLImageElement>('.channel-logo');
      expect(logo).not.toBeNull();

      logo!.dispatchEvent(new Event('error'));
      const failedRow = channelItems()[0];
      expect(failedRow.querySelector('.channel-logo')).toBeNull();
      expect(failedRow.querySelector('.channel-logo-placeholder')).toBeNull();

      list.render();
      expect(channelItems()[0].querySelector('.channel-logo')).toBeNull();
    } finally {
      playlistMock.channels[0].logo = '';
    }
  });
});

describe('ChannelList interaction', () => {
  beforeEach(() => list.render());

  it('selecting a focused channel plays it', () => {
    hover(channelItems()[1]);
    list.handleAction('select');
    expect(onSelect).toHaveBeenCalledWith(1, undefined, { group: 'builtin:all', playlist: undefined });
  });

  it('reports virtual moves so Up does not hand focus to the tab bar', () => {
    expect(list.handleAction('down')).toBe(true);
    expect(container.querySelector<HTMLElement>('.channel-item.focused')?.dataset.channelIndex)
      .toBe('1');
    expect(list.handleAction('up')).toBe(true);
    list.handleAction('select');
    expect(onSelect).toHaveBeenCalledWith(0, undefined, { group: 'builtin:all', playlist: undefined });
  });

  it('selecting a recent live row starts live playback', () => {
    recentMock.items = [{
      kind: 'live',
      channel: data.channels[1],
      channelIndex: 1,
      updatedAt: 1000,
    }];
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    hover(channelItems()[0]);
    list.handleAction('select');
    expect(onSelect).toHaveBeenCalledWith(1, undefined, { group: 'builtin:recently-watched', playlist: undefined });
  });

  it('places recent live health before the Live badge', () => {
    recentMock.items = [{
      kind: 'live',
      channel: data.channels[1],
      channelIndex: 1,
      updatedAt: 1000,
    }];
    healthMock.records[data.channels[1].url] = 'suspect';
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');

    const row = channelItems()[0];
    const dot = row.querySelector('.channel-health-dot');
    const badge = row.querySelector('.recent-kind-badge');
    expect(dot?.nextElementSibling).toBe(badge);
  });

  it('selecting a recent Catch-up row resumes directly', async () => {
    const catchup = {
      kind: 'catchup' as const,
      channel: data.channels[0],
      channelIndex: 0,
      updatedAt: 1000,
      progress: {
        channelKey: channelKey(data.channels[0]),
        progStart: 1_000_000,
        progEnd: 4_600_000,
        title: 'Program Alpha',
        description: '',
        icon: '',
        position: 600,
        duration: 3600,
        updatedAt: 1000,
        completed: false,
      },
    };
    recentMock.items = [catchup];
    const info = {
      start: 1000,
      end: 4600,
      title: 'Program Alpha',
      description: '',
      icon: '',
      resumeSecs: 600,
    };
    recentMock.catchupInfo.mockResolvedValue(info);
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    hover(channelItems()[0]);
    list.handleAction('select');
    await Promise.resolve();
    expect(onSelect).toHaveBeenCalledWith(0, info, { group: 'builtin:recently-watched', playlist: undefined });
  });

  it('removes an unavailable recent Catch-up row and shows a toast', async () => {
    recentMock.items = [{
      kind: 'catchup',
      channel: data.channels[0],
      channelIndex: 0,
      updatedAt: 1000,
      progress: {
        channelKey: channelKey(data.channels[0]),
        progStart: 1_000_000,
        progEnd: 4_600_000,
        title: 'Program Alpha',
        position: 600,
        duration: 3600,
        updatedAt: 1000,
        completed: false,
      },
    }];
    recentMock.catchupInfo.mockResolvedValue(null);
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    hover(channelItems()[0]);
    list.handleAction('select');
    await Promise.resolve();
    expect(onSelect).not.toHaveBeenCalled();
    expect(toastMock.showToast).toHaveBeenCalledWith('This catch-up program is no longer available.');
  });

  it('plays a channel on a pointer click', () => {
    const target = channelItems()[1];
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => target;
    container.dispatchEvent(new MouseEvent('click', { clientX: 100, clientY: 50, bubbles: true }));
    document.elementFromPoint = orig;
    expect(onSelect).toHaveBeenCalledWith(1, undefined, { group: 'builtin:all', playlist: undefined });
  });

  it('switches group on a pointer click over a group item', () => {
    const group = container.querySelector<HTMLElement>('[data-group="source:Sports"]')!;
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => group;
    container.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }));
    document.elementFromPoint = orig;
    expect(channelItems()).toHaveLength(1);
    expect(container.textContent).toContain('Bravo');
  });

  it('selecting a group filters the channel list', () => {
    hover(container.querySelector<HTMLElement>('[data-group="source:Sports"]')!);
    list.handleAction('select');
    expect(channelItems()).toHaveLength(1);
    expect(container.textContent).toContain('Bravo');
    expect(container.textContent).not.toContain('Alpha');
  });

  it('clears the focused channel when the cursor leaves the view', () => {
    hover(channelItems()[1]);
    expect(channelItems()[1].classList.contains('focused')).toBe(true);
    container.dispatchEvent(new MouseEvent('mouseleave'));
    expect(channelItems()[1].classList.contains('focused')).toBe(false);
  });

  it('green toggles the focused channel as a favorite', () => {
    expect(container.querySelector('.channel-hints')).toBeNull();
    hover(channelItems()[0]);
    list.handleAction('green');
    expect(storageMock.toggleFavorite).toHaveBeenCalledWith(channelKey(data.channels[0]));
  });

  it('green favorites a focused group, marks it, and moves it to the top', () => {
    const sports = container.querySelector<HTMLElement>('[data-group="source:Sports"]')!;
    hover(sports);
    list.handleAction('green');
    expect(storageMock.toggleFavorite).not.toHaveBeenCalled();
    expect(ChannelCustomizationService.isGroupFavorite('Sports')).toBe(true);

    const groups = Array.from(container.querySelectorAll<HTMLElement>('[data-group^="source:"]'));
    expect(groups[0].dataset.group).toBe('source:Sports');
    expect(groups[0].querySelector('.group-favorite-star')).not.toBeNull();
    expect(groups[1].querySelector('.group-favorite-star')).toBeNull();
    // Still focused after the reorder — the toggle key didn't move the cursor.
    expect(container.querySelector('.focused')?.getAttribute('data-group')).toBe('source:Sports');
  });

  it('green unfavorites a group and restores its server-order position', () => {
    ChannelCustomizationService.toggleGroupFavorite('Sports');
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="source:Sports"]')!);
    list.handleAction('green');
    expect(ChannelCustomizationService.isGroupFavorite('Sports')).toBe(false);
    const groups = Array.from(container.querySelectorAll<HTMLElement>('[data-group^="source:"]'));
    expect(groups.map(g => g.dataset.group)).toEqual(['source:News', 'source:Sports']);
  });

  it('bands folders above favorited groups, which stay above the rest', () => {
    ChannelCustomizationService.assignFolder(channelKey(data.channels[0]), 'Kids');
    playlistMock.applyCustomization();
    ChannelCustomizationService.toggleGroupFavorite('Sports');
    list.render();

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-group^="source:"], [data-group^="folder:"]'),
    ).map(g => g.dataset.group);
    expect(rows).toEqual(['folder:Kids', 'source:Sports', 'source:News']);
  });

  it('keeps focus on a group favorited far outside the rendered window', () => {
    const original = playlistMock.getGroupsForPlaylist;
    playlistMock.getGroupsForPlaylist = () =>
      Array.from({ length: 200 }, (_, index) => `Group ${String(index)}`);
    playlistMock.groupsRevision++;
    try {
      list.render();
      // jsdom has no real layout, so a plain assignment to .group-list's native
      // scrollTop clamps to 0 (zero scrollHeight); make it a plain writable
      // number so repeated ensureVisible-driven navigation actually advances.
      Object.defineProperty(
        container.querySelector<HTMLElement>('.group-list')!,
        'scrollTop',
        { value: 0, writable: true, configurable: true },
      );
      hover(container.querySelector<HTMLElement>('[data-group="source:Group 0"]')!);
      // Walk to the last group via real down-navigation (exercises moveVirtualFocus's
      // own ensureVisible, not just the fix under test) so it starts off far outside
      // whatever window favoriting a low group would otherwise leave rendered.
      for (let i = 0; i < 199; i++) list.handleAction('down');
      expect(container.querySelector<HTMLElement>('.focused')?.dataset.group).toBe('source:Group 199');

      list.handleAction('green');
      expect(ChannelCustomizationService.isGroupFavorite('Group 199')).toBe(true);
      const focused = container.querySelector<HTMLElement>('.focused')!;
      expect(focused.dataset.group).toBe('source:Group 199');
      expect(focused.querySelector('.group-favorite-star')).not.toBeNull();
    } finally {
      playlistMock.getGroupsForPlaylist = original;
      playlistMock.groupsRevision++;
    }
  });

  it('a number action plays that channel (1-based)', () => {
    list.handleAction('number', { number: 2 });
    expect(onSelect).toHaveBeenCalledWith(1, undefined, { group: 'builtin:all', playlist: undefined });
  });

  it('a number action focuses and marks the channel it tuned', () => {
    list.handleAction('number', { number: 2 });
    expect(channelItems()[1].classList.contains('focused')).toBe(true);
    expect(channelItems()[1].classList.contains('playing')).toBe(true);
  });

  it('widens a filtered group so the tuned channel is reachable on return', () => {
    hover(container.querySelector<HTMLElement>('[data-group="source:Sports"]')!);
    list.handleAction('select');
    expect(channelItems()).toHaveLength(1); // Bravo only

    list.handleAction('number', { number: 1 }); // Alpha, outside the Sports group

    expect(onSelect).toHaveBeenCalledWith(0, undefined, { group: 'builtin:all', playlist: undefined });
    expect(channelItems()).toHaveLength(3);
    expect(channelItems()[0].classList.contains('focused')).toBe(true);
    expect(channelItems()[0].classList.contains('playing')).toBe(true);
  });

  it('ignores an out-of-range number', () => {
    list.handleAction('number', { number: 99 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('setPlaying marks the playing channel on the next render', () => {
    list.setPlaying(2);
    list.render();
    expect(channelItems()[2].classList.contains('playing')).toBe(true);
  });

  it('highlightEntryPoint focuses the first channel without taking the caret', () => {
    list.highlightEntryPoint();
    expect(channelItems()[0].classList.contains('focused')).toBe(true);
  });

  // However the channel was tuned — a number typed in the player, ch+/-, the
  // sidebar — coming back to the list has to land on what is playing.
  it('highlightEntryPoint focuses the playing channel, not the first one', () => {
    list.setPlaying(2); // tuned elsewhere: the list never rendered a selection
    list.highlightEntryPoint();
    expect(channelItems()[2].classList.contains('focused')).toBe(true);
    expect(channelItems()[0].classList.contains('focused')).toBe(false);
  });

  it('highlightEntryPoint widens a filtered group to reach the playing channel', () => {
    hover(container.querySelector<HTMLElement>('[data-group="source:Sports"]')!);
    list.handleAction('select');
    expect(channelItems()).toHaveLength(1); // Bravo only

    list.setPlaying(0); // Alpha: playing, but outside the Sports filter
    list.highlightEntryPoint();

    expect(channelItems()).toHaveLength(3);
    expect(channelItems()[0].classList.contains('focused')).toBe(true);
  });
});

describe('ChannelList listener lifecycle', () => {
  it('falls back to the All tab when the selected playlist was removed', () => {
    playlistMock.playlistTabs = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
    list.render();
    hover(container.querySelector<HTMLElement>('[data-playlist="b"]')!);
    list.handleAction('select');
    expect(container.querySelector('.playlist-tab.active')?.getAttribute('data-playlist')).toBe('b');

    playlistMock.playlistTabs = [{ id: 'a', name: 'A' }, { id: 'c', name: 'C' }]; // 'b' deleted
    list.render();
    expect(container.querySelector('.playlist-tab.active')?.getAttribute('data-playlist')).toBe('');
  });

  it('binds the nav:hover listener once, not per render', () => {
    const c = document.createElement('div');
    document.body.appendChild(c);
    const spy = vi.spyOn(c, 'addEventListener');
    const l = new ChannelList(c, vi.fn());
    const initialCount = spy.mock.calls.filter(([type]) => type === 'nav:hover').length;
    l.render();
    l.render();
    l.render();
    const finalCount = spy.mock.calls.filter(([type]) => type === 'nav:hover').length;
    expect(initialCount).toBeGreaterThan(0);
    expect(finalCount).toBe(initialCount);
  });
});

describe('ChannelList morph lifecycle', () => {
  it('preserves channel-item node identity across re-renders', () => {
    list.render();
    const before = channelItems();
    list.setPlaying(1);
    list.render();
    const after = channelItems();
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });

  it('restores the SpatialNav focus class on the same node after a re-render', () => {
    list.render();
    hover(channelItems()[1]);
    expect(channelItems()[1].classList.contains('focused')).toBe(true);
    list.render();
    // Same DOM node, .focused re-applied via prevFocusedKey lookup.
    expect(channelItems()[1].classList.contains('focused')).toBe(true);
  });
});

// Long-press OK: the color-key alternative for remotes where those codes
// never reach the app. Uses real keydown/keyup dispatch (not
// list.handleAction) since the gesture lives entirely in a raw listener on
// the container, ahead of the Action pipeline.
describe('ChannelList long-press options menu', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function keydownEnter(el: HTMLElement, repeat = false): void {
    el.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 13, bubbles: true, repeat } as EventInit));
  }
  function keyupEnter(el: HTMLElement): void {
    el.dispatchEvent(new KeyboardEvent('keyup', { keyCode: 13, bubbles: true }));
  }

  it('a quick tap still plays the focused channel, unaffected', () => {
    list.render();
    const alpha = channelItems()[0];
    hover(alpha);
    keydownEnter(alpha);
    vi.advanceTimersByTime(100); // well under the threshold
    keyupEnter(alpha);
    expect(onSelect).toHaveBeenCalledWith(0, undefined, { group: 'builtin:all', playlist: undefined });
  });

  it('a quick tap still switches the focused group, unaffected', () => {
    list.render();
    const sports = container.querySelector<HTMLElement>('[data-group="source:Sports"]')!;
    hover(sports);
    keydownEnter(sports);
    keyupEnter(sports);
    expect(container.querySelector<HTMLElement>('.group-item.active')?.dataset.group)
      .toBe('source:Sports');
  });

  it('holding past the threshold opens the options menu instead of the normal action', () => {
    list.render();
    const alpha = channelItems()[0];
    hover(alpha);
    keydownEnter(alpha);
    vi.advanceTimersByTime(500);
    expect(container.querySelector('[data-options-choice]')).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();

    // Releasing after the menu already opened must not also fire select.
    keyupEnter(alpha);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores native key-repeat instead of restarting the hold timer', () => {
    list.render();
    const alpha = channelItems()[0];
    hover(alpha);
    keydownEnter(alpha);
    vi.advanceTimersByTime(400);
    keydownEnter(alpha, true); // OS auto-repeat while still held
    vi.advanceTimersByTime(100); // total 500ms since the first keydown
    expect(container.querySelector('[data-options-choice]')).not.toBeNull();
  });

  it('does not arm inside a text input (rename stays keydown-immediate)', () => {
    list.enterEditMode();
    const alpha = channelItems()[0];
    hover(alpha);
    list.handleAction('select'); // grab
    list.handleAction('blue'); // start rename
    const input = container.querySelector<HTMLInputElement>('.edit-text-input')!;
    input.value = 'Alpha HD';
    input.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 13, bubbles: true }));
    // No matching keyup ever follows for this path — if it were long-press-armed
    // it would hang open; commitTextInput fires straight from the keydown.
    expect(container.querySelector('.edit-text-input')).toBeNull();
    expect(channelItems()[0].querySelector('.channel-name')?.textContent).toBe('Alpha HD');
  });

  it('green in edit mode stops reordering, so the next down just moves focus', () => {
    const original = data.raw.slice();
    data.raw.splice(0, data.raw.length);
    for (let i = 0; i < 200; i++) {
      data.raw.push({
        ...original[0],
        id: `ch${String(i)}`,
        name: `Channel ${String(i)}`,
        url: `http://host/${String(i)}`,
        group: 'News',
      });
    }
    try {
      playlistMock.applyCustomization();
      list.render();
      hover(channelItems()[0]);
      for (let i = 0; i < 100; i++) list.handleAction('down');
      list.enterEditMode();
      const target = channelItems().find(el => el.classList.contains('focused'))!;
      const targetKey = target.getAttribute('data-key');
      list.handleAction('select'); // grab
      expect(target.classList.contains('grabbed')).toBe(true);

      list.handleAction('green'); // favorite it
      // Still "grabbed" (pressing green again would toggle the same channel
      // back off without re-selecting) — but no longer reorder-armed.
      expect(container.querySelector(`[data-key="${targetKey}"]`)?.classList.contains('grabbed'))
        .toBe(true);

      storageMock.setChannelCustomization.mockClear();
      list.handleAction('down'); // must move focus, not reorder the just-favorited channel
      expect(storageMock.setChannelCustomization).not.toHaveBeenCalled();

      const focused = container.querySelector('.channel-item.focused');
      expect(focused?.getAttribute('data-key')).not.toBe(targetKey);
      expect(focused?.querySelector('.channel-name')?.textContent).toBe('Channel 101');
    } finally {
      data.raw.splice(0, data.raw.length, ...original);
      playlistMock.applyCustomization();
    }
  });
});
