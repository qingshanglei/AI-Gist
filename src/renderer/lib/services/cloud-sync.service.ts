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
  createCloudSyncSemanticChecksum,
  createCloudSyncSnapshot,
  mergeCloudSyncData,
  normalizeCloudSyncDataSet,
  validateCloudSyncSnapshot
} from '@shared/cloud-sync-engine';
import type {
  CloudSyncManifest,
  CloudSyncManifestSaveOptions,
  CloudSyncManifestSaveResult
} from '@shared/cloud-sync-manifest';
import {
  createEmptyCloudSyncManifest,
  getCloudSyncManifestRepairMetadata,
  getCloudSyncManifestRevision,
  isCloudSyncManifestCorruptionError,
  sanitizeCloudSyncConflictsForMetadata,
  updateCloudSyncManifestDevice
} from '@shared/cloud-sync-manifest';
import type {
  CloudSyncRemoteSnapshotInfo
} from '@shared/cloud-sync-snapshots';
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
const DEFAULT_AUTO_SYNC_DEBOUNCE_MS = 5000;
const DEFAULT_REMOTE_POLL_INTERVAL_MS = DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES * 60 * 1000;
const DEFAULT_AUTO_SYNC_RETRY_MS = DEFAULT_REMOTE_POLL_INTERVAL_MS;
const DEFAULT_STARTUP_SYNC_DELAY_MS = 10000;
const MAX_AUTO_SYNC_RETRY_MS = 60 * 60 * 1000;
const MAX_REMOTE_RECHECK_ATTEMPTS = 3;
const READ_AFTER_WRITE_VERIFY_ATTEMPTS = 4;
const READ_AFTER_WRITE_VERIFY_RETRY_MS = 120;
const MAX_REMOTE_SNAPSHOT_SCAN = 20;
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
  saveCloudSyncManifest(
    storageId: string,
    manifest: CloudSyncManifest,
    options?: CloudSyncManifestSaveOptions
  ): Promise<CloudSyncManifestSaveResult>;
  listCloudSyncSnapshots?(storageId: string): Promise<CloudSyncRemoteSnapshotInfo[]>;
  readCloudSyncSnapshot?(
    storageId: string,
    snapshot: CloudSyncRemoteSnapshotInfo | string
  ): Promise<CloudSyncSnapshot>;
  saveCloudSyncSnapshot?(storageId: string, snapshot: CloudSyncSnapshot): Promise<{ success: boolean; error?: string }>;
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

export interface CloudSyncErrorDiagnosisContext {
  storageId?: string;
  reason?: CloudSyncRunReason;
  status?: CloudSyncLifecycleStatus;
  failureCount?: number;
  timestamp?: string;
}

export interface CloudSyncErrorDiagnosis {
  title: string;
  message: string;
  rawError: string;
  canAutoRetry: boolean;
  canUserFix: boolean;
  suggestedActions: string[];
  copyText: string;
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
      const manifestResult = await this.getManifestOrRecoverCorruption(storageId, localData, deviceId, now, options);
      if (manifestResult.result) {
        return manifestResult.result;
      }

      const manifest = manifestResult.manifest;
      const localState = this.getLocalState(storageId);
      const remoteSnapshot = manifest.latestSnapshot;
      const manifestRepairMetadata = getCloudSyncManifestRepairMetadata(manifest);
      if (remoteSnapshot) {
        this.assertValidRemoteSnapshot(remoteSnapshot);
      }

