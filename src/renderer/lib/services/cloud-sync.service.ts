import { PlatformDetector } from '@shared/platform';
import type { ExportResult, ImportResult } from '@shared/types/data-management';
import type { CloudStorageConfig } from '@shared/types/cloud-backup';
import type {
  CloudSyncConflict,
  CloudSyncDataSet,
  CloudSyncMergeOptions,
  CloudSyncMergeSummary,
  CloudSyncSnapshot
} from '@shared/cloud-sync-engine';
import {
  applyCloudSyncTombstones,
  createCloudSyncSnapshot,
  mergeCloudSyncData
} from '@shared/cloud-sync-engine';
import type { CloudSyncManifest } from '@shared/cloud-sync-manifest';
import {
  createEmptyCloudSyncManifest,
  updateCloudSyncManifestDevice
} from '@shared/cloud-sync-manifest';
import { generateUUID } from '../utils/uuid';
import { CloudBackupAPI } from '../api/cloud-backup.api';
import { DatabaseServiceManager } from './database-manager.service';
import { mobileCloudBackupService } from './mobile-cloud-backup.service';
import type { DataChangeEventPayload, DataStoreName } from './data-change-events';
import { onDataChange } from './data-change-events';

const DEVICE_ID_STORAGE_KEY = 'ai_gist_cloud_sync_device_id';
const LOCAL_STATE_STORAGE_PREFIX = 'ai_gist_cloud_sync_state';
const DEFAULT_AUTO_SYNC_DEBOUNCE_MS = 3000;
const DEFAULT_AUTO_SYNC_RETRY_MS = 30000;
const DEFAULT_REMOTE_POLL_INTERVAL_MS = 30000;
const SYNC_STORE_NAMES: DataStoreName[] = [
  'categories',
  'prompts',
  'promptVariables',
  'promptHistories',
  'ai_configs',
  'ai_generation_history',
  'settings',
  'syncTombstones'
];

export type CloudSyncAction = 'uploaded' | 'downloaded' | 'merged' | 'noop';
export type CloudSyncRunReason =
  | 'startup'
  | 'local-change'
  | 'manual'
  | 'interval'
  | 'online'
  | 'focus'
  | 'config-change'
  | 'retry';
export type CloudSyncLifecycleStatus = 'idle' | 'scheduled' | 'syncing' | 'success' | 'error';

export interface CloudSyncResult {
  success: boolean;
  action?: CloudSyncAction;
  localRevision?: string;
  remoteRevision?: string;
  appliedLocal: boolean;
  uploadedRemote: boolean;
  conflicts: CloudSyncConflict[];
  summary: CloudSyncMergeSummary;
  error?: string;
}

export interface CloudSyncOptions extends CloudSyncMergeOptions {
  deviceName?: string;
  platform?: string;
  reason?: CloudSyncRunReason;
}

export interface CloudSyncCloudClient {
  getCloudSyncManifest(storageId: string): Promise<CloudSyncManifest>;
  saveCloudSyncManifest(storageId: string, manifest: CloudSyncManifest): Promise<{
    success: boolean;
    error?: string;
  }>;
}

export interface CloudSyncDatabaseClient {
  exportAllDataForSync(): Promise<ExportResult>;
  replaceAllData(data: CloudSyncDataSet): Promise<ImportResult>;
}

export interface CloudSyncConfigClient {
  getStorageConfigs(): Promise<CloudStorageConfig[]>;
}

export interface CloudSyncStatus {
  status: CloudSyncLifecycleStatus;
  pending: boolean;
  updatedAt: string;
  storageId?: string;
  reason?: CloudSyncRunReason;
  nextSyncAt?: string;
  lastSyncAt?: string;
  lastResult?: CloudSyncResult;
  error?: string;
}

export interface CloudSyncAutoOptions extends CloudSyncOptions {
  enabled?: boolean;
  storageIds?: string[];
  debounceMs?: number;
  retryMs?: number;
  pollIntervalMs?: number;
  syncOnStart?: boolean;
}

export interface CloudSyncLocalState {
  storageId: string;
  deviceId: string;
  lastSyncAt: string;
  lastKnownRevision?: string;
  baseSnapshot?: CloudSyncSnapshot;
}

