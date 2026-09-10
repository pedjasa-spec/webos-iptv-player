import { describe, it, expect, vi, afterEach } from 'vitest';
import { BackupStore, parseBackupPayload } from './store';

afterEach(() => {
  vi.useRealTimers();
});

describe('parseBackupPayload', () => {
  it('accepts a payload with a positive integer schemaVersion', () => {
    const raw = JSON.stringify({ schemaVersion: 1, hello: 'world' });
    expect(parseBackupPayload(raw)).toBe(raw);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseBackupPayload('{not json')).toThrow();
  });

  it('rejects a non-object payload', () => {
    expect(() => parseBackupPayload('[1,2,3]')).toThrow();
  });

  it('rejects a missing or non-integer schemaVersion', () => {
    expect(() => parseBackupPayload(JSON.stringify({}))).toThrow();
    expect(() => parseBackupPayload(JSON.stringify({ schemaVersion: 1.5 }))).toThrow();
    expect(() => parseBackupPayload(JSON.stringify({ schemaVersion: 0 }))).toThrow();
    expect(() => parseBackupPayload(JSON.stringify({ schemaVersion: '1' }))).toThrow();
  });

  it('rejects an oversized payload', () => {
    const huge = JSON.stringify({ schemaVersion: 1, pad: 'x'.repeat(5 * 1024 * 1024) });
    expect(() => parseBackupPayload(huge)).toThrow();
  });
});

describe('BackupStore export', () => {
  it('returns the staged data for the matching token, then clears it', () => {
    const store = new BackupStore();
    const token = store.stageExport('{"a":1}');
    expect(store.takeExport(token)).toBe('{"a":1}');
    expect(store.takeExport(token)).toBeNull();
  });

  it('rejects the wrong token', () => {
    const store = new BackupStore();
    store.stageExport('{"a":1}');
    expect(store.takeExport('wrong-token')).toBeNull();
  });

  it('expires after 10 minutes even if never taken', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new BackupStore();
    const token = store.stageExport('{"a":1}');
    vi.setSystemTime(10 * 60 * 1000 + 1);
    expect(store.takeExport(token)).toBeNull();
  });

  it('clearExport drops a staged blob before it is ever taken', () => {
    const store = new BackupStore();
    const token = store.stageExport('{"a":1}');
    store.clearExport();
    expect(store.takeExport(token)).toBeNull();
  });

  it('rejects staging a payload over the size limit', () => {
    const store = new BackupStore();
    expect(() => store.stageExport('x'.repeat(5 * 1024 * 1024))).toThrow();
  });
});

describe('BackupStore import', () => {
  it('accepts an upload for the matching token and hands it back once', () => {
    const store = new BackupStore();
    const token = store.stageImportToken();
    expect(store.acceptImport(token, '{"b":2}')).toBe(true);
    expect(store.takeImport()).toBe('{"b":2}');
    expect(store.takeImport()).toBeNull();
  });

  it('rejects an upload for the wrong token', () => {
    const store = new BackupStore();
    store.stageImportToken();
    expect(store.acceptImport('wrong-token', '{"b":2}')).toBe(false);
    expect(store.takeImport()).toBeNull();
  });

  it('expires the upload window after 10 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new BackupStore();
    const token = store.stageImportToken();
    vi.setSystemTime(10 * 60 * 1000 + 1);
    expect(store.acceptImport(token, '{"b":2}')).toBe(false);
  });

  it('clearImport drops an uploaded blob before the TV ever pulls it', () => {
    const store = new BackupStore();
    const token = store.stageImportToken();
    store.acceptImport(token, '{"b":2}');
    store.clearImport();
    expect(store.takeImport()).toBeNull();
  });
});
