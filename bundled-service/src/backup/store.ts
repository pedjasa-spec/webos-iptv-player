import { randomBytes } from 'crypto';
import { isSafeInteger } from '../compat';
import { objectValue } from '../setup/validation';

const TTL_MS = 10 * 60 * 1000;
const MAX_BYTES = 4 * 1024 * 1024;

interface Slot {
  token: string;
  data: string;
  expiresAt: number;
}

/**
 * A settings-backup blob can contain cleartext Xtream/subtitle-provider
 * passwords, so it is validated only shallowly here (the app owns the real
 * schema) and never touches disk -- restarting the service (which already
 * happens whenever the app backgrounds) wipes it along with everything else
 * in memory. Each direction (export/import) is a single slot guarded by its
 * own single-use, time-limited token, separate from the general setupToken:
 * reading an export or accepting an import immediately clears the slot, and
 * an untouched one expires after TTL_MS regardless.
 */
export function parseBackupPayload(raw: string): string {
  if (raw.length > MAX_BYTES) throw new Error('Backup payload too large');
  const parsed: unknown = JSON.parse(raw);
  const obj = objectValue(parsed);
  if (typeof obj.schemaVersion !== 'number' || !isSafeInteger(obj.schemaVersion)
      || obj.schemaVersion < 1) {
    throw new Error('Invalid backup payload');
  }
  return raw;
}

export class BackupStore {
  private exportSlot: Slot | null = null;
  private importSlot: Slot | null = null;

  /** TV stages a blob for the phone to download once. Returns the token. */
  stageExport(data: string): string {
    if (data.length > MAX_BYTES) throw new Error('Backup payload too large');
    const token = randomBytes(9).toString('hex');
    this.exportSlot = { token, data, expiresAt: Date.now() + TTL_MS };
    return token;
  }

  /** Phone downloads the staged export. Clears the slot on success. */
  takeExport(token: string): string | null {
    const slot = this.exportSlot;
    if (!slot || slot.token !== token || slot.expiresAt <= Date.now()) return null;
    this.exportSlot = null;
    return slot.data;
  }

  clearExport(): void {
    this.exportSlot = null;
  }

  /** TV opens a window for the phone to upload one backup into. Returns the token. */
  stageImportToken(): string {
    const token = randomBytes(9).toString('hex');
    this.importSlot = { token, data: '', expiresAt: Date.now() + TTL_MS };
    return token;
  }

  /** Phone uploads into the open window. False if the token is wrong/expired. */
  acceptImport(token: string, data: string): boolean {
    const slot = this.importSlot;
    if (!slot || slot.token !== token || slot.expiresAt <= Date.now()) return false;
    this.importSlot = { ...slot, data };
    return true;
  }

  /** TV pulls whatever the phone uploaded (loopback-only caller). */
  takeImport(): string | null {
    const slot = this.importSlot;
    if (!slot || !slot.data) return null;
    this.importSlot = null;
    return slot.data;
  }

  clearImport(): void {
    this.importSlot = null;
  }
}