export interface CloudSyncServiceDeps {
  cloudClient?: CloudSyncCloudClient;
  configClient?: CloudSyncConfigClient;
  database?: CloudSyncDatabaseClient;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  createDeviceId?: () => string;
  subscribeToDataChanges?: (listener: (change: DataChangeEventPayload) => void) => () => void;
}

type CloudSyncStatusListener = (status: CloudSyncStatus) => void;

export class CloudSyncService {
  private static instance: CloudSyncService;
  private readonly cloudClient?: CloudSyncCloudClient;
  private readonly configClient?: CloudSyncConfigClient;
  private readonly database: CloudSyncDatabaseClient;
  private readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  private readonly createDeviceId: () => string;
  private readonly subscribeToDataChanges: (listener: (change: DataChangeEventPayload) => void) => () => void;
  private readonly runningSyncs = new Map<string, Promise<CloudSyncResult>>();
  private readonly statusListeners = new Set<CloudSyncStatusListener>();
  private autoSyncOptions: CloudSyncAutoOptions | null = null;
  private unsubscribeDataChanges: (() => void) | null = null;
  private scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private browserTriggerCleanups: (() => void)[] = [];
  private applyingRemoteDataDepth = 0;
  private status: CloudSyncStatus = {
    status: 'idle',
    pending: false,
    updatedAt: new Date().toISOString()
  };

  constructor(deps: CloudSyncServiceDeps = {}) {
    this.cloudClient = deps.cloudClient;
    this.configClient = deps.configClient;
    this.database = deps.database || DatabaseServiceManager.getInstance();
    this.storage = deps.storage || getBrowserStorage();
    this.createDeviceId = deps.createDeviceId || generateUUID;
    this.subscribeToDataChanges = deps.subscribeToDataChanges || (listener => onDataChange(SYNC_STORE_NAMES, listener));
  }

  static getInstance(): CloudSyncService {
    if (!CloudSyncService.instance) {
      CloudSyncService.instance = new CloudSyncService();
    }
    return CloudSyncService.instance;
  }

  async syncNow(storageId: string, options: CloudSyncOptions = {}): Promise<CloudSyncResult> {
    const running = this.runningSyncs.get(storageId);
    if (running) {
      return running;
    }

    this.updateStatus({
      status: 'syncing',
      pending: false,
      storageId,
      reason: options.reason || 'manual',
      error: undefined,
      nextSyncAt: undefined
    });

    const syncPromise = this.performSync(storageId, options)
      .then(result => {
        this.updateStatus({
          status: result.success ? 'success' : 'error',
          pending: false,
          storageId,
          reason: options.reason || 'manual',
          lastSyncAt: result.success ? new Date().toISOString() : this.status.lastSyncAt,
          lastResult: result,
          error: result.success ? undefined : result.error,
          nextSyncAt: undefined
        });
        return result;
      })
      .finally(() => this.runningSyncs.delete(storageId));
    this.runningSyncs.set(storageId, syncPromise);
    return syncPromise;
  }

  startAutoSync(options: CloudSyncAutoOptions = {}): void {
    this.stopAutoSync();

    if (options.enabled === false) {
      return;
    }

    this.autoSyncOptions = options;
    this.unsubscribeDataChanges = this.subscribeToDataChanges(change => this.handleLocalDataChange(change));
    this.attachBrowserTriggers();

    if ((options.pollIntervalMs ?? DEFAULT_REMOTE_POLL_INTERVAL_MS) > 0) {
      this.pollTimer = setInterval(() => {
        void this.runScheduledSync('interval');
      }, options.pollIntervalMs ?? DEFAULT_REMOTE_POLL_INTERVAL_MS);
    }

    if (options.syncOnStart !== false) {
      this.scheduleSync('startup', { delayMs: 0 });
    }
  }

  stopAutoSync(): void {
    this.clearScheduledTimer();
    this.clearRetryTimer();

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.unsubscribeDataChanges?.();
    this.unsubscribeDataChanges = null;

    this.browserTriggerCleanups.forEach(cleanup => cleanup());
    this.browserTriggerCleanups = [];
    this.autoSyncOptions = null;

    this.updateStatus({
      status: 'idle',
      pending: false,
      nextSyncAt: undefined,
      reason: undefined
    });
  }

