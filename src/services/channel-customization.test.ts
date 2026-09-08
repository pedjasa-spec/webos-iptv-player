import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Channel, ChannelCustomization } from '../types';
import { UNCATEGORIZED_GROUP } from '../types';

const { storageMock } = vi.hoisted(() => ({
  storageMock: {
    getChannelCustomization: vi.fn(() => null as ChannelCustomization | null),
    setChannelCustomization: vi.fn(),
    clearChannelCustomization: vi.fn(),
  },
}));

vi.mock('./storage-service', () => ({ StorageService: storageMock }));

import { ChannelCustomizationService, groupKeyOf } from './channel-customization';
import { channelKey } from '../utils/channel';
import { CONFIG } from '../config';

function channel(name: string, url: string, group = ''): Channel {
  return {
    id: '', name, logo: '', group, url, extras: null,
    playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0,
  };
}

function fixture(): Channel[] {
  return [
    channel('Alpha', 'http://host/a', 'News'),
    channel('Bravo', 'http://host/b', 'News'),
    channel('Charlie', 'http://host/c', 'Sports'),
  ];
}

const KEY_A = channelKey(channel('Alpha', 'http://host/a'));
const KEY_B = channelKey(channel('Bravo', 'http://host/b'));
const KEY_C = channelKey(channel('Charlie', 'http://host/c'));

function names(channels: Channel[]): string[] {
  return channels.map((ch) => ch.name);
}

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getChannelCustomization.mockReturnValue(null);
  ChannelCustomizationService.reload();
});