      if (!remoteSnapshot) {
        const latestManifest = await this.getCloudClient().getCloudSyncManifest(storageId);
        if (latestManifest.latestSnapshot) {
          return await this.retryWithLatestRemote(storageId, options, attempt);
        }

        const snapshot = createCloudSyncSnapshot(localData, deviceId);
        try {
          await this.saveManifest(
            storageId,
            this.buildManifest(latestManifest, snapshot, [], deviceId, now, options),
            getCloudSyncManifestRevision(latestManifest)
          );
        } catch (error) {
          if (isCloudSyncRemoteChangedError(error)) {
            return await this.retryAfterManifestConflict(
              storageId,
              options,
              attempt,
              snapshot,
              false
            );
          }
          throw error;
        }
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
        if (manifestRepairMetadata) {
          try {
            await this.saveManifest(
              storageId,
              this.buildManifest(manifest, remoteSnapshot, mergeResult.conflicts, deviceId, now, options),
              getCloudSyncManifestRevision(manifest)
            );
          } catch (error) {
            if (isCloudSyncRemoteChangedError(error)) {
              return await this.retryAfterManifestConflict(
                storageId,
                options,
                attempt,
                remoteSnapshot,
                false
              );
            }
            throw error;
          }
        }

        this.recordConflictLog(storageId, mergeResult.conflicts, {
          detectedAt: now,
          localRevision: localState?.lastKnownRevision,
          remoteRevision: remoteSnapshot.revision,
          resolvedRevision: remoteSnapshot.revision
        });
        this.saveLocalState(storageId, deviceId, remoteSnapshot, now);
        return {
          success: true,
          action: manifestRepairMetadata ? 'uploaded' : 'noop',
          localRevision: remoteSnapshot.revision,
          remoteRevision: remoteSnapshot.revision,
          appliedLocal: false,
          uploadedRemote: !!manifestRepairMetadata,
          conflicts: mergeResult.conflicts,
          summary: mergeResult.summary
        };
      }

      let finalSnapshot = remoteSnapshot;
      let latestManifestForUpload: CloudSyncManifest | null = null;
      if (!mergedEqualsRemote) {
        const latestManifest = await this.getCloudClient().getCloudSyncManifest(storageId);
        if (
          hasRemoteRevisionChanged(remoteSnapshot, latestManifest.latestSnapshot) &&
          hasRemoteDataChanged(remoteData, latestManifest.latestSnapshot)
        ) {
          return await this.retryWithLatestRemote(storageId, options, attempt);
        }

        latestManifestForUpload = latestManifest;
        finalSnapshot = createCloudSyncSnapshot(mergedData, deviceId);
      } else if (manifestRepairMetadata) {
        latestManifestForUpload = manifest;
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
        try {
          await this.saveManifest(
            storageId,
            this.buildManifest(latestManifestForUpload, finalSnapshot, mergeResult.conflicts, deviceId, now, options),
            getCloudSyncManifestRevision(latestManifestForUpload)
          );
        } catch (error) {
          if (isCloudSyncRemoteChangedError(error)) {
            return await this.retryAfterManifestConflict(
              storageId,
              options,
              attempt,
              finalSnapshot,
              appliedLocal
            );
          }
          throw error;
        }
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
    return normalizeCloudSyncDataSet(applyCloudSyncTombstones(exportResult.data));
  }

  private async retryWithLatestRemote(
    storageId: string,
    options: CloudSyncOptions,
    attempt: number
  ): Promise<CloudSyncResult> {
    if (attempt + 1 >= MAX_REMOTE_RECHECK_ATTEMPTS) {
      throw new Error('云端同步文件状态持续变化，应用会在下个同步周期自动重试');
    }

    return await this.performSync(storageId, options, attempt + 1);
  }

  private async retryAfterManifestConflict(
    storageId: string,
    options: CloudSyncOptions,
    attempt: number,
    submittedSnapshot: CloudSyncSnapshot,
    appliedLocal: boolean
  ): Promise<CloudSyncResult> {
    const retryResult = await this.retryWithLatestRemote(storageId, options, attempt);
    if (
      retryResult.success &&
      retryResult.remoteRevision === submittedSnapshot.revision
    ) {
      const finalAppliedLocal = appliedLocal || retryResult.appliedLocal;
      return {
        ...retryResult,
        action: getSyncAction(finalAppliedLocal, true),
        localRevision: submittedSnapshot.revision,
        remoteRevision: submittedSnapshot.revision,
        appliedLocal: finalAppliedLocal,
        uploadedRemote: true
      };
    }

    return retryResult;
  }