  scheduleSync(
    reason: CloudSyncRunReason = 'manual',
    options: { storageId?: string; delayMs?: number } = {}
  ): void {
    if (!this.autoSyncOptions) {
      return;
    }

    const delayMs = options.delayMs ?? this.autoSyncOptions.debounceMs ?? DEFAULT_AUTO_SYNC_DEBOUNCE_MS;
    const nextSyncAt = new Date(Date.now() + delayMs).toISOString();

    this.clearScheduledTimer();
    this.updateStatus({
      status: 'scheduled',
      pending: true,
      storageId: options.storageId,
      reason,
      nextSyncAt,
      error: undefined
    });

    this.scheduledTimer = setTimeout(() => {
      this.scheduledTimer = null;
      void this.runScheduledSync(reason, options.storageId);
    }, delayMs);
  }

  getStatus(): CloudSyncStatus {
    return { ...this.status };
  }

  onStatusChange(listener: CloudSyncStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());

    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private async performSync(storageId: string, options: CloudSyncOptions): Promise<CloudSyncResult> {
    try {
      const deviceId = this.getOrCreateDeviceId();
      const now = new Date().toISOString();
      const localData = await this.exportLocalData();
      const manifest = await this.getCloudClient().getCloudSyncManifest(storageId);
      const localState = this.getLocalState(storageId);
      const remoteSnapshot = manifest.latestSnapshot;

      if (!remoteSnapshot) {
        const snapshot = createCloudSyncSnapshot(localData, deviceId);
        await this.saveManifest(storageId, this.buildManifest(manifest, snapshot, [], deviceId, now, options));
        this.saveLocalState(storageId, deviceId, snapshot, now);

        return {
          success: true,
          action: 'uploaded',
          localRevision: snapshot.revision,
          remoteRevision: snapshot.revision,
          appliedLocal: false,
          uploadedRemote: true,
          conflicts: [],
          summary: createEmptySummary()
        };
      }

      const remoteData = applyCloudSyncTombstones(remoteSnapshot.data);
      const baseData = this.getBaseData(localState);
      const mergeResult = mergeCloudSyncData(localData, remoteData, baseData, {
        prefer: options.prefer || 'newer'
      });
      const mergedData = applyCloudSyncTombstones(mergeResult.data);
      const mergedEqualsLocal = dataSetsEqual(localData, mergedData);
      const mergedEqualsRemote = dataSetsEqual(remoteData, mergedData);

      if (mergedEqualsLocal && mergedEqualsRemote) {
        this.saveLocalState(storageId, deviceId, remoteSnapshot, now);
        return {
          success: true,
          action: 'noop',
          localRevision: remoteSnapshot.revision,
          remoteRevision: remoteSnapshot.revision,
          appliedLocal: false,
          uploadedRemote: false,
          conflicts: mergeResult.conflicts,
          summary: mergeResult.summary
        };
      }

      let finalSnapshot = remoteSnapshot;
      let uploadedRemote = false;
      if (!mergedEqualsRemote) {
        finalSnapshot = createCloudSyncSnapshot(mergedData, deviceId);
        await this.saveManifest(
          storageId,
          this.buildManifest(manifest, finalSnapshot, mergeResult.conflicts, deviceId, now, options)
        );
        uploadedRemote = true;
      }

      let appliedLocal = false;
      if (!mergedEqualsLocal) {
        this.applyingRemoteDataDepth++;
        try {
          const importResult = await this.database.replaceAllData(mergedData);
          if (!importResult.success) {
            throw new Error(importResult.error || importResult.message || '同步合并数据写入本地失败');
          }
        } finally {
          this.applyingRemoteDataDepth--;
        }
        appliedLocal = true;
      }

      this.saveLocalState(storageId, deviceId, finalSnapshot, now);

      return {
        success: true,
        action: getSyncAction(appliedLocal, uploadedRemote),
        localRevision: finalSnapshot.revision,
        remoteRevision: finalSnapshot.revision,
        appliedLocal,
        uploadedRemote,
        conflicts: mergeResult.conflicts,
        summary: mergeResult.summary
      };
    } catch (error) {
      return {
        success: false,
        appliedLocal: false,
        uploadedRemote: false,
        conflicts: [],
        summary: createEmptySummary(),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async exportLocalData(): Promise<CloudSyncDataSet> {
    const exportResult = await this.database.exportAllDataForSync();
    if (!exportResult.success || !exportResult.data) {
      throw new Error(exportResult.error || exportResult.message || '导出同步数据失败');
    }
    return applyCloudSyncTombstones(exportResult.data);
  }

  private buildManifest(
    manifest: CloudSyncManifest,
    snapshot: CloudSyncSnapshot,
    conflicts: CloudSyncConflict[],
    deviceId: string,
    now: string,
    options: CloudSyncOptions
  ): CloudSyncManifest {
    return updateCloudSyncManifestDevice(
      {
        ...manifest,
        updatedAt: now,
        latestSnapshot: snapshot,
        baseSnapshot: snapshot,
        conflicts
      },
      {
        deviceId,
        deviceName: options.deviceName || getDefaultDeviceName(),
        platform: options.platform || PlatformDetector.getPlatform(),
        lastSyncAt: now,
        lastKnownRevision: snapshot.revision
      }
    );
  }

  private async saveManifest(storageId: string, manifest: CloudSyncManifest): Promise<void> {
    const result = await this.getCloudClient().saveCloudSyncManifest(storageId, manifest);
    if (!result.success) {
      throw new Error(result.error || '保存云同步 manifest 失败');
    }
  }

  private getBaseData(localState: CloudSyncLocalState | null): CloudSyncDataSet {
    if (localState?.baseSnapshot) {
      return applyCloudSyncTombstones(localState.baseSnapshot.data);
    }

    return {};
  }

  private getCloudClient(): CloudSyncCloudClient {
    if (this.cloudClient) {
      return this.cloudClient;
    }

    if (PlatformDetector.isElectron()) {
      return {
        getCloudSyncManifest: storageId => CloudBackupAPI.getCloudSyncManifest(storageId),
        saveCloudSyncManifest: (storageId, manifest) => CloudBackupAPI.saveCloudSyncManifest(storageId, manifest)
      };
    }

    return {
      getCloudSyncManifest: storageId => mobileCloudBackupService.getCloudSyncManifest(storageId),
      saveCloudSyncManifest: (storageId, manifest) => mobileCloudBackupService.saveCloudSyncManifest(storageId, manifest)
    };
  }

  private getConfigClient(): CloudSyncConfigClient {
    if (this.configClient) {
      return this.configClient;
    }

    if (PlatformDetector.isElectron()) {
      return {
        getStorageConfigs: () => CloudBackupAPI.getStorageConfigs()
      };
    }

    return {
      getStorageConfigs: () => mobileCloudBackupService.getStorageConfigs()
    };
  }

  private handleLocalDataChange(change: DataChangeEventPayload): void {
    if (this.applyingRemoteDataDepth > 0) {
      return;
    }

    if (change.action === 'clear' && change.storeName === 'syncTombstones') {
      return;
    }

    this.scheduleSync('local-change');
  }

  private async runScheduledSync(reason: CloudSyncRunReason, storageId?: string): Promise<void> {
    if (!this.autoSyncOptions) {
      return;
    }

    if (isBrowserOffline()) {
      this.scheduleRetry(reason, '当前网络不可用，等待恢复后重试');
      return;
    }

    const storageIds = await this.resolveStorageIds(storageId);
    if (storageIds.length === 0) {
      this.updateStatus({
        status: 'idle',
        pending: false,
        reason,
        storageId: undefined,
        nextSyncAt: undefined,
        error: undefined
      });
      return;
    }

    let firstFailure: CloudSyncResult | null = null;
    let lastResult: CloudSyncResult | undefined;

    for (const targetStorageId of storageIds) {
      const result = await this.syncNow(targetStorageId, {
        ...this.autoSyncOptions,
        reason
      });
      lastResult = result;
      if (!result.success && !firstFailure) {
        firstFailure = result;
      }
    }

    if (firstFailure) {
      this.scheduleRetry(reason, firstFailure.error || '自动同步失败');
      return;
    }

    this.clearRetryTimer();
    this.updateStatus({
      status: 'success',
      pending: false,
      storageId: storageIds[storageIds.length - 1],
      reason,
      lastResult,
      lastSyncAt: new Date().toISOString(),
      error: undefined,
      nextSyncAt: undefined
    });
  }

  private async resolveStorageIds(storageId?: string): Promise<string[]> {
    if (storageId) {
      return [storageId];
    }

    if (this.autoSyncOptions?.storageIds?.length) {
      return this.autoSyncOptions.storageIds;
    }

    try {
      const configs = await this.getConfigClient().getStorageConfigs();
      return configs
        .filter(config => config.enabled)
        .map(config => config.id);
    } catch (error) {
      console.warn('获取自动同步存储配置失败:', error);
      return [];
    }
  }

  private scheduleRetry(reason: CloudSyncRunReason, error: string): void {
    if (!this.autoSyncOptions) {
      return;
    }

    const retryMs = this.autoSyncOptions.retryMs ?? DEFAULT_AUTO_SYNC_RETRY_MS;
    if (retryMs <= 0) {
      this.updateStatus({
        status: 'error',
        pending: false,
        reason,
        error,
        nextSyncAt: undefined
      });
      return;
    }

    const nextSyncAt = new Date(Date.now() + retryMs).toISOString();
    this.clearRetryTimer();
    this.updateStatus({
      status: 'error',
      pending: true,
      reason,
      error,
      nextSyncAt
    });

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.runScheduledSync('retry');
    }, retryMs);
  }

  private attachBrowserTriggers(): void {
    if (typeof window !== 'undefined') {
      const handleOnline = () => this.scheduleSync('online', { delayMs: 0 });
      const handleFocus = () => this.scheduleSync('focus', { delayMs: 0 });
      window.addEventListener('online', handleOnline);
      window.addEventListener('focus', handleFocus);
      this.browserTriggerCleanups.push(() => window.removeEventListener('online', handleOnline));
      this.browserTriggerCleanups.push(() => window.removeEventListener('focus', handleFocus));
    }

    if (typeof document !== 'undefined') {
      const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
          this.scheduleSync('focus', { delayMs: 0 });
        }
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      this.browserTriggerCleanups.push(() => document.removeEventListener('visibilitychange', handleVisibilityChange));
    }
  }

