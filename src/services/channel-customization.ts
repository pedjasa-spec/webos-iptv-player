import type { Channel, ChannelCustomization, ChannelOverride, GroupOverride } from '../types';
import { channelKey } from '../utils/channel';
import { createLogger } from '../utils/logger';
import { CONFIG } from '../config';
import { StorageService } from './storage-service';

const log = createLogger('ChannelCustom');

function emptyRecord(): ChannelCustomization {
  return {
    version: CONFIG.CHANNEL_CUSTOMIZATION_VERSION,
    overrides: {},
    order: [],
    groupOrder: [],
    groupOverrides: {},
    customGroups: [],
    favoriteGroups: [],
    customFolders: [],
    folderOverrides: {},
    // A fresh record has nothing to migrate.
    foldersMigrated: true,
  };
}

/**
 * Local channel customization: reorder, hide, rename, regroup, and correct EPG
 * matching or timing without touching the source playlists.
 *
 * Everything is keyed by `channelKey(ch)` (per stream) and by a
 * group key (the source group name, or a user-created one), so a provider
 * reordering or renaming channels never re-points a customization.
 */
class ChannelCustomizationServiceImpl {
  private data: ChannelCustomization | null = null;

  private get record(): ChannelCustomization {
    if (!this.data) {
      this.data = StorageService.getChannelCustomization() ?? emptyRecord();
      // Defensive: a record from before these fields existed lacks them
      // outright — every reader below relies on them always being set.
      if (!this.data.favoriteGroups) this.data.favoriteGroups = [];
      if (!this.data.customFolders) this.data.customFolders = [];
      if (!this.data.folderOverrides) this.data.folderOverrides = {};
    }
    return this.data;
  }

  /**
   * One-time: folders used to be plain custom groups (`customGroups` /
   * `ov.group`) that *moved* a channel out of its source group. Move every
   * such entry into the structurally separate `customFolders` / `ov.folder`
   * fields so folder membership becomes additive instead.
   *
   * `customGroups` also carries a second, unrelated case: the "move to
   * group" picker lists every real (source) group as a target too, and
   * reassigning to one of those adds it here the same way a folder does.
   * Those aren't folders — they're ordinary group reassignments — so a key
   * that matches a real group among `channels` is left exactly as-is; only
   * a key with no matching real group (which could only have been created
   * through "New group", i.e. a folder) is migrated. Requires a channel
   * list, so this runs from `applyTo`, not from `record`. `foldersMigrated`
   * makes it one-time, so a later legitimate reassignment that adds a real
   * group key back into `customGroups` is never swept in.
   */
  private migrateFolders(channels: Channel[]): void {
    const d = this.data!;
    if (d.foldersMigrated) return;
    d.foldersMigrated = true;
    if (d.customGroups.length === 0) {
      this.persist();
      return;
    }
    const realGroupKeys = new Set(channels.map((ch) => ch.sourceGroup ?? ch.group));
    const migratedKeys = new Set(d.customGroups.filter((key) => !realGroupKeys.has(key)));
    if (migratedKeys.size === 0) {
      this.persist();
      return;
    }
    for (const groupKey of migratedKeys) {
      if (!d.customFolders.includes(groupKey)) d.customFolders.push(groupKey);
      const ov = d.groupOverrides[groupKey];
      if (ov) {
        d.folderOverrides[groupKey] = ov;
        delete d.groupOverrides[groupKey];
      }
    }
    d.customGroups = d.customGroups.filter((key) => !migratedKeys.has(key));
    d.groupOrder = d.groupOrder.filter((key) => !migratedKeys.has(key));
    d.favoriteGroups = d.favoriteGroups.filter((key) => !migratedKeys.has(key));
    for (const key in d.overrides) {
      const ov = d.overrides[key];
      if (ov.group === undefined || !migratedKeys.has(ov.group)) continue;
      ov.folder = ov.group;
      delete ov.group;
    }
    this.persist();
    log.info('Migrated legacy custom groups to folders', 'event=folders.migrated');
  }

  private persist(): void {
    if (this.data) StorageService.setChannelCustomization(this.data);
  }

  /** Drop the memoized record so the next read comes from storage. */
  reload(): void {
    this.data = null;
  }

  /** False when nothing has been customized — the untouched-install fast path. */
  get customized(): boolean {
    const d = this.record;
    return d.order.length > 0
      || d.groupOrder.length > 0
      || d.customGroups.length > 0
      || d.favoriteGroups.length > 0
      || d.customFolders.length > 0
      || Object.keys(d.overrides).length > 0
      || Object.keys(d.groupOverrides).length > 0
      || Object.keys(d.folderOverrides).length > 0;
  }

