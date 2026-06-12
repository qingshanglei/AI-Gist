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
  mergeCloudSyncData,
  validateCloudSyncSnapshot
} from '@shared/cloud-sync-engine';
import type { CloudSyncManifest } from '@shared/cloud-sync-manifest';
import {
  createEmptyCloudSyncManifest,
  sanitizeCloudSyncConflictsForMetadata,
  updateCloudSyncManifestDevice
} from '@shared/cloud-sync-manifest';
import { generateUUID } from '../utils/uuid';
import { CloudBackupAPI } from '../api/cloud-backup.api';
import { DatabaseServiceManager } from './database-manager.service';
import { AppSettingsService } from './app-settings.service';
import { mobileCloudBackupService } from './mobile-cloud-backup.service';
import { webCloudBackupService } from './web-cloud-backup.service';
import type { DataChangeEventPayload, DataStoreName } from './data-change-events';
import { onDataChange } from './data-change-events';

const DEVICE_ID_STORAGE_KEY = 'ai_gist_cloud_sync_device_id';
const LOCAL_STATE_STORAGE_PREFIX = 'ai_gist_cloud_sync_state';
const LAST_AUTO_ATTEMPT_STORAGE_KEY = 'ai_gist_cloud_sync_last_auto_attempt_at';
const CONFLICT_LOG_STORAGE_KEY = 'ai_gist_cloud_sync_conflict_log';
const MAX_CONFLICT_LOG_ENTRIES = 50;
export const CLOUD_SYNC_INTERVAL_SETTING_KEY = 'cloud.sync.intervalMinutes';
export const DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES = 15;
export const MIN_CLOUD_SYNC_INTERVAL_MINUTES = 5;
export const MAX_CLOUD_SYNC_INTERVAL_MINUTES = 1440;
const DEFAULT_AUTO_SYNC_DEBOUNCE_MS = 60000;
const DEFAULT_REMOTE_POLL_INTERVAL_MS = DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES * 60 * 1000;
const DEFAULT_AUTO_SYNC_RETRY_MS = DEFAULT_REMOTE_POLL_INTERVAL_MS;
const DEFAULT_STARTUP_SYNC_DELAY_MS = 10000;
const MAX_AUTO_SYNC_RETRY_MS = 60 * 60 * 1000;
const MAX_REMOTE_RECHECK_ATTEMPTS = 3;
const SYNC_STORE_NAMES: DataStoreName[] = [
  'categories',
  'prompts',
  'promptVariables',
  'promptHistories',
  'ai_configs',
  'quick_optimization_configs',
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
  lastAttemptAt?: string;
  failureCount?: number;
  conflictLogCount?: number;
  lastResult?: CloudSyncResult;
  error?: string;
}

export interface CloudSyncAutoOptions extends CloudSyncOptions {
  enabled?: boolean;
  storageIds?: string[];
  debounceMs?: number;
  retryMs?: number;
  pollIntervalMs?: number;
  startupDelayMs?: number;
  syncOnStart?: boolean;
}

export interface CloudSyncLocalState {
  storageId: string;
  deviceId: string;
  lastSyncAt: string;
  lastKnownRevision?: string;
  baseSnapshot?: CloudSyncSnapshot;
}

export interface CloudSyncConflictLogEntry {
  id: string;
  storageId: string;
  detectedAt: string;
  localRevision?: string;
  remoteRevision?: string;
  resolvedRevision?: string;
  conflicts: CloudSyncConflict[];
}