  private async getManifestOrRecoverCorruption(
    storageId: string,
    localData: CloudSyncDataSet,
    deviceId: string,
    now: string,
    options: CloudSyncOptions
  ): Promise<{ manifest: CloudSyncManifest; result?: CloudSyncResult }> {
    try {
      const manifest = await this.getCloudClient().getCloudSyncManifest(storageId);
      return {
        manifest: await this.repairManifestFromSnapshotFiles(storageId, manifest, deviceId, now, options, {
          required: !manifest.latestSnapshot
        })
      };
    } catch (error) {
      if (!isRecoverableCloudSyncManifestCorruption(error)) {
        throw error;
      }

      const recoveredManifest = await this.recoverManifestFromSnapshotFiles(storageId, deviceId, now, options);
      if (recoveredManifest) {
        return { manifest: recoveredManifest };
      }

      const snapshot = createCloudSyncSnapshot(localData, deviceId);
      const rebuiltManifest = this.buildManifest(
        createEmptyCloudSyncManifest(now),
        snapshot,
        [],
        deviceId,
        now,
        options
      );

      await this.overwriteManifest(storageId, rebuiltManifest);
      this.saveLocalState(storageId, deviceId, snapshot, now);

      return {
        manifest: rebuiltManifest,
        result: {
          success: true,
          action: 'uploaded',
          localRevision: snapshot.revision,
          remoteRevision: snapshot.revision,
          appliedLocal: false,
          uploadedRemote: true,
          conflicts: [],
          summary: createEmptySummary()
        }
      };
    }
  }

  private async repairManifestFromSnapshotFiles(
    storageId: string,
    manifest: CloudSyncManifest,
    deviceId: string,
    now: string,
    options: CloudSyncOptions,
    readOptions: { required: boolean }
  ): Promise<CloudSyncManifest> {
    const newestSnapshot = await this.getNewestRemoteSnapshot(storageId, readOptions);
    if (!newestSnapshot) {
      return manifest;
    }

    const manifestSnapshot = manifest.latestSnapshot;
    if (
      manifestSnapshot &&
      !isCloudSyncSnapshotNewer(newestSnapshot, manifestSnapshot)
    ) {
      return manifest;
    }

    const repairedManifest = this.buildManifest(
      manifest,
      newestSnapshot,
      manifest.conflicts || [],
      deviceId,
      now,
      options
    );

    try {
      await this.overwriteManifest(storageId, repairedManifest);
    } catch (error) {
      if (readOptions.required) {
        throw error;
      }
    }

    return repairedManifest;
  }

  private async recoverManifestFromSnapshotFiles(
    storageId: string,
    deviceId: string,
    now: string,
    options: CloudSyncOptions
  ): Promise<CloudSyncManifest | null> {
    const newestSnapshot = await this.getNewestRemoteSnapshot(storageId, { required: true });
    if (!newestSnapshot) {
      return null;
    }

    const recoveredManifest = this.buildManifest(
      createEmptyCloudSyncManifest(now),
      newestSnapshot,
      [],
      deviceId,
      now,
      options
    );
    await this.overwriteManifest(storageId, recoveredManifest);
    return recoveredManifest;
  }

