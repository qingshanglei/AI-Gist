import { PlatformDetector } from '@shared/platform';
import type { ExportResult, ImportResult } from '@shared/types/data-management';
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

const DEVICE_ID_STORAGE_KEY = 'ai_gist_cloud_sync_device_id';
const LOCAL_STATE_STORAGE_PREFIX = 'ai_gist_cloud_sync_state';

export type CloudSyncAction = 'uploaded' | 'downloaded' | 'merged' | 'noop';

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

export interface CloudSyncLocalState {
  storageId: string;
  deviceId: string;
  lastSyncAt: string;
  lastKnownRevision?: string;
  baseSnapshot?: CloudSyncSnapshot;
}

export interface CloudSyncServiceDeps {
  cloudClient?: CloudSyncCloudClient;
  database?: CloudSyncDatabaseClient;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  createDeviceId?: () => string;
}

export class CloudSyncService {
  private static instance: CloudSyncService;
  private readonly cloudClient?: CloudSyncCloudClient;
  private readonly database: CloudSyncDatabaseClient;
  private readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  private readonly createDeviceId: () => string;
  private readonly runningSyncs = new Map<string, Promise<CloudSyncResult>>();

  constructor(deps: CloudSyncServiceDeps = {}) {
    this.cloudClient = deps.cloudClient;
    this.database = deps.database || DatabaseServiceManager.getInstance();
    this.storage = deps.storage || getBrowserStorage();
    this.createDeviceId = deps.createDeviceId || generateUUID;
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

    const syncPromise = this.performSync(storageId, options)
      .finally(() => this.runningSyncs.delete(storageId));
    this.runningSyncs.set(storageId, syncPromise);
    return syncPromise;
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
        const importResult = await this.database.replaceAllData(mergedData);
        if (!importResult.success) {
          throw new Error(importResult.error || importResult.message || '同步合并数据写入本地失败');
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