export interface CloudSyncServiceDeps {
  cloudClient?: CloudSyncCloudClient;
  configClient?: CloudSyncConfigClient;
  database?: CloudSyncDatabaseClient;
  settings?: Pick<AppSettingsService, 'getNumberValue' | 'setNumberValue'>;
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
  private readonly settings: Pick<AppSettingsService, 'getNumberValue' | 'setNumberValue'>;
  private readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  private readonly createDeviceId: () => string;
  private readonly subscribeToDataChanges: (listener: (change: DataChangeEventPayload) => void) => () => void;
  private readonly runningSyncs = new Map<string, Promise<CloudSyncResult>>();
  private readonly statusListeners = new Set<CloudSyncStatusListener>();
  private autoSyncOptions: CloudSyncAutoOptions | null = null;
  private unsubscribeDataChanges: (() => void) | null = null;
  private scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryStorageId: string | undefined;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private browserTriggerCleanups: (() => void)[] = [];
  private applyingRemoteDataDepth = 0;
  private failureCount = 0;
  private status: CloudSyncStatus = {
    status: 'idle',
    pending: false,
    updatedAt: new Date().toISOString()
  };

  constructor(deps: CloudSyncServiceDeps = {}) {
    this.cloudClient = deps.cloudClient;
    this.configClient = deps.configClient;
    this.database = deps.database || DatabaseServiceManager.getInstance();
    this.settings = deps.settings || AppSettingsService.getInstance();
    this.storage = deps.storage || getBrowserStorage();
    this.createDeviceId = deps.createDeviceId || generateUUID;
    this.subscribeToDataChanges = deps.subscribeToDataChanges || (listener => onDataChange(SYNC_STORE_NAMES, listener));
    this.status.conflictLogCount = this.getConflictLog().length;
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

    const attemptAt = new Date().toISOString();
    this.saveLastAutoAttemptAt(attemptAt);
    this.updateStatus({
      status: 'syncing',
      pending: false,
      storageId,
      reason: options.reason || 'manual',
      lastAttemptAt: attemptAt,
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
          failureCount: result.success ? 0 : this.failureCount,
          lastResult: result,
          error: result.success ? undefined : result.error,
          nextSyncAt: undefined
        });
        if (result.success) {
          this.failureCount = 0;
          this.clearRetryTimerForStorage(storageId);
        }
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

    this.autoSyncOptions = normalizeAutoSyncOptions(options);
    this.unsubscribeDataChanges = this.subscribeToDataChanges(change => this.handleLocalDataChange(change));
    this.attachBrowserTriggers();

    if (this.autoSyncOptions.pollIntervalMs! > 0) {
      this.pollTimer = setInterval(() => {
        void this.runScheduledSync('interval');
      }, this.autoSyncOptions.pollIntervalMs);
    }

    if (this.autoSyncOptions.syncOnStart !== false) {
      this.scheduleSync('startup', {
        delayMs: this.autoSyncOptions.startupDelayMs ?? DEFAULT_STARTUP_SYNC_DELAY_MS
      });
    }
  }

  async startAutoSyncFromSettings(options: CloudSyncAutoOptions = {}): Promise<void> {
    const intervalMinutes = await this.getAutoSyncIntervalMinutes();
    const intervalMs = minutesToMs(intervalMinutes);
    this.startAutoSync({
      ...options,
      pollIntervalMs: options.pollIntervalMs ?? intervalMs,
      retryMs: options.retryMs ?? intervalMs
    });
  }

  async getAutoSyncIntervalMinutes(): Promise<number> {
    try {
      const storedValue = await this.settings.getNumberValue(
        CLOUD_SYNC_INTERVAL_SETTING_KEY,
        DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES
      );
      return normalizeCloudSyncIntervalMinutes(storedValue);
    } catch {
      return DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES;
    }
  }