  reset(): void {
    this.data = emptyRecord();
    StorageService.clearChannelCustomization();
    log.info('Customization reset');
  }

  // --- Per-channel state

  overrideFor(key: string): ChannelOverride | null {
    return this.record.overrides[key] ?? null;
  }

  epgChannelIds(): string[] {
    const ids: string[] = [];
    for (const key in this.record.overrides) {
      const id = this.record.overrides[key].epgChannelId;
      if (id) ids.push(id);
    }
    return ids;
  }

  isHidden(key: string): boolean {
    return this.record.overrides[key]?.hidden === true;
  }

  /** True when the channel is hidden itself or sits in a hidden group. */
  isChannelHidden(ch: Channel): boolean {
    return this.isHidden(channelKey(ch)) || this.isGroupHidden(groupKeyOf(ch));
  }

  toggleHidden(key: string): boolean {
    const hidden = !this.isHidden(key);
    this.mutate(key, (ov) => { ov.hidden = hidden; });
    return hidden;
  }

  /** An empty name clears the rename and restores the source name. */
  rename(key: string, name: string): void {
    const trimmed = name.trim();
    this.mutate(key, (ov) => {
      if (trimmed) ov.name = trimmed;
      else delete ov.name;
    });
  }

  /** An empty group key clears the assignment and restores the source group. */
  setGroup(key: string, groupKey: string): void {
    const trimmed = groupKey.trim();
    this.mutate(key, (ov) => {
      if (trimmed) ov.group = trimmed;
      else delete ov.group;
    });
    if (trimmed) this.addCustomGroup(trimmed);
  }

  /** An empty id restores automatic EPG matching. */
  setEpgChannel(key: string, epgChannelId: string): void {
    const trimmed = epgChannelId.trim();
    const previous = this.overrideFor(key)?.epgChannelId ?? '';
    this.mutate(key, (ov) => {
      if (trimmed) ov.epgChannelId = trimmed;
      else delete ov.epgChannelId;
    });
    if (trimmed === previous) return;
    log.info(
      trimmed ? 'EPG mapping set' : 'EPG mapping cleared',
      `event=epg.mapping.${trimmed ? 'set' : 'cleared'}`,
    );
  }

  /** A null or zero delta restores the correction configured for the EPG source. */
  setEpgOffsetDelta(key: string, minutes: number | null): void {
    this.mutate(key, (ov) => {
      if (minutes === null || !Number.isFinite(minutes) || minutes === 0) {
        delete ov.epgOffsetDeltaMinutes;
        return;
      }
      ov.epgOffsetDeltaMinutes = Math.max(
        -CONFIG.EPG.OFFSET_MAX_MINUTES * 2,
        Math.min(CONFIG.EPG.OFFSET_MAX_MINUTES * 2, Math.round(minutes)),
      );
    });
  }

  /** Clear every customization of one channel. */
  resetChannel(key: string): void {
    delete this.record.overrides[key];
    this.record.order = this.record.order.filter((k) => k !== key);
    this.persist();
  }

  // --- Group state

  isGroupHidden(groupKey: string): boolean {
    return this.record.groupOverrides[groupKey]?.hidden === true;
  }

  groupLabel(groupKey: string): string {
    return this.record.groupOverrides[groupKey]?.name || groupKey;
  }

  toggleGroupHidden(groupKey: string): boolean {
    const hidden = !this.isGroupHidden(groupKey);
    this.mutateGroup(groupKey, (ov) => { ov.hidden = hidden; });
    return hidden;
  }

  renameGroup(groupKey: string, name: string): void {
    const trimmed = name.trim();
    this.mutateGroup(groupKey, (ov) => {
      if (trimmed && trimmed !== groupKey) ov.name = trimmed;
      else delete ov.name;
    });
  }

  get customGroups(): string[] {
    return this.record.customGroups.slice();
  }

  addCustomGroup(name: string): void {
    const trimmed = name.trim();
    if (!trimmed || this.record.customGroups.includes(trimmed)) return;
    this.record.customGroups.push(trimmed);
    this.persist();
  }

  /** Channels explicitly assigned to `groupKey` via an override — the only way
   *  a channel ever ends up in a user-created folder, so this is that folder's
   *  full membership count (unlike a source group, which also has members with
   *  no override at all). Used to size a delete confirmation. */
  groupOverrideCount(groupKey: string): number {
    let count = 0;
    for (const key in this.record.overrides) {
      if (this.record.overrides[key].group === groupKey) count++;
    }
    return count;
  }

