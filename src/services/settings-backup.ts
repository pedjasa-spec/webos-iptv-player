import { CONFIG } from '../config';
import type { PlaylistEntry, TzMode } from '../types';
import type { LocalePreference } from '../i18n';
import type { OverlayStyle, TextSize } from '../config/themes';
import type { OnlineSubtitleConfig } from './subtitle-search/types';
import { StorageService } from './storage-service';
import { loadAllUserRecords, replaceAllUserData, type UserDataRecord } from './idb-user-data';
import type { UserDataStore } from './idb-database';
import { createLogger } from '../utils/logger';

const log = createLogger('SettingsBackup');

/** Bumped only when the shape below changes incompatibly. A file with a
 *  higher schemaVersion than this build understands is rejected outright. */
export const BACKUP_SCHEMA_VERSION = 1;

export interface SettingsBackupLocalStorage {
  iptv_playlists: PlaylistEntry[];
  iptv_epg_url: string;
  iptv_last_channel: number;
  iptv_last_channel_key: string;
  iptv_selectedXtream: string | null;
  iptv_show_hidden_channels: boolean;
  iptv_auto_play: boolean;
  iptv_locale: LocalePreference;
  iptv_theme: string;
  iptv_text_size: TextSize;
  iptv_overlay_style: OverlayStyle;
  iptv_tz_mode: TzMode;
  iptv_epg_tz_offset: number | null;
  iptv_epg_offsets: Record<string, number>;
  iptv_online_subtitles: OnlineSubtitleConfig;
}

export interface SettingsBackupPayload {
  schemaVersion: number;
  exportedAt: string;
  appVersion: string;
  includesPasswords: boolean;
  localStorage: SettingsBackupLocalStorage;
  userData: Record<UserDataStore, UserDataRecord[]>;
}

function snapshotLocalStorage(): SettingsBackupLocalStorage {
  return {
    iptv_playlists: StorageService.getPlaylists(),
    iptv_epg_url: StorageService.getEpgUrl(),
    iptv_last_channel: StorageService.getLastChannel(),
    iptv_last_channel_key: StorageService.getLastChannelKey(),
    iptv_selectedXtream: StorageService.getSelectedXtreamAccountId(),
    iptv_show_hidden_channels: StorageService.getShowHiddenChannels(),
    iptv_auto_play: StorageService.getAutoPlay(),
    iptv_locale: StorageService.getLocalePreference(),
    iptv_theme: StorageService.getTheme(),
    iptv_text_size: StorageService.getTextSize(),
    iptv_overlay_style: StorageService.getOverlayStyle(),
    iptv_tz_mode: StorageService.getTzMode(),
    iptv_epg_tz_offset: StorageService.getEpgTzOffset(),
    iptv_epg_offsets: StorageService.getEpgOffsets(),
    iptv_online_subtitles: StorageService.getOnlineSubtitleConfig(),
  };
}

// Xtream account passwords and online-subtitle provider credentials are the
// only cleartext secrets in "Setup and preferences" -- the category filter
// (liveCategories) lives alongside the Xtream password but is untouched here.
function redactPasswords(ls: SettingsBackupLocalStorage): SettingsBackupLocalStorage {
  return {
    ...ls,
    iptv_playlists: ls.iptv_playlists.map((pl): PlaylistEntry =>
      pl.xtream ? { ...pl, xtream: { ...pl.xtream, password: '' } } : pl),
    iptv_online_subtitles: {
      ...ls.iptv_online_subtitles,
      subdl: { ...ls.iptv_online_subtitles.subdl, apiKey: '' },
      assrt: { ...ls.iptv_online_subtitles.assrt, apiKey: '' },
      opensubtitles: {
        ...ls.iptv_online_subtitles.opensubtitles,
        apiKey: '',
        password: '',
        token: '',
        tokenTs: 0,
      },
    },
  };
}

/** Cache and LAN-uploaded playlist files are deliberately excluded -- both
 *  are re-derivable, matching the app's own "Downloaded cache" category. */
export async function buildExportPayload(includePasswords: boolean): Promise<SettingsBackupPayload> {
  const localStorageValues = snapshotLocalStorage();
  const userData = await loadAllUserRecords();
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: CONFIG.VERSION,
    includesPasswords: includePasswords,
    localStorage: includePasswords ? localStorageValues : redactPasswords(localStorageValues),
    userData,
  };
}