  async setAutoSyncIntervalMinutes(minutes: number): Promise<number> {
    const normalizedMinutes = normalizeCloudSyncIntervalMinutes(minutes);
    await this.settings.setNumberValue(
      CLOUD_SYNC_INTERVAL_SETTING_KEY,
      normalizedMinutes,
      '云同步自动检查间隔（分钟）'
    );

    if (this.autoSyncOptions) {
      const intervalMs = minutesToMs(normalizedMinutes);
      this.startAutoSync({
        ...this.autoSyncOptions,
        pollIntervalMs: intervalMs,
        retryMs: intervalMs
      });
    }

    return normalizedMinutes;
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

    if (this.retryTimer && reason !== 'retry' && reason !== 'config-change') {
      if (reason !== 'online') {
        return;
      }
      this.clearRetryTimer();
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

  getConflictLog(storageId?: string): CloudSyncConflictLogEntry[] {
    if (!this.storage) {
      return [];
    }

    try {
      const raw = this.storage.getItem(CONFLICT_LOG_STORAGE_KEY);
      if (!raw) {
        return [];
      }

      const entries = JSON.parse(raw);
      if (!Array.isArray(entries)) {
        return [];
      }

      const normalized = entries
        .map(entry => normalizeConflictLogEntry(entry))
        .filter((entry): entry is CloudSyncConflictLogEntry => !!entry);
      return storageId
        ? normalized.filter(entry => entry.storageId === storageId)
        : normalized;
    } catch {
      return [];
    }
  }

  clearConflictLog(storageId?: string): void {
    if (!this.storage) {
      return;
    }

    try {
      if (!storageId) {
        this.storage.removeItem(CONFLICT_LOG_STORAGE_KEY);
        this.updateStatus({ conflictLogCount: 0 });
        return;
      }

      const remainingEntries = this.getConflictLog()
        .filter(entry => entry.storageId !== storageId)
        .slice(0, MAX_CONFLICT_LOG_ENTRIES);

      if (remainingEntries.length === 0) {
        this.storage.removeItem(CONFLICT_LOG_STORAGE_KEY);
      } else {
        this.storage.setItem(CONFLICT_LOG_STORAGE_KEY, JSON.stringify(remainingEntries));
      }

      this.updateStatus({ conflictLogCount: remainingEntries.length });
    } catch (error) {
      console.warn('清空同步冲突审计记录失败:', error);
    }
  }

  private async performSync(
    storageId: string,
    options: CloudSyncOptions,
    attempt = 0
  ): Promise<CloudSyncResult> {
    try {
      const deviceId = this.getOrCreateDeviceId();
      const now = new Date().toISOString();
      const localData = await this.exportLocalData();
      const manifest = await this.getCloudClient().getCloudSyncManifest(storageId);
      const localState = this.getLocalState(storageId);
      const remoteSnapshot = manifest.latestSnapshot;
      if (remoteSnapshot) {
        this.assertValidRemoteSnapshot(remoteSnapshot);
      }

      if (!remoteSnapshot) {
        const latestManifest = await this.getCloudClient().getCloudSyncManifest(storageId);
        if (latestManifest.latestSnapshot) {
          return await this.retryWithLatestRemote(storageId, options, attempt);
        }

        const snapshot = createCloudSyncSnapshot(localData, deviceId);
        await this.saveManifest(storageId, this.buildManifest(latestManifest, snapshot, [], deviceId, now, options));
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
        this.recordConflictLog(storageId, mergeResult.conflicts, {
          detectedAt: now,
          localRevision: localState?.lastKnownRevision,
          remoteRevision: remoteSnapshot.revision,
          resolvedRevision: remoteSnapshot.revision
        });
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
      let latestManifestForUpload: CloudSyncManifest | null = null;
      if (!mergedEqualsRemote) {
        const latestManifest = await this.getCloudClient().getCloudSyncManifest(storageId);
        if (hasRemoteRevisionChanged(remoteSnapshot, latestManifest.latestSnapshot)) {
          return await this.retryWithLatestRemote(storageId, options, attempt);
        }

        latestManifestForUpload = latestManifest;
        finalSnapshot = createCloudSyncSnapshot(mergedData, deviceId);
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

      let uploadedRemote = false;
      if (latestManifestForUpload) {
        await this.saveManifest(
          storageId,
          this.buildManifest(latestManifestForUpload, finalSnapshot, mergeResult.conflicts, deviceId, now, options)
        );
        uploadedRemote = true;
      }

      this.recordConflictLog(storageId, mergeResult.conflicts, {
        detectedAt: now,
        localRevision: localState?.lastKnownRevision,
        remoteRevision: remoteSnapshot.revision,
        resolvedRevision: finalSnapshot.revision
      });
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

  private async retryWithLatestRemote(
    storageId: string,
    options: CloudSyncOptions,
    attempt: number
  ): Promise<CloudSyncResult> {
    if (attempt + 1 >= MAX_REMOTE_RECHECK_ATTEMPTS) {
      throw new Error('云端同步文件正在被其他设备更新，请稍后重试');
    }

    return await this.performSync(storageId, options, attempt + 1);
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
        conflicts: sanitizeCloudSyncConflictsForMetadata(conflicts)
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
    const cloudClient = this.getCloudClient();
    const result = await cloudClient.saveCloudSyncManifest(storageId, manifest);
    if (!result.success) {
      throw new Error(result.error || '保存云同步 manifest 失败');
    }

    const expectedSnapshot = manifest.latestSnapshot;
    if (!expectedSnapshot) {
      return;
    }

    const savedManifest = await cloudClient.getCloudSyncManifest(storageId);
    const savedSnapshot = savedManifest.latestSnapshot;
    if (!savedSnapshot) {
      throw new Error(
        `云同步 manifest 保存后校验失败：期望 revision ${expectedSnapshot.revision}，实际 空`
      );
    }

    this.assertValidSavedSnapshot(savedSnapshot);

    if (savedSnapshot.revision !== expectedSnapshot.revision) {
      throw new Error(
        `云同步 manifest 保存后校验失败：期望 revision ${expectedSnapshot.revision}，实际 ${savedSnapshot.revision}`
      );
    }

    if (
      expectedSnapshot.dataChecksum &&
      savedSnapshot.dataChecksum !== expectedSnapshot.dataChecksum
    ) {
      throw new Error(
        `云同步 manifest 保存后数据校验失败：期望 checksum ${expectedSnapshot.dataChecksum}，` +
        `实际 ${savedSnapshot.dataChecksum || '空'}`
      );
    }

    if (!dataSetsEqual(savedSnapshot.data, expectedSnapshot.data)) {
      throw new Error('云同步 manifest 保存后数据校验失败：云端快照内容与本地提交不一致');
    }
  }

  private getBaseData(localState: CloudSyncLocalState | null): CloudSyncDataSet {
    if (localState?.baseSnapshot) {
      return applyCloudSyncTombstones(localState.baseSnapshot.data);
    }

    return {};
  }

  private assertValidRemoteSnapshot(snapshot: CloudSyncSnapshot): void {
    const validation = validateCloudSyncSnapshot(snapshot);
    if (!validation.valid) {
      throw new Error(`云端同步快照无效: ${validation.reason || '未知原因'}`);
    }
  }

  private assertValidSavedSnapshot(snapshot: CloudSyncSnapshot): void {
    const validation = validateCloudSyncSnapshot(snapshot);
    if (!validation.valid) {
      throw new Error(`云同步 manifest 保存后数据校验失败：云端快照无效: ${validation.reason || '未知原因'}`);
    }
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

    if (PlatformDetector.isWeb()) {
      return {
        getCloudSyncManifest: storageId => webCloudBackupService.getCloudSyncManifest(storageId),
        saveCloudSyncManifest: (storageId, manifest) => webCloudBackupService.saveCloudSyncManifest(storageId, manifest)
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

    if (PlatformDetector.isWeb()) {
      return {
        getStorageConfigs: () => webCloudBackupService.getStorageConfigs()
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

    if (this.retryTimer && reason !== 'retry' && reason !== 'config-change') {
      return;
    }

    const throttleMs = this.getAutoRunThrottleMs(reason);
    if (throttleMs > 0) {
      this.scheduleSync(reason, {
        storageId,
        delayMs: throttleMs
      });
      return;
    }

    if (isBrowserOffline()) {
      this.scheduleRetry(reason, '当前网络不可用，等待恢复后重试', storageId);
      return;
    }

    let storageIds: string[];
    try {
      storageIds = await this.resolveStorageIds(storageId);
    } catch (error) {
      this.scheduleRetry(reason, error instanceof Error ? error.message : String(error), storageId);
      return;
    }

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
    let firstFailureStorageId: string | undefined;
    let lastResult: CloudSyncResult | undefined;

    for (const targetStorageId of storageIds) {
      const result = await this.syncNow(targetStorageId, {
        ...this.autoSyncOptions,
        reason
      });
      lastResult = result;
      if (!result.success && !firstFailure) {
        firstFailure = result;
        firstFailureStorageId = targetStorageId;
      }
    }

    if (firstFailure) {
      this.scheduleRetry(reason, firstFailure.error || '自动同步失败', firstFailureStorageId || storageId);
      return;
    }

    this.clearRetryTimer();
    this.failureCount = 0;
    this.updateStatus({
      status: 'success',
      pending: false,
      storageId: storageIds[storageIds.length - 1],
      reason,
      lastResult,
      lastSyncAt: new Date().toISOString(),
      failureCount: 0,
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
      throw new Error(`获取自动同步存储配置失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private scheduleRetry(reason: CloudSyncRunReason, error: string, storageId?: string): void {
    if (!this.autoSyncOptions) {
      return;
    }

    const retryMs = this.getNextRetryDelayMs();
    if (retryMs <= 0) {
      this.updateStatus({
        status: 'error',
        pending: false,
        storageId,
        reason,
        error,
        nextSyncAt: undefined
      });
      return;
    }

    const nextSyncAt = new Date(Date.now() + retryMs).toISOString();
    this.clearScheduledTimer();
    this.clearRetryTimer();
    this.failureCount += 1;
    this.retryStorageId = storageId;
    this.updateStatus({
      status: 'error',
      pending: true,
      storageId,
      reason,
      error,
      failureCount: this.failureCount,
      nextSyncAt
    });

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryStorageId = undefined;
      void this.runScheduledSync('retry', storageId);
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
    this.retryStorageId = undefined;
  }

  private clearRetryTimerForStorage(storageId: string): void {
    if (!this.retryTimer) {
      return;
    }

    if (!this.retryStorageId || this.retryStorageId === storageId) {
      this.clearRetryTimer();
    }
  }

  private getAutoRunThrottleMs(reason: CloudSyncRunReason): number {
    if (reason === 'config-change' || reason === 'retry' || (reason === 'online' && this.failureCount > 0)) {
      return 0;
    }

    const intervalMs = this.autoSyncOptions?.pollIntervalMs ?? DEFAULT_REMOTE_POLL_INTERVAL_MS;
    if (intervalMs <= 0) {
      return 0;
    }

    const lastAttemptTime = this.getLastAutoAttemptTime();
    if (!lastAttemptTime) {
      return 0;
    }

    return Math.max(0, lastAttemptTime + intervalMs - Date.now());
  }

  private getNextRetryDelayMs(): number {
    const baseRetryMs = this.autoSyncOptions?.retryMs ?? DEFAULT_AUTO_SYNC_RETRY_MS;
    if (baseRetryMs <= 0) {
      return 0;
    }

    const multiplier = 2 ** this.failureCount;
    return Math.min(baseRetryMs * multiplier, MAX_AUTO_SYNC_RETRY_MS);
  }

  private getLastAutoAttemptTime(): number | null {
    let rawValue: string | null | undefined;
    try {
      rawValue = this.storage?.getItem(LAST_AUTO_ATTEMPT_STORAGE_KEY);
      if (!rawValue) {
        return null;
      }
    } catch (error) {
      console.warn('读取云同步自动尝试时间失败:', error);
      return null;
    }

    const time = Date.parse(rawValue);
    return Number.isNaN(time) ? null : time;
  }

  private saveLastAutoAttemptAt(isoTime: string): void {
    try {
      this.storage?.setItem(LAST_AUTO_ATTEMPT_STORAGE_KEY, isoTime);
    } catch (error) {
      console.warn('保存云同步自动尝试时间失败:', error);
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
    try {
      const stored = this.storage?.getItem(DEVICE_ID_STORAGE_KEY);
      if (stored) {
        return stored;
      }
    } catch (error) {
      console.warn('读取云同步设备 ID 失败:', error);
    }

    const deviceId = this.createDeviceId();
    try {
      this.storage?.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
    } catch (error) {
      console.warn('保存云同步设备 ID 失败:', error);
    }
    return deviceId;
  }

  private getLocalState(storageId: string): CloudSyncLocalState | null {
    try {
      const raw = this.storage?.getItem(this.getLocalStateStorageKey(storageId));
      return raw ? this.normalizeLocalState(JSON.parse(raw), storageId) : null;
    } catch {
      return null;
    }
  }

  private normalizeLocalState(value: unknown, storageId: string): CloudSyncLocalState | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const state = value as Partial<CloudSyncLocalState>;
    if (
      state.storageId !== storageId ||
      typeof state.deviceId !== 'string' ||
      typeof state.lastSyncAt !== 'string'
    ) {
      return null;
    }

    if (state.baseSnapshot !== undefined) {
      const validation = validateCloudSyncSnapshot(state.baseSnapshot);
      if (!validation.valid) {
        console.warn('本地同步状态已损坏，忽略本地 baseSnapshot:', validation.reason);
        return null;
      }

      if (
        typeof state.lastKnownRevision === 'string' &&
        state.lastKnownRevision !== state.baseSnapshot.revision
      ) {
        console.warn(
          '本地同步状态 revision 不一致，忽略本地 baseSnapshot:',
          state.lastKnownRevision,
          state.baseSnapshot.revision
        );
        return null;
      }
    }

    return {
      storageId: state.storageId,
      deviceId: state.deviceId,
      lastSyncAt: state.lastSyncAt,
      lastKnownRevision: typeof state.lastKnownRevision === 'string' ? state.lastKnownRevision : undefined,
      baseSnapshot: state.baseSnapshot
    };
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
    const serializedState = JSON.stringify(state);
    const firstError = this.trySaveLocalState(storageId, serializedState);
    if (!firstError) {
      return;
    }

    let lastError = firstError;
    if (this.clearNoncriticalSyncStorageForRetry()) {
      const retryError = this.trySaveLocalState(storageId, serializedState);
      if (!retryError) {
        return;
      }
      lastError = retryError;
    }

    const lightweightState: CloudSyncLocalState = {
      storageId,
      deviceId,
      lastSyncAt,
      lastKnownRevision: snapshot.revision
    };
    const lightweightError = this.trySaveLocalState(storageId, JSON.stringify(lightweightState));
    if (!lightweightError) {
      return;
    }

    console.warn('保存本地同步状态失败:', lightweightError || lastError);
  }

  private trySaveLocalState(storageId: string, serializedState: string): unknown | null {
    try {
      this.storage?.setItem(this.getLocalStateStorageKey(storageId), serializedState);
      return null;
    } catch (error) {
      return error;
    }
  }

  private recordConflictLog(
    storageId: string,
    conflicts: CloudSyncConflict[],
    metadata: {
      detectedAt: string;
      localRevision?: string;
      remoteRevision?: string;
      resolvedRevision?: string;
    }
  ): void {
    if (!this.storage || conflicts.length === 0) {
      return;
    }

    const entry: CloudSyncConflictLogEntry = {
      id: [
        metadata.detectedAt,
        storageId,
        metadata.resolvedRevision || metadata.remoteRevision || 'unknown',
        String(conflicts.length)
      ].join(':'),
      storageId,
      detectedAt: metadata.detectedAt,
      localRevision: metadata.localRevision,
      remoteRevision: metadata.remoteRevision,
      resolvedRevision: metadata.resolvedRevision,
      conflicts: sanitizeCloudSyncConflictsForMetadata(conflicts)
    };

    const entries = [entry, ...this.getConflictLog()]
      .slice(0, MAX_CONFLICT_LOG_ENTRIES);
    try {
      this.storage.setItem(CONFLICT_LOG_STORAGE_KEY, JSON.stringify(entries));
      this.updateStatus({ conflictLogCount: entries.length });
    } catch (error) {
      console.warn('同步冲突审计记录保存失败:', error);
    }
  }

  private getLocalStateStorageKey(storageId: string): string {
    return `${LOCAL_STATE_STORAGE_PREFIX}:${storageId}`;
  }

  private clearNoncriticalSyncStorageForRetry(): boolean {
    if (!this.storage) {
      return false;
    }

    try {
      this.storage.removeItem(CONFLICT_LOG_STORAGE_KEY);
      this.updateStatus({ conflictLogCount: 0 });
      return true;
    } catch (error) {
      console.warn('清理非关键同步缓存失败:', error);
      return false;
    }
  }
}

function normalizeConflictLogEntry(value: unknown): CloudSyncConflictLogEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const entry = value as Partial<CloudSyncConflictLogEntry>;
  if (
    typeof entry.id !== 'string' ||
    typeof entry.storageId !== 'string' ||
    typeof entry.detectedAt !== 'string' ||
    !Array.isArray(entry.conflicts)
  ) {
    return null;
  }

  return {
    id: entry.id,
    storageId: entry.storageId,
    detectedAt: entry.detectedAt,
    localRevision: typeof entry.localRevision === 'string' ? entry.localRevision : undefined,
    remoteRevision: typeof entry.remoteRevision === 'string' ? entry.remoteRevision : undefined,
    resolvedRevision: typeof entry.resolvedRevision === 'string' ? entry.resolvedRevision : undefined,
    conflicts: sanitizeCloudSyncConflictsForMetadata(entry.conflicts)
  };
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

function normalizeAutoSyncOptions(options: CloudSyncAutoOptions): CloudSyncAutoOptions {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_REMOTE_POLL_INTERVAL_MS;
  return {
    ...options,
    debounceMs: options.debounceMs ?? DEFAULT_AUTO_SYNC_DEBOUNCE_MS,
    pollIntervalMs,
    retryMs: options.retryMs ?? pollIntervalMs
  };
}

export function normalizeCloudSyncIntervalMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) {
    return DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES;
  }

  return Math.min(
    MAX_CLOUD_SYNC_INTERVAL_MINUTES,
    Math.max(MIN_CLOUD_SYNC_INTERVAL_MINUTES, Math.round(minutes))
  );
}

function minutesToMs(minutes: number): number {
  return normalizeCloudSyncIntervalMinutes(minutes) * 60 * 1000;
}

export function getCloudSyncResultMessage(action?: string, conflictCount = 0): string {
  const suffix = conflictCount > 0 ? `，已自动处理 ${conflictCount} 个冲突` : '';
  if (action === 'uploaded') return `同步完成，已上传本机数据${suffix}`;
  if (action === 'downloaded') return `同步完成，已更新本机数据${suffix}`;
  if (action === 'merged') return `同步完成，已合并本机和云端数据${suffix}`;
  return `同步完成，数据已是最新${suffix}`;
}

export function getFriendlyCloudSyncError(error?: string): string {
  if (!error) return '同步失败，请稍后重试';
  if (error.includes('401') || error.includes('Unauthorized') || error.includes('403')) {
    return '存储服务认证失败，请检查用户名和密码是否正确';
  }
  if (
    error.includes('ECONNRESET') ||
    error.includes('ECONNREFUSED') ||
    error.includes('ENOTFOUND') ||
    error.includes('EAI_AGAIN') ||
    error.includes('ETIMEDOUT') ||
    error.includes('TLS connection') ||
    error.includes('socket disconnected') ||
    error.includes('Network') ||
    error.includes('network')
  ) {
    return '暂时无法连接到云存储，应用会按同步周期自动重试';
  }
  if (error.includes('数据库') || error.includes('database')) {
    return '读取或写入本地数据失败，请重启应用后再试';
  }
  return `同步失败：${error}`;
}

function hasRemoteRevisionChanged(
  previousSnapshot: CloudSyncSnapshot,
  latestSnapshot?: CloudSyncSnapshot
): boolean {
  return !!latestSnapshot && latestSnapshot.revision !== previousSnapshot.revision;
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