  /**
   * Delete a user-created folder: every channel assigned to it falls back to
   * its source group (the override is cleared, not the channel), its rename/
   * hidden state is dropped, and stale references in the order/favorite lists
   * go with it. A no-op for a real (provider) group — those aren't
   * user-created and this never removes one.
   */
  removeCustomGroup(groupKey: string): void {
    const at = this.record.customGroups.indexOf(groupKey);
    if (at < 0) return;
    this.record.customGroups.splice(at, 1);
    delete this.record.groupOverrides[groupKey];
    this.record.groupOrder = this.record.groupOrder.filter((key) => key !== groupKey);
    this.record.favoriteGroups = this.record.favoriteGroups.filter((key) => key !== groupKey);
    for (const key in this.record.overrides) {
      const ov = this.record.overrides[key];
      if (ov.group !== groupKey) continue;
      delete ov.group;
      if (isEmpty(ov)) delete this.record.overrides[key];
    }
    this.persist();
  }

  /** Rank of a group key in the custom order; unlisted groups keep discovery order. */
  groupRank(groupKey: string, discoveryIndex: number): number {
    const at = this.record.groupOrder.indexOf(groupKey);
    return at >= 0 ? at : this.record.groupOrder.length + discoveryIndex;
  }

  // --- Favorite groups
  //
  // Independent of `groupOrder` (manual drag reorder, above): a favorited
  // group floats to the top of the sidebar regardless of its position there.
  // Order here is mark-order, not display position.

  isGroupFavorite(groupKey: string): boolean {
    return this.record.favoriteGroups.includes(groupKey);
  }

  get favoriteGroups(): string[] {
    return this.record.favoriteGroups.slice();
  }

  toggleGroupFavorite(groupKey: string): boolean {
    const favorites = this.record.favoriteGroups;
    const at = favorites.indexOf(groupKey);
    const favorited = at < 0;
    if (favorited) favorites.push(groupKey);
    else favorites.splice(at, 1);
    this.persist();
    return favorited;
  }

  // --- Folders
  //
  // Additive visibility, unlike `group`: assigning a channel to a folder never
  // changes which (real) group it belongs to, so it stays visible in both. A
  // channel sits in at most one folder — assigning a new one replaces the old.

  /** The folder key a channel is assigned to, or undefined if none. */
  folderFor(key: string): string | undefined {
    return this.record.overrides[key]?.folder;
  }

  get customFolders(): string[] {
    return this.record.customFolders.slice();
  }

  folderLabel(folderKey: string): string {
    return this.record.folderOverrides[folderKey]?.name || folderKey;
  }

  /** Create a folder if it doesn't already exist; a no-op otherwise. */
  addCustomFolder(name: string): void {
    const trimmed = name.trim();
    if (!trimmed || this.record.customFolders.includes(trimmed)) return;
    this.record.customFolders.push(trimmed);
    this.persist();
  }

  /** An empty folder key removes the channel from its folder without
   *  touching its group. A non-empty key replaces any previous assignment
   *  and creates the folder if it's new. */
  assignFolder(key: string, folderKey: string): void {
    const trimmed = folderKey.trim();
    this.mutate(key, (ov) => {
      if (trimmed) ov.folder = trimmed;
      else delete ov.folder;
    });
    if (trimmed) this.addCustomFolder(trimmed);
  }

  /** Remove a channel from its folder, if any. Its group is untouched. */
  removeFromFolder(key: string): void {
    this.assignFolder(key, '');
  }

  renameFolder(folderKey: string, name: string): void {
    const trimmed = name.trim();
    this.mutateFolder(folderKey, (ov) => {
      if (trimmed && trimmed !== folderKey) ov.name = trimmed;
      else delete ov.name;
    });
  }

  /** Channels assigned to `folderKey` — this folder's full membership count,
   *  used to size a delete confirmation. */
  folderOverrideCount(folderKey: string): number {
    let count = 0;
    for (const key in this.record.overrides) {
      if (this.record.overrides[key].folder === folderKey) count++;
    }
    return count;
  }

  /**
   * Delete a user-created folder: every channel assigned to it is removed
   * from the folder (its group is never touched), its rename state is
   * dropped. A no-op for an unknown key.
   */
  removeCustomFolder(folderKey: string): void {
    const at = this.record.customFolders.indexOf(folderKey);
    if (at < 0) return;
    this.record.customFolders.splice(at, 1);
    delete this.record.folderOverrides[folderKey];
    for (const key in this.record.overrides) {
      const ov = this.record.overrides[key];
      if (ov.folder !== folderKey) continue;
      delete ov.folder;
      if (isEmpty(ov)) delete this.record.overrides[key];
    }
    this.persist();
  }

