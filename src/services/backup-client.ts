import { fetchWithTimeout } from '../utils/fetch-helper';
import { createLogger } from '../utils/logger';
import { serviceBase } from './service-http';

const log = createLogger('Backup');
const TIMEOUT = 4000;

class BackupClientImpl {
  /** Stage a backup blob for the phone to download once. Returns the
   *  single-use token (for the /backup?token=... download URL), or null if
   *  the service is unreachable or rejected the payload. */
  async stageExport(payload: string): Promise<string | null> {
    const base = serviceBase();
    if (!base) {
      log.debug('stageExport skipped: service port not yet known');
      return null;
    }
    try {
      const res = await fetchWithTimeout(`${base}/backup`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      }, TIMEOUT);
      if (!res.ok) {
        log.warn('stageExport: HTTP', res.status);
        return null;
      }
      const data = (await res.json()) as { token: string };
      return data.token;
    } catch (e) {
      log.warn('stageExport failed:', e);
      return null;
    }
  }

  /** Open a one-shot upload window for a phone-submitted backup. Returns
   *  the token (for the /setup?...&backup=... QR link), or null. */
  async openImportWindow(): Promise<string | null> {
    const base = serviceBase();
    if (!base) {
      log.debug('openImportWindow skipped: service port not yet known');
      return null;
    }
    try {
      const res = await fetchWithTimeout(`${base}/backup-import-token`, { method: 'POST' }, TIMEOUT);
      if (!res.ok) {
        log.warn('openImportWindow: HTTP', res.status);
        return null;
      }
      const data = (await res.json()) as { token: string };
      return data.token;
    } catch (e) {
      log.warn('openImportWindow failed:', e);
      return null;
    }
  }

  /** Poll for a phone-submitted backup. Returns the raw JSON text, or null
   *  if nothing has been uploaded (yet, or the service is unreachable). */
  async fetchPendingImport(): Promise<string | null> {
    const base = serviceBase();
    if (!base) return null;
    try {
      const res = await fetchWithTimeout(`${base}/backup-import`, {}, TIMEOUT);
      if (!res.ok) return null;
      return await res.text();
    } catch (e) {
      log.debug('fetchPendingImport failed (service likely not running):', e);
      return null;
    }
  }

  /** Drop a pending upload, whether it was applied, rejected, or the user
   *  cancelled -- so a stale backup never resurfaces on the next check. */
  async clearPendingImport(): Promise<void> {
    const base = serviceBase();
    if (!base) return;
    try {
      const res = await fetchWithTimeout(`${base}/backup-import`, { method: 'DELETE' }, TIMEOUT);
      if (!res.ok) log.warn('clearPendingImport: HTTP', res.status);
    } catch (e) {
      log.warn('clearPendingImport failed:', e);
    }
  }
}

export const BackupClient = new BackupClientImpl();
