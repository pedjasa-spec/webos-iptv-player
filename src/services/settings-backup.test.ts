// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PlaylistEntry } from '../types';
import { StorageService } from './storage-service';
import { clearAllUserData, flushUserDataWrites, loadAllUserRecords } from './idb-user-data';
import { clearAllCachedData } from './idb-cache';
import { CONFIG } from '../config';
import {
  applyImportPayload,
  buildExportPayload,
  isNewerVersion,
  validateImportPayload,
  type SettingsBackupPayload,
} from './settings-backup';

const xtreamPlaylist = (): PlaylistEntry => ({
  id: 'p1',
  name: 'Provider',
  url: 'http://host:8080',
  source: 'xtream',
  xtream: {
    username: 'user1',
    password: 'secret',
    liveCategories: [{ id: '1', name: 'News', enabled: true }],
  },
});

describe('settings-backup', () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearAllUserData();
    await clearAllCachedData();
    // StorageService's user-data getters/setters fall back to localStorage
    // until init() populates its in-memory cache from IndexedDB -- required
    // here since applyImportPayload/buildExportPayload work at the
    // IndexedDB layer directly. init() itself is memoized process-wide, so
    // resetting the in-memory favorites through the real setter (rather
    // than relying on a fresh module load) is what actually isolates tests.
    await StorageService.init();
    StorageService.setFavorites([]);
    await flushUserDataWrites();
  });

  describe('buildExportPayload', () => {
    it('includes passwords and the live-category filter when requested', async () => {
      StorageService.setPlaylists([xtreamPlaylist()]);
      const payload = await buildExportPayload(true);
      expect(payload.includesPasswords).toBe(true);
      expect(payload.localStorage.iptv_playlists[0].xtream?.password).toBe('secret');
      expect(payload.localStorage.iptv_playlists[0].xtream?.liveCategories).toEqual([
        { id: '1', name: 'News', enabled: true },
      ]);
      expect(payload.appVersion).toBe(CONFIG.VERSION);
      expect(payload.schemaVersion).toBe(1);
    });

    it('redacts the Xtream password but keeps username and liveCategories when excluded', async () => {
      StorageService.setPlaylists([xtreamPlaylist()]);
      const payload = await buildExportPayload(false);
      expect(payload.includesPasswords).toBe(false);
      const xtream = payload.localStorage.iptv_playlists[0].xtream!;
      expect(xtream.password).toBe('');
      expect(xtream.username).toBe('user1');
      expect(xtream.liveCategories).toEqual([{ id: '1', name: 'News', enabled: true }]);
    });

    it('redacts online-subtitle credentials but keeps the preferred language', async () => {
      StorageService.setOnlineSubtitleConfig({
        preferredLanguage: 'en',
        subdl: { apiKey: 'k1' },
        assrt: { apiKey: 'k2' },
        opensubtitles: { apiKey: 'k3', username: 'u1', password: 'p1', token: 't1', tokenTs: 123 },
      });
      const payload = await buildExportPayload(false);
      const sub = payload.localStorage.iptv_online_subtitles;
      expect(sub.preferredLanguage).toBe('en');
      expect(sub.subdl.apiKey).toBe('');
      expect(sub.assrt.apiKey).toBe('');
      expect(sub.opensubtitles).toEqual({
        apiKey: '', username: 'u1', password: '', token: '', tokenTs: 0,
      });
    });
  });

  describe('isNewerVersion', () => {
    it('compares numerically, not textually', () => {
      expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
      expect(isNewerVersion('1.9.0', '1.10.0')).toBe(false);
      expect(isNewerVersion('1.9.0', '1.9.0')).toBe(false);
      expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
    });
  });

  describe('validateImportPayload', () => {
    it('accepts a well-formed payload and flags a newer appVersion', () => {
      const result = validateImportPayload({
        schemaVersion: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        appVersion: '99.0.0',
        includesPasswords: false,
        localStorage: {},
        userData: {},
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.appVersionNewer).toBe(true);
    });

    it('rejects a schemaVersion newer than this build understands', () => {
      const result = validateImportPayload({ schemaVersion: 99, localStorage: {}, userData: {} });
      expect(result).toEqual({ ok: false, reason: 'schema' });
    });

    it('rejects a payload missing localStorage/userData', () => {
      expect(validateImportPayload({ schemaVersion: 1 })).toEqual({ ok: false, reason: 'malformed' });
      expect(validateImportPayload(null)).toEqual({ ok: false, reason: 'malformed' });
      expect(validateImportPayload('nope')).toEqual({ ok: false, reason: 'malformed' });
    });
  });

  // applyImportPayload writes IndexedDB directly, bypassing StorageService's
  // in-memory user-data cache (only StorageService.init() populates it, and
  // there is no public re-sync) -- so these assert against raw storage
  // (localStorage.getItem / loadAllUserRecords), not StorageService's own
  // getters for the IndexedDB-backed half, matching the documented contract
  // that callers must force a reload to see personal-data changes reflected.
  describe('applyImportPayload', () => {
    it('replaces both preferences and personal data', async () => {
      StorageService.toggleFavorite('old-channel');
      StorageService.setTheme('old-theme');

      const payload = await buildExportPayload(true);
      payload.localStorage.iptv_theme = 'new-theme';
      payload.localStorage.iptv_playlists = [xtreamPlaylist()];
      payload.userData.favorites = [
        { key: 'favorite:new-channel', value: true, updatedAt: Date.now() },
      ];

      await applyImportPayload(payload);

      expect(StorageService.getTheme()).toBe('new-theme');
      expect(StorageService.getPlaylists()).toEqual([xtreamPlaylist()]);
      const records = await loadAllUserRecords();
      expect(records.favorites).toEqual([
        { key: 'favorite:new-channel', value: true, updatedAt: expect.any(Number) },
      ]);
    });

    it('rolls back both storage layers if the localStorage half fails partway through', async () => {
      StorageService.toggleFavorite('kept-channel');
      StorageService.setTheme('kept-theme');
      StorageService.setAutoPlay(true);

      const payload: SettingsBackupPayload = await buildExportPayload(true);
      payload.localStorage.iptv_theme = 'attempted-theme';
      payload.localStorage.iptv_auto_play = false;
      payload.userData.favorites = [
        { key: 'favorite:attempted-channel', value: true, updatedAt: Date.now() },
      ];

      const setAutoPlay = vi.spyOn(StorageService, 'setAutoPlay')
        .mockImplementationOnce(() => { throw new Error('boom'); });

      await expect(applyImportPayload(payload)).rejects.toThrow('boom');

      expect(StorageService.getTheme()).toBe('kept-theme');
      expect(StorageService.getAutoPlay()).toBe(true);
      const records = await loadAllUserRecords();
      expect(records.favorites.map(r => r.key)).toEqual(['favorite:kept-channel']);

      setAutoPlay.mockRestore();
    });
  });
});