function parseVersionParts(version: string): number[] {
  return version.split('.').map(part => parseInt(part, 10) || 0);
}

/** True if `a` is a strictly newer semver than `b` (numeric, not textual --
 *  "1.9.0" must not read as newer than "1.10.0"). */
export function isNewerVersion(a: string, b: string): boolean {
  const partsA = parseVersionParts(a);
  const partsB = parseVersionParts(b);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i] ?? 0;
    const y = partsB[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export type ImportValidation =
  | { ok: true; payload: SettingsBackupPayload; appVersionNewer: boolean }
  | { ok: false; reason: 'schema' | 'malformed' };

/** Only checks what's needed to decide whether the file is safe to apply at
 *  all -- schemaVersion is a hard gate, appVersion only informs a warning. */
export function validateImportPayload(raw: unknown): ImportValidation {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'malformed' };
  const obj = raw as Partial<SettingsBackupPayload>;
  if (typeof obj.schemaVersion !== 'number' || !Number.isFinite(obj.schemaVersion)
      || obj.schemaVersion > BACKUP_SCHEMA_VERSION) {
    return { ok: false, reason: 'schema' };
  }
  if (!obj.localStorage || typeof obj.localStorage !== 'object'
      || !obj.userData || typeof obj.userData !== 'object') {
    return { ok: false, reason: 'malformed' };
  }
  const appVersionNewer = typeof obj.appVersion === 'string'
    && isNewerVersion(obj.appVersion, CONFIG.VERSION);
  return { ok: true, payload: obj as SettingsBackupPayload, appVersionNewer };
}

function writeLocalStorage(ls: SettingsBackupLocalStorage): void {
  StorageService.setPlaylists(ls.iptv_playlists);
  StorageService.setEpgUrl(ls.iptv_epg_url);
  StorageService.setLastChannel(ls.iptv_last_channel);
  StorageService.setLastChannelKey(ls.iptv_last_channel_key);
  if (ls.iptv_selectedXtream) StorageService.setSelectedXtreamAccountId(ls.iptv_selectedXtream);
  StorageService.setShowHiddenChannels(ls.iptv_show_hidden_channels);
  StorageService.setAutoPlay(ls.iptv_auto_play);
  StorageService.setLocalePreference(ls.iptv_locale);
  StorageService.setTheme(ls.iptv_theme);
  StorageService.setTextSize(ls.iptv_text_size);
  StorageService.setOverlayStyle(ls.iptv_overlay_style);
  StorageService.setTzMode(ls.iptv_tz_mode);
  if (ls.iptv_epg_tz_offset !== null) StorageService.setEpgTzOffset(ls.iptv_epg_tz_offset);
  StorageService.setEpgOffsets(ls.iptv_epg_offsets);
  StorageService.setOnlineSubtitleConfig(ls.iptv_online_subtitles);
}

/**
 * Replaces every setting/personal-data record with the imported ones.
 * Neither storage layer can share one platform transaction, so this is a
 * best-effort all-or-nothing: snapshot first, apply the IndexedDB half
 * (already atomic as one transaction, so it either fully lands or leaves
 * IndexedDB untouched on its own), then the localStorage half. If the
 * second half throws, both halves are restored from the snapshot so the
 * end state is always fully old or fully new, never a mix.
 *
 * This writes storage directly and does not go through StorageService's
 * in-memory user-data cache (favorites/reminders/channel-state/etc.), which
 * is only populated once at StorageService.init() and has no public re-sync
 * method. The caller MUST force a full reload after a successful import
 * (matching the existing "reset app" flow) so that cache -- and everything
 * else derived from it -- picks up the new data; reading it back through
 * StorageService before that reload returns stale values.
 */
export async function applyImportPayload(payload: SettingsBackupPayload): Promise<void> {
  const previousLocalStorage = snapshotLocalStorage();
  const previousUserData = await loadAllUserRecords();

  await replaceAllUserData(payload.userData);

  try {
    writeLocalStorage(payload.localStorage);
  } catch (err) {
    log.error(
      'Import failed while writing preferences; rolling back',
      'event=backup.import.failed',
      'operation=local_storage',
      err,
    );
    try {
      writeLocalStorage(previousLocalStorage);
      await replaceAllUserData(previousUserData);
    } catch (rollbackErr) {
      log.error(
        'Rollback after a failed import also failed',
        'event=backup.import.rollback_failed',
        'operation=rollback',
        rollbackErr,
      );
    }
    throw err;
  }
}