  // --- Reordering
  //
  // `order` is a snapshot list written on the first move: it holds the effective
  // order at that moment. Anything not listed keeps its relative source order
  // after the customized block, so channels appearing in a later refresh never
  // displace what the user arranged.

  moveChannel(effectiveOrder: string[], key: string, targetKey: string, after: boolean): void {
    this.record.order = reorder(effectiveOrder, key, targetKey, after);
    this.persist();
  }

  moveGroup(effectiveOrder: string[], groupKey: string, targetKey: string, after: boolean): void {
    this.record.groupOrder = reorder(effectiveOrder, groupKey, targetKey, after);
    this.persist();
  }

  // --- Application

  /**
   * Apply the customization to parsed channels, returning the visible list in
   * effective order. Mutates each channel's display fields in place and keeps
   * the source values on `sourceName` / `sourceGroup`, so repeated calls are
   * idempotent and clearing an override restores the source value.
   */
  applyTo(channels: Channel[], includeHidden = false): Channel[] {
    const d = this.record;
    if (!d.foldersMigrated) this.migrateFolders(channels);
    const rank = new Map<string, number>();
    for (let i = 0; i < d.order.length; i++) rank.set(d.order[i], i);

    const kept: { ch: Channel; rank: number; index: number }[] = [];
    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];
      const key = channelKey(ch);
      const ov = d.overrides[key];

      const srcName = ch.sourceName ?? ch.name;
      const srcGroup = ch.sourceGroup ?? ch.group;
      const gKey = ov?.group ?? srcGroup;
      const label = d.groupOverrides[gKey]?.name || gKey;

      ch.name = ov?.name || srcName;
      if (ch.name !== srcName) ch.sourceName = srcName; else delete ch.sourceName;
      ch.group = label;
      if (label !== srcGroup) ch.sourceGroup = srcGroup; else delete ch.sourceGroup;
      if (label !== gKey) ch.groupKey = gKey; else delete ch.groupKey;

      const hidden = ov?.hidden === true || d.groupOverrides[gKey]?.hidden === true;
      if (hidden && !includeHidden) continue;
      kept.push({ ch, rank: rank.get(key) ?? d.order.length + i, index: i });
    }

    // Legacy Chromium sort is not stable — the index tiebreak keeps it deterministic.
    kept.sort((a, b) => a.rank - b.rank || a.index - b.index);
    return kept.map((entry) => entry.ch);
  }

  /** Sort group keys into the effective group order. */
  sortGroupKeys(groupKeys: string[]): string[] {
    return groupKeys
      .map((key, index) => ({ key, rank: this.groupRank(key, index), index }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.key);
  }

  private mutate(key: string, fn: (ov: ChannelOverride) => void): void {
    if (!key) return;
    const ov = this.record.overrides[key] ?? {};
    fn(ov);
    if (isEmpty(ov)) delete this.record.overrides[key];
    else this.record.overrides[key] = ov;
    this.persist();
  }

  private mutateGroup(groupKey: string, fn: (ov: GroupOverride) => void): void {
    if (!groupKey) return;
    const ov = this.record.groupOverrides[groupKey] ?? {};
    fn(ov);
    if (isEmpty(ov)) delete this.record.groupOverrides[groupKey];
    else this.record.groupOverrides[groupKey] = ov;
    this.persist();
  }

  private mutateFolder(folderKey: string, fn: (ov: GroupOverride) => void): void {
    if (!folderKey) return;
    const ov = this.record.folderOverrides[folderKey] ?? {};
    fn(ov);
    if (isEmpty(ov)) delete this.record.folderOverrides[folderKey];
    else this.record.folderOverrides[folderKey] = ov;
    this.persist();
  }
}

function isEmpty(ov: ChannelOverride | GroupOverride): boolean {
  for (const k in ov) {
    const value = (ov as Record<string, unknown>)[k];
    if (value !== undefined && value !== false) return false;
  }
  return true;
}

/** Move `key` next to `targetKey` inside `list`, returning a new snapshot. */
function reorder(list: string[], key: string, targetKey: string, after: boolean): string[] {
  const next = list.filter((k) => k !== key);
  const at = next.indexOf(targetKey);
  if (at < 0) return list.slice();
  next.splice(after ? at + 1 : at, 0, key);
  return next;
}

/** The customization key of a channel's effective group. */
export function groupKeyOf(ch: Channel): string {
  return ch.groupKey ?? ch.group;
}

export const ChannelCustomizationService = new ChannelCustomizationServiceImpl();