describe('ChannelCustomizationService', () => {
  it('is a no-op on an untouched install', () => {
    const channels = fixture();
    expect(ChannelCustomizationService.customized).toBe(false);
    expect(names(ChannelCustomizationService.applyTo(channels))).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(channels[0].sourceName).toBeUndefined();
    expect(channels[0].sourceGroup).toBeUndefined();
  });

  it('moves a channel and keeps unlisted channels after the customized block', () => {
    ChannelCustomizationService.moveChannel([KEY_A, KEY_B, KEY_C], KEY_C, KEY_A, false);
    expect(ChannelCustomizationService.customized).toBe(true);
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Charlie', 'Alpha', 'Bravo']);

    const withNew = fixture();
    withNew.push(channel('Delta', 'http://host/d', 'News'));
    expect(names(ChannelCustomizationService.applyTo(withNew)))
      .toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);
  });

  it('drops a move whose target is gone', () => {
    ChannelCustomizationService.moveChannel([KEY_A, KEY_B], KEY_A, 'missing', true);
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('hides a channel unless hidden entries are requested', () => {
    expect(ChannelCustomizationService.toggleHidden(KEY_B)).toBe(true);
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Alpha', 'Charlie']);
    expect(names(ChannelCustomizationService.applyTo(fixture(), true)))
      .toEqual(['Alpha', 'Bravo', 'Charlie']);

    expect(ChannelCustomizationService.toggleHidden(KEY_B)).toBe(false);
    expect(ChannelCustomizationService.isHidden(KEY_B)).toBe(false);
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('hides every channel of a hidden group', () => {
    ChannelCustomizationService.toggleGroupHidden('News');
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Charlie']);
    expect(ChannelCustomizationService.isChannelHidden(fixture()[0])).toBe(true);
    expect(ChannelCustomizationService.isChannelHidden(fixture()[2])).toBe(false);
  });

  it('renames a channel while keeping the source name, and restores it when cleared', () => {
    ChannelCustomizationService.rename(KEY_A, 'Alpha HD');
    let channels = ChannelCustomizationService.applyTo(fixture());
    expect(channels[0].name).toBe('Alpha HD');
    expect(channels[0].sourceName).toBe('Alpha');

    ChannelCustomizationService.rename(KEY_A, '  ');
    channels = ChannelCustomizationService.applyTo(fixture());
    expect(channels[0].name).toBe('Alpha');
    expect(channels[0].sourceName).toBeUndefined();
  });

  it('is idempotent when applied repeatedly to the same channels', () => {
    ChannelCustomizationService.rename(KEY_A, 'Alpha HD');
    ChannelCustomizationService.setGroup(KEY_A, 'Custom');
    const channels = fixture();
    ChannelCustomizationService.applyTo(channels);
    ChannelCustomizationService.applyTo(channels);
    expect(channels[0].name).toBe('Alpha HD');
    expect(channels[0].sourceName).toBe('Alpha');
    expect(channels[0].group).toBe('Custom');
    expect(channels[0].sourceGroup).toBe('News');
  });

  it('regroups a channel and registers the custom group', () => {
    ChannelCustomizationService.setGroup(KEY_C, 'Custom');
    expect(ChannelCustomizationService.customGroups).toEqual(['Custom']);
    const channels = ChannelCustomizationService.applyTo(fixture());
    expect(channels[2].group).toBe('Custom');
    expect(channels[2].sourceGroup).toBe('Sports');
    expect(groupKeyOf(channels[2])).toBe('Custom');

    ChannelCustomizationService.setGroup(KEY_C, '');
    expect(ChannelCustomizationService.applyTo(fixture())[2].group).toBe('Sports');
  });

  it('counts channels explicitly assigned to a group by override', () => {
    expect(ChannelCustomizationService.groupOverrideCount('Custom')).toBe(0);
    ChannelCustomizationService.setGroup(KEY_A, 'Custom');
    ChannelCustomizationService.setGroup(KEY_B, 'Custom');
    expect(ChannelCustomizationService.groupOverrideCount('Custom')).toBe(2);
    // A channel's natural (source) group members don't count — only overrides do.
    expect(ChannelCustomizationService.groupOverrideCount('Sports')).toBe(0);
  });

  it('deletes a custom group, falling its channels back to their source group', () => {
    ChannelCustomizationService.setGroup(KEY_A, 'Custom');
    ChannelCustomizationService.setGroup(KEY_B, 'Custom');
    ChannelCustomizationService.renameGroup('Custom', 'Renamed');
    ChannelCustomizationService.toggleGroupFavorite('Custom');
    ChannelCustomizationService.moveGroup(['News', 'Sports', 'Custom'], 'Custom', 'News', false);
    expect(ChannelCustomizationService.customGroups).toEqual(['Custom']);

    ChannelCustomizationService.removeCustomGroup('Custom');

    expect(ChannelCustomizationService.customGroups).toEqual([]);
    expect(ChannelCustomizationService.groupOverrideCount('Custom')).toBe(0);
    expect(ChannelCustomizationService.isGroupFavorite('Custom')).toBe(false);
    expect(ChannelCustomizationService.groupLabel('Custom')).toBe('Custom'); // rename dropped
    const channels = ChannelCustomizationService.applyTo(fixture());
    expect(channels[0].group).toBe('News');
    expect(channels[1].group).toBe('News');
  });

  it('does nothing when asked to delete a real (non-custom) group', () => {
    ChannelCustomizationService.removeCustomGroup('News');
    expect(ChannelCustomizationService.customGroups).toEqual([]);
    expect(ChannelCustomizationService.applyTo(fixture())[0].group).toBe('News');
  });

  it('sets and clears a manual EPG channel mapping', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    ChannelCustomizationService.setEpgChannel(KEY_A, 'source::epg-a');
    expect(ChannelCustomizationService.overrideFor(KEY_A)?.epgChannelId).toBe('source::epg-a');
    expect(ChannelCustomizationService.epgChannelIds()).toEqual(['source::epg-a']);
    expect(info).toHaveBeenCalledWith(
      '[ChannelCustom]',
      'EPG mapping set',
      'event=epg.mapping.set',
    );

    ChannelCustomizationService.setEpgChannel(KEY_A, '  ');
    expect(ChannelCustomizationService.overrideFor(KEY_A)).toBeNull();
    expect(ChannelCustomizationService.epgChannelIds()).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      '[ChannelCustom]',
      'EPG mapping cleared',
      'event=epg.mapping.cleared',
    );
  });

  it('sets, bounds, and clears a per-channel EPG offset delta', () => {
    ChannelCustomizationService.setEpgOffsetDelta(KEY_A, 15);
    expect(ChannelCustomizationService.overrideFor(KEY_A)?.epgOffsetDeltaMinutes).toBe(15);

    ChannelCustomizationService.setEpgOffsetDelta(
      KEY_A,
      CONFIG.EPG.OFFSET_MAX_MINUTES * 2 + 60,
    );
    expect(ChannelCustomizationService.overrideFor(KEY_A)?.epgOffsetDeltaMinutes)
      .toBe(CONFIG.EPG.OFFSET_MAX_MINUTES * 2);

    ChannelCustomizationService.setEpgOffsetDelta(KEY_A, null);
    expect(ChannelCustomizationService.overrideFor(KEY_A)).toBeNull();
  });

  it('renames a group without changing its key', () => {
    ChannelCustomizationService.renameGroup('News', 'Headlines');
    const channels = ChannelCustomizationService.applyTo(fixture());
    expect(channels[0].group).toBe('Headlines');
    expect(channels[0].sourceGroup).toBe('News');
    expect(groupKeyOf(channels[0])).toBe('News');
    expect(ChannelCustomizationService.groupLabel('News')).toBe('Headlines');
  });

  it('renames and hides the ungrouped bucket like any provider group', () => {
    const ungrouped = (): Channel[] => [channel('Alpha', 'http://host/a', UNCATEGORIZED_GROUP)];

    ChannelCustomizationService.renameGroup(UNCATEGORIZED_GROUP, 'Everything Else');
    const renamed = ChannelCustomizationService.applyTo(ungrouped());
    expect(renamed[0].group).toBe('Everything Else');
    expect(renamed[0].groupKey).toBe(UNCATEGORIZED_GROUP);
    expect(groupKeyOf(renamed[0])).toBe(UNCATEGORIZED_GROUP);

    ChannelCustomizationService.toggleGroupHidden(UNCATEGORIZED_GROUP);
    expect(ChannelCustomizationService.applyTo(ungrouped())).toHaveLength(0);
  });

  it('sorts group keys into the custom group order', () => {
    ChannelCustomizationService.moveGroup(['News', 'Sports'], 'Sports', 'News', false);
    expect(ChannelCustomizationService.sortGroupKeys(['News', 'Sports'])).toEqual(['Sports', 'News']);
    expect(ChannelCustomizationService.sortGroupKeys(['News', 'Sports', 'Music']))
      .toEqual(['Sports', 'News', 'Music']);
  });

  it('favorites groups independently of manual group order, in mark-order', () => {
    expect(ChannelCustomizationService.isGroupFavorite('Sports')).toBe(false);
    expect(ChannelCustomizationService.customized).toBe(false);

    expect(ChannelCustomizationService.toggleGroupFavorite('Sports')).toBe(true);
    expect(ChannelCustomizationService.toggleGroupFavorite('Music')).toBe(true);
    expect(ChannelCustomizationService.isGroupFavorite('Sports')).toBe(true);
    expect(ChannelCustomizationService.favoriteGroups).toEqual(['Sports', 'Music']);
    expect(ChannelCustomizationService.customized).toBe(true);
    expect(storageMock.setChannelCustomization).toHaveBeenCalled();

    // A manual reorder that puts Music ahead of Sports doesn't touch favorite order.
    ChannelCustomizationService.moveGroup(['Sports', 'Music', 'News'], 'Music', 'News', false);
    expect(ChannelCustomizationService.favoriteGroups).toEqual(['Sports', 'Music']);

    expect(ChannelCustomizationService.toggleGroupFavorite('Sports')).toBe(false);
    expect(ChannelCustomizationService.isGroupFavorite('Sports')).toBe(false);
    expect(ChannelCustomizationService.favoriteGroups).toEqual(['Music']);
  });

  it('assigns a channel to a folder without touching its group', () => {
    ChannelCustomizationService.assignFolder(KEY_A, 'Kids');
    expect(ChannelCustomizationService.folderFor(KEY_A)).toBe('Kids');
    expect(ChannelCustomizationService.customFolders).toEqual(['Kids']);
    // Still visible under its real (source) group — folders are additive.
    const channels = ChannelCustomizationService.applyTo(fixture());
    expect(channels[0].group).toBe('News');
    expect(channels[0].groupKey).toBeUndefined();
  });

  it('moving a channel to a new folder replaces any previous assignment', () => {
    ChannelCustomizationService.assignFolder(KEY_A, 'Kids');
    ChannelCustomizationService.assignFolder(KEY_A, 'Sports Picks');
    expect(ChannelCustomizationService.folderFor(KEY_A)).toBe('Sports Picks');
    expect(ChannelCustomizationService.customFolders).toEqual(['Kids', 'Sports Picks']);
  });

  it('removes a channel from its folder without touching its group', () => {
    ChannelCustomizationService.setGroup(KEY_A, 'Custom');
    ChannelCustomizationService.assignFolder(KEY_A, 'Kids');
    ChannelCustomizationService.removeFromFolder(KEY_A);
    expect(ChannelCustomizationService.folderFor(KEY_A)).toBeUndefined();
    // The group override, set independently, survives.
    expect(ChannelCustomizationService.applyTo(fixture())[0].group).toBe('Custom');
  });

  it('counts channels assigned to a folder', () => {
    expect(ChannelCustomizationService.folderOverrideCount('Kids')).toBe(0);
    ChannelCustomizationService.assignFolder(KEY_A, 'Kids');
    ChannelCustomizationService.assignFolder(KEY_B, 'Kids');
    expect(ChannelCustomizationService.folderOverrideCount('Kids')).toBe(2);
    expect(ChannelCustomizationService.folderOverrideCount('Sports')).toBe(0);
  });

  it('renames a folder without changing its key', () => {
    ChannelCustomizationService.addCustomFolder('Kids');
    ChannelCustomizationService.renameFolder('Kids', 'For the kids');
    expect(ChannelCustomizationService.folderLabel('Kids')).toBe('For the kids');
  });

  it('deletes a custom folder, clearing membership without touching channel groups', () => {
    ChannelCustomizationService.setGroup(KEY_A, 'Custom');
    ChannelCustomizationService.assignFolder(KEY_A, 'Kids');
    ChannelCustomizationService.assignFolder(KEY_B, 'Kids');
    ChannelCustomizationService.renameFolder('Kids', 'For the kids');
    expect(ChannelCustomizationService.customFolders).toEqual(['Kids']);

    ChannelCustomizationService.removeCustomFolder('Kids');

    expect(ChannelCustomizationService.customFolders).toEqual([]);
    expect(ChannelCustomizationService.folderOverrideCount('Kids')).toBe(0);
    expect(ChannelCustomizationService.folderFor(KEY_A)).toBeUndefined();
    expect(ChannelCustomizationService.folderFor(KEY_B)).toBeUndefined();
    expect(ChannelCustomizationService.folderLabel('Kids')).toBe('Kids'); // rename dropped
    // The channel explicitly moved to a real group is unaffected.
    expect(ChannelCustomizationService.applyTo(fixture())[0].group).toBe('Custom');
  });

  it('does nothing when asked to delete an unknown folder', () => {
    ChannelCustomizationService.removeCustomFolder('Nope');
    expect(ChannelCustomizationService.customFolders).toEqual([]);
  });

  it('migrates a legacy customGroups-based folder into the folder fields once', () => {
    // Kids/Custom have no match among the channels' real (source) groups —
    // they could only have been created via "New group", i.e. a folder.
    // Sports *is* a real source group (Charlie's) — Bravo was reassigned to
    // it the ordinary way, and that must be left alone, not folded in.
    const legacy = {
      version: CONFIG.CHANNEL_CUSTOMIZATION_VERSION,
      overrides: {
        [KEY_A]: { group: 'Kids' },
        [KEY_B]: { group: 'Sports' },
      },
      order: [],
      groupOrder: ['Kids', 'Sports', 'Custom'],
      groupOverrides: { Kids: { name: 'For the kids' } },
      customGroups: ['Kids', 'Sports', 'Custom'],
      favoriteGroups: ['Kids', 'Sports'],
    } as unknown as ChannelCustomization;
    storageMock.getChannelCustomization.mockReturnValue(legacy);
    ChannelCustomizationService.reload();

    // Migration needs real channel data, so it runs on the first applyTo —
    // not merely from reload()/a getter access.
    const channels = ChannelCustomizationService.applyTo(fixture(), true);

    expect(ChannelCustomizationService.customFolders.sort()).toEqual(['Custom', 'Kids']);
    expect(ChannelCustomizationService.customGroups).toEqual(['Sports']);
    expect(ChannelCustomizationService.folderFor(KEY_A)).toBe('Kids');
    expect(ChannelCustomizationService.folderFor(KEY_B)).toBeUndefined();
    expect(ChannelCustomizationService.overrideFor(KEY_B)?.group).toBe('Sports');
    expect(ChannelCustomizationService.folderLabel('Kids')).toBe('For the kids');
    // Alpha's old "move" is now a folder, so it reverts to its real group;
    // Bravo's real reassignment to Sports is untouched.
    expect(channels[0].group).toBe('News');
    expect(channels[1].group).toBe('Sports');
    expect(channels[2].group).toBe('Sports');
    // Group-only state follows the same split: dropped for the folder,
    // kept for the group that stayed real.
    expect(ChannelCustomizationService.isGroupFavorite('Kids')).toBe(false);
    expect(ChannelCustomizationService.isGroupFavorite('Sports')).toBe(true);
    expect(storageMock.setChannelCustomization).toHaveBeenCalled();
  });

  it('does not re-sweep a real group reassignment made after migration', () => {
    // Migration already ran; a later legitimate move-to-group reassignment
    // lands a key in customGroups again and must stay a group, not a folder.
    const migrated = {
      version: CONFIG.CHANNEL_CUSTOMIZATION_VERSION,
      overrides: {},
      order: [],
      groupOrder: [],
      groupOverrides: {},
      customGroups: [],
      favoriteGroups: [],
      customFolders: ['Kids'],
      folderOverrides: {},
      foldersMigrated: true,
    } as unknown as ChannelCustomization;
    storageMock.getChannelCustomization.mockReturnValue(migrated);
    ChannelCustomizationService.reload();

    ChannelCustomizationService.setGroup(KEY_A, 'Newly Real Group');
    expect(ChannelCustomizationService.customGroups).toEqual(['Newly Real Group']);

    // Simulate the next app load re-reading exactly what was just persisted.
    const persisted = storageMock.setChannelCustomization.mock.calls.at(-1)![0];
    storageMock.getChannelCustomization.mockReturnValue(persisted);
    ChannelCustomizationService.reload();

    expect(ChannelCustomizationService.customGroups).toEqual(['Newly Real Group']);
    expect(ChannelCustomizationService.customFolders).toEqual(['Kids']);
    expect(ChannelCustomizationService.folderFor(KEY_A)).toBeUndefined();
  });

  it('resets one channel and the whole record', () => {
    ChannelCustomizationService.rename(KEY_A, 'Alpha HD');
    ChannelCustomizationService.toggleHidden(KEY_B);
    ChannelCustomizationService.moveChannel([KEY_A, KEY_B, KEY_C], KEY_A, KEY_C, true);

    ChannelCustomizationService.resetChannel(KEY_A);
    expect(ChannelCustomizationService.overrideFor(KEY_A)).toBeNull();
    // Dropped from the order snapshot too, so it falls back behind the arranged block.
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Charlie', 'Alpha']);

    ChannelCustomizationService.reset();
    expect(storageMock.clearChannelCustomization).toHaveBeenCalled();
    expect(ChannelCustomizationService.customized).toBe(false);
    expect(names(ChannelCustomizationService.applyTo(fixture()))).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('reloads the record from storage', () => {
    ChannelCustomizationService.rename(KEY_A, 'Alpha HD');
    const saved = storageMock.setChannelCustomization.mock.calls[0][0] as ChannelCustomization;
    storageMock.getChannelCustomization.mockReturnValue(saved);
    ChannelCustomizationService.reload();
    expect(ChannelCustomizationService.applyTo(fixture())[0].name).toBe('Alpha HD');
  });
});