  private async getNewestRemoteSnapshot(
    storageId: string,
    options: { required: boolean }
  ): Promise<CloudSyncSnapshot | null> {
    const cloudClient = this.getCloudClient();
    if (!cloudClient.listCloudSyncSnapshots || !cloudClient.readCloudSyncSnapshot) {
      return null;
    }

    let snapshotInfos: CloudSyncRemoteSnapshotInfo[];
    try {
      snapshotInfos = await cloudClient.listCloudSyncSnapshots(storageId);
    } catch (error) {
      if (options.required) {
        throw error;
      }
      return null;
    }

    let newestSnapshot: CloudSyncSnapshot | null = null;
    const candidates = [...snapshotInfos]
      .sort(compareRemoteSnapshotInfoDescending)
      .slice(0, MAX_REMOTE_SNAPSHOT_SCAN);
    let lastSnapshotError: unknown;

    for (const snapshotInfo of candidates) {
      try {
        const snapshot = await cloudClient.readCloudSyncSnapshot(storageId, snapshotInfo);
        this.assertValidRemoteSnapshot(snapshot);
        if (!newestSnapshot || isCloudSyncSnapshotNewer(snapshot, newestSnapshot)) {
          newestSnapshot = snapshot;
        }
      } catch (error) {
        lastSnapshotError = error;
        if (options.required && snapshotInfos.length === 1) {
          throw error;
        }
      }
    }

    if (options.required && snapshotInfos.length > 0 && !newestSnapshot && lastSnapshotError) {
      throw lastSnapshotError;
    }

    return newestSnapshot;
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

  private async saveManifest(
    storageId: string,
    manifest: CloudSyncManifest,
    expectedRevision: string | null
  ): Promise<void> {
    const cloudClient = this.getCloudClient();
    await this.saveSnapshotFileIfSupported(storageId, manifest.latestSnapshot);
    const result = await cloudClient.saveCloudSyncManifest(storageId, manifest, {
      expectedRevision
    });
    if (!result.success) {
      if (result.conflict || isCloudSyncRevisionConflictMessage(result.error)) {
        throw new CloudSyncRemoteChangedError(result.error || '云端同步文件已被其他设备更新');
      }
      throw new Error(result.error || '保存云同步 manifest 失败');
    }

    await this.verifySavedManifest(storageId, manifest);
  }

  private async overwriteManifest(
    storageId: string,
    manifest: CloudSyncManifest
  ): Promise<void> {
    await this.saveSnapshotFileIfSupported(storageId, manifest.latestSnapshot);
    const result = await this.getCloudClient().saveCloudSyncManifest(storageId, manifest);
    if (!result.success) {
      throw new Error(result.error || '重建云同步 manifest 失败');
    }

    await this.verifySavedManifest(storageId, manifest);
  }

  private async saveSnapshotFileIfSupported(
    storageId: string,
    snapshot?: CloudSyncSnapshot
  ): Promise<void> {
    if (!snapshot) {
      return;
    }

    const cloudClient = this.getCloudClient();
    if (!cloudClient.saveCloudSyncSnapshot) {
      return;
    }

    const result = await cloudClient.saveCloudSyncSnapshot(storageId, snapshot);
    if (!result.success) {
      throw new Error(result.error || '保存云同步快照失败');
    }
  }

  private async verifySavedManifest(
    storageId: string,
    manifest: CloudSyncManifest
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < READ_AFTER_WRITE_VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await delay(READ_AFTER_WRITE_VERIFY_RETRY_MS * attempt);
      }

      try {
        await this.verifySavedManifestOnce(storageId, manifest);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async verifySavedManifestOnce(
    storageId: string,
    manifest: CloudSyncManifest
  ): Promise<void> {
    const expectedSnapshot = manifest.latestSnapshot;
    if (!expectedSnapshot) {
      return;
    }

    const savedSnapshotFile = await this.readSnapshotFileIfSupported(storageId, expectedSnapshot.revision);
    if (savedSnapshotFile) {
      this.assertSavedSnapshotMatches(savedSnapshotFile, expectedSnapshot, '云同步快照文件');
      return;
    }

    const savedManifest = await this.getCloudClient().getCloudSyncManifest(storageId);
    const savedSnapshot = savedManifest.latestSnapshot;
    if (!savedSnapshot) {
      throw new Error(
        `云同步 manifest 保存后校验失败：期望 revision ${expectedSnapshot.revision}，实际 空`
      );
    }

    this.assertSavedSnapshotMatches(savedSnapshot, expectedSnapshot, '云同步 manifest');
  }

  private async readSnapshotFileIfSupported(
    storageId: string,
    revision: string
  ): Promise<CloudSyncSnapshot | null> {
    const cloudClient = this.getCloudClient();
    if (!cloudClient.readCloudSyncSnapshot) {
      return null;
    }

    try {
      return await cloudClient.readCloudSyncSnapshot(storageId, revision);
    } catch {
      return null;
    }
  }

  private assertSavedSnapshotMatches(
    savedSnapshot: CloudSyncSnapshot,
    expectedSnapshot: CloudSyncSnapshot,
    sourceName: string
  ): void {
    this.assertValidSavedSnapshot(savedSnapshot);

    if (savedSnapshot.revision !== expectedSnapshot.revision) {
      throw new Error(
        `${sourceName} 保存后校验失败：期望 revision ${expectedSnapshot.revision}，实际 ${savedSnapshot.revision}`
      );
    }

    if (
      expectedSnapshot.dataChecksum &&
      savedSnapshot.dataChecksum !== expectedSnapshot.dataChecksum
    ) {
      throw new Error(
        `${sourceName} 保存后数据校验失败：期望 checksum ${expectedSnapshot.dataChecksum}，` +
        `实际 ${savedSnapshot.dataChecksum || '空'}`
      );
    }

    if (!dataSetsEqual(savedSnapshot.data, expectedSnapshot.data)) {
      throw new Error(`${sourceName} 保存后数据校验失败：云端快照内容与本地提交不一致`);
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
        saveCloudSyncManifest: (storageId, manifest, options) =>
          CloudBackupAPI.saveCloudSyncManifest(storageId, manifest, options),
        listCloudSyncSnapshots: storageId => CloudBackupAPI.listCloudSyncSnapshots(storageId),
        readCloudSyncSnapshot: (storageId, snapshot) => CloudBackupAPI.readCloudSyncSnapshot(storageId, snapshot),
        saveCloudSyncSnapshot: (storageId, snapshot) => CloudBackupAPI.saveCloudSyncSnapshot(storageId, snapshot)
      };
    }

    if (PlatformDetector.isWeb()) {
      return {
        getCloudSyncManifest: storageId => webCloudBackupService.getCloudSyncManifest(storageId),
        saveCloudSyncManifest: (storageId, manifest, options) =>
          webCloudBackupService.saveCloudSyncManifest(storageId, manifest, options),
        listCloudSyncSnapshots: storageId => webCloudBackupService.listCloudSyncSnapshots(storageId),
        readCloudSyncSnapshot: (storageId, snapshot) => webCloudBackupService.readCloudSyncSnapshot(storageId, snapshot),
        saveCloudSyncSnapshot: (storageId, snapshot) => webCloudBackupService.saveCloudSyncSnapshot(storageId, snapshot)
      };
    }

    return {
      getCloudSyncManifest: storageId => mobileCloudBackupService.getCloudSyncManifest(storageId),
      saveCloudSyncManifest: (storageId, manifest, options) =>
        mobileCloudBackupService.saveCloudSyncManifest(storageId, manifest, options),
      listCloudSyncSnapshots: storageId => mobileCloudBackupService.listCloudSyncSnapshots(storageId),
      readCloudSyncSnapshot: (storageId, snapshot) => mobileCloudBackupService.readCloudSyncSnapshot(storageId, snapshot),
      saveCloudSyncSnapshot: (storageId, snapshot) => mobileCloudBackupService.saveCloudSyncSnapshot(storageId, snapshot)
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

    if (reason === 'local-change') {
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

export function getCloudSyncResultMessage(action?: string, _conflictCount = 0): string {
  if (action === 'uploaded') return '同步完成，已上传本机数据';
  if (action === 'downloaded') return '同步完成，已更新本机数据';
  if (action === 'merged') return '同步完成，已合并本机和云端数据';
  return '同步完成，数据已是最新';
}

export function getCloudSyncErrorDiagnosis(
  error?: string,
  context: CloudSyncErrorDiagnosisContext = {}
): CloudSyncErrorDiagnosis {
  const rawError = normalizeCloudSyncError(error);
  let title = '同步遇到问题';
  let message = '同步失败，请稍后重试；如果反复出现，请复制错误详情反馈。';
  let canAutoRetry = false;
  let canUserFix = false;
  let suggestedActions = [
    '再次点击立即同步',
    '复制错误详情并反馈'
  ];

  if (isCloudSyncInstabilityError(rawError)) {
    title = '云端同步状态暂时不一致';
    message = '应用会保留本机数据并自动重试；如果持续出现，请查看详情复制诊断信息。';
    canAutoRetry = true;
    suggestedActions = [
      '等待下一次自动同步或稍后手动重试',
      '确认同一个云同步目录没有被其他工具或旧版本应用改写',
      '复制错误详情并反馈'
    ];
  } else if (isCloudSyncAuthError(rawError)) {
    title = '云存储认证失败';
    message = '存储服务拒绝了访问，请检查 WebDAV 用户名、密码或授权状态。';
    canUserFix = true;
    suggestedActions = [
      '重新输入 WebDAV 用户名和密码',
      '确认账号仍有访问同步目录的权限',
      '保存配置后重新测试连接'
    ];
  } else if (isCloudSyncNetworkError(rawError)) {
    title = '无法连接到云存储';
    message = '当前网络或云存储服务暂时不可用，应用会按同步周期自动重试。';
    canAutoRetry = true;
    canUserFix = true;
    suggestedActions = [
      '检查网络连接和 WebDAV 服务器地址',
      '确认代理、证书或服务器状态正常',
      '稍后重试同步'
    ];
  } else if (isCloudSyncPathError(rawError)) {
    title = '云端同步目录不可用';
    message = '同步目录无法读取或不存在，请检查 WebDAV/iCloud 路径配置。';
    canUserFix = true;
    suggestedActions = [
      '检查云存储目录路径是否存在',
      '确认应用拥有读取和写入权限',
      '保存配置后重新同步'
    ];
  } else if (isCloudSyncDatabaseError(rawError)) {
    title = '本地数据读写失败';
    message = '读取或写入本地数据库失败，请重启应用后重试；若仍失败请复制错误详情反馈。';
    suggestedActions = [
      '重启应用后重新同步',
      '确认本机磁盘空间充足',
      '复制错误详情并反馈'
    ];
  }

  return {
    title,
    message,
    rawError,
    canAutoRetry,
    canUserFix,
    suggestedActions,
    copyText: createCloudSyncErrorReport(rawError, context, {
      title,
      message,
      canAutoRetry,
      canUserFix,
      suggestedActions
    })
  };
}

export function getFriendlyCloudSyncError(error?: string): string {
  return getCloudSyncErrorDiagnosis(error).message;
}

function normalizeCloudSyncError(error?: string): string {
  if (!error || !error.trim()) {
    return '未知错误';
  }

  return error.trim();
}

function isCloudSyncInstabilityError(error: string): boolean {
  if (
    error.includes('云端同步文件状态持续变化') ||
    error.includes('云同步 manifest 保存后校验失败') ||
    error.includes('云同步 manifest 保存后数据校验失败') ||
    error.includes('云同步快照文件 保存后')
  ) {
    return true;
  }

  return false;
}

function isCloudSyncAuthError(error: string): boolean {
  return error.includes('401') || error.includes('Unauthorized') || error.includes('403');
}

function isCloudSyncNetworkError(error: string): boolean {
  return (
    error.includes('ECONNRESET') ||
    error.includes('ECONNREFUSED') ||
    error.includes('ENOTFOUND') ||
    error.includes('EAI_AGAIN') ||
    error.includes('ETIMEDOUT') ||
    error.includes('TLS connection') ||
    error.includes('socket disconnected') ||
    error.includes('Network') ||
    error.includes('network') ||
    error.includes('fetch failed')
  );
}

function isCloudSyncPathError(error: string): boolean {
  return (
    error.includes('404') ||
    error.includes('Not Found') ||
    error.includes('not found') ||
    error.includes('目录不存在') ||
    error.includes('路径不存在')
  );
}

function isCloudSyncDatabaseError(error: string): boolean {
  return error.includes('数据库') || error.includes('database');
}

function createCloudSyncErrorReport(
  rawError: string,
  context: CloudSyncErrorDiagnosisContext,
  diagnosis: Omit<CloudSyncErrorDiagnosis, 'rawError' | 'copyText'>
): string {
  const lines = [
    'AI-Gist 云同步错误诊断',
    `时间: ${context.timestamp || new Date().toISOString()}`,
    `平台: ${PlatformDetector.getPlatform()}`,
    `标题: ${diagnosis.title}`,
    `说明: ${diagnosis.message}`,
    `自动重试: ${diagnosis.canAutoRetry ? '是' : '否'}`,
    `用户可处理: ${diagnosis.canUserFix ? '是' : '否'}`
  ];

  if (context.storageId) {
    lines.push(`存储配置 ID: ${context.storageId}`);
  }

  if (context.reason) {
    lines.push(`触发原因: ${context.reason}`);
  }

  if (context.status) {
    lines.push(`同步状态: ${context.status}`);
  }

  if (typeof context.failureCount === 'number') {
    lines.push(`连续失败次数: ${context.failureCount}`);
  }

  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    lines.push(`User-Agent: ${navigator.userAgent}`);
  }

  lines.push(
    '',
    '建议操作:',
    ...diagnosis.suggestedActions.map(action => `- ${action}`),
    '',
    '原始错误:',
    rawError
  );

  return lines.join('\n');
}

function hasRemoteRevisionChanged(
  previousSnapshot: CloudSyncSnapshot,
  latestSnapshot?: CloudSyncSnapshot
): boolean {
  return !!latestSnapshot && latestSnapshot.revision !== previousSnapshot.revision;
}

function hasRemoteDataChanged(
  previousRemoteData: CloudSyncDataSet,
  latestSnapshot?: CloudSyncSnapshot
): boolean {
  if (!latestSnapshot) {
    return false;
  }

  return !dataSetsEqual(previousRemoteData, applyCloudSyncTombstones(latestSnapshot.data));
}

function compareRemoteSnapshotInfoDescending(
  left: CloudSyncRemoteSnapshotInfo,
  right: CloudSyncRemoteSnapshotInfo
): number {
  const timeDiff = getRemoteSnapshotInfoTime(right) - getRemoteSnapshotInfoTime(left);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  return right.revision.localeCompare(left.revision);
}

function isCloudSyncSnapshotNewer(left: CloudSyncSnapshot, right: CloudSyncSnapshot): boolean {
  const leftTime = getCloudSyncSnapshotTime(left);
  const rightTime = getCloudSyncSnapshotTime(right);
  if (leftTime !== rightTime) {
    return leftTime > rightTime;
  }

  return left.revision.localeCompare(right.revision) > 0;
}

function getRemoteSnapshotInfoTime(info: CloudSyncRemoteSnapshotInfo): number {
  const modifiedAtTime = info.modifiedAt ? new Date(info.modifiedAt).getTime() : Number.NaN;
  return Number.isNaN(modifiedAtTime) ? 0 : modifiedAtTime;
}

function getCloudSyncSnapshotTime(snapshot: CloudSyncSnapshot): number {
  const createdAtTime = new Date(snapshot.createdAt).getTime();
  return Number.isNaN(createdAtTime) ? 0 : createdAtTime;
}

class CloudSyncRemoteChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudSyncRemoteChangedError';
  }
}

function isCloudSyncRemoteChangedError(error: unknown): error is CloudSyncRemoteChangedError {
  return error instanceof CloudSyncRemoteChangedError ||
    (error instanceof Error && error.name === 'CloudSyncRemoteChangedError');
}

function isCloudSyncRevisionConflictMessage(message: string | undefined): boolean {
  return !!message && /manifest 已被其他设备更新|已被其他设备更新|Precondition|412|revision/i.test(message);
}

function isRecoverableCloudSyncManifestCorruption(error: unknown): boolean {
  if (isCloudSyncManifestCorruptionError(error)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|Unauthorized|Forbidden|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|TLS connection|socket disconnected|Network|network/i.test(message)) {
    return false;
  }

  return /读取云同步 manifest 失败.*内容无效|sync-manifest\.json.*checksum mismatch|sync-manifest\.backup\.json.*checksum mismatch|Unexpected token|JSON/i
    .test(message);
}

function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  return createCloudSyncSemanticChecksum(left) === createCloudSyncSemanticChecksum(right);
}

export const cloudSyncService = CloudSyncService.getInstance();