  private clearScheduledTimer(): void {
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = null;
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private updateStatus(update: Partial<CloudSyncStatus>): void {
    this.status = {
      ...this.status,
      ...update,
      updatedAt: new Date().toISOString()
    };

    const snapshot = this.getStatus();
    this.statusListeners.forEach(listener => {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('云同步状态监听器执行失败:', error);
      }
    });
  }

  private getOrCreateDeviceId(): string {
    const stored = this.storage?.getItem(DEVICE_ID_STORAGE_KEY);
    if (stored) {
      return stored;
    }

    const deviceId = this.createDeviceId();
    this.storage?.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
    return deviceId;
  }

  private getLocalState(storageId: string): CloudSyncLocalState | null {
    try {
      const raw = this.storage?.getItem(this.getLocalStateStorageKey(storageId));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private saveLocalState(
    storageId: string,
    deviceId: string,
    snapshot: CloudSyncSnapshot,
    lastSyncAt: string
  ): void {
    const state: CloudSyncLocalState = {
      storageId,
      deviceId,
      lastSyncAt,
      lastKnownRevision: snapshot.revision,
      baseSnapshot: snapshot
    };
    this.storage?.setItem(this.getLocalStateStorageKey(storageId), JSON.stringify(state));
  }

  private getLocalStateStorageKey(storageId: string): string {
    return `${LOCAL_STATE_STORAGE_PREFIX}:${storageId}`;
  }
}

function getBrowserStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  return typeof window !== 'undefined' ? window.localStorage : undefined;
}

function getDefaultDeviceName(): string {
  if (typeof navigator === 'undefined') {
    return 'Unknown Device';
  }
  return navigator.userAgent || 'Unknown Device';
}

function getSyncAction(appliedLocal: boolean, uploadedRemote: boolean): CloudSyncAction {
  if (appliedLocal && uploadedRemote) {
    return 'merged';
  }
  if (appliedLocal) {
    return 'downloaded';
  }
  return uploadedRemote ? 'uploaded' : 'noop';
}

function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function createEmptySummary(): CloudSyncMergeSummary {
  return {
    added: 0,
    updated: 0,
    deleted: 0,
    kept: 0,
    conflicts: 0
  };
}

function dataSetsEqual(left: CloudSyncDataSet, right: CloudSyncDataSet): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

function stableSerialize(value: any): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }

  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
}

export const cloudSyncService = CloudSyncService.getInstance();
