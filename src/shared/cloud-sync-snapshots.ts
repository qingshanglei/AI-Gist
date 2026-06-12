import type { CloudSyncSnapshot } from './cloud-sync-engine';
import {
  createCloudSyncDataChecksum,
  normalizeCloudSyncDataSet,
  validateCloudSyncSnapshot
} from './cloud-sync-engine';

export const CLOUD_SYNC_SNAPSHOT_FILE_KIND = 'ai-gist-cloud-sync-snapshot';
export const CLOUD_SYNC_SNAPSHOT_FILE_SCHEMA_VERSION = 1;

export interface CloudSyncSnapshotFile {
  kind: typeof CLOUD_SYNC_SNAPSHOT_FILE_KIND;
  schemaVersion: typeof CLOUD_SYNC_SNAPSHOT_FILE_SCHEMA_VERSION;
  snapshot: CloudSyncSnapshot;
}

export interface CloudSyncRemoteSnapshotInfo {
  revision: string;
  path: string;
  createdAt?: string;
  modifiedAt?: string;
  size?: number;
}

export function createCloudSyncSnapshotFile(snapshot: CloudSyncSnapshot): CloudSyncSnapshotFile {
  return {
    kind: CLOUD_SYNC_SNAPSHOT_FILE_KIND,
    schemaVersion: CLOUD_SYNC_SNAPSHOT_FILE_SCHEMA_VERSION,
    snapshot: normalizeCloudSyncSnapshotForFile(snapshot)
  };
}

export function assertValidCloudSyncSnapshotFile(input: unknown): CloudSyncSnapshot {
  const snapshot = unwrapCloudSyncSnapshotFile(input);
  const validation = validateCloudSyncSnapshot(snapshot);
  if (!validation.valid) {
    throw new Error(validation.reason || 'cloud sync snapshot file is invalid');
  }

  return normalizeCloudSyncSnapshotForFile(snapshot as CloudSyncSnapshot);
}

export function selectNewestCloudSyncSnapshotInfo(
  snapshots: CloudSyncRemoteSnapshotInfo[]
): CloudSyncRemoteSnapshotInfo | null {
  if (snapshots.length === 0) {
    return null;
  }

  return [...snapshots].sort(compareCloudSyncSnapshotInfoDescending)[0] || null;
}

export function compareCloudSyncSnapshotInfoDescending(
  left: CloudSyncRemoteSnapshotInfo,
  right: CloudSyncRemoteSnapshotInfo
): number {
  const leftTime = getSnapshotInfoTime(left);
  const rightTime = getSnapshotInfoTime(right);
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  return right.revision.localeCompare(left.revision);
}

function unwrapCloudSyncSnapshotFile(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const value = input as Partial<CloudSyncSnapshotFile>;
  if (value.kind === CLOUD_SYNC_SNAPSHOT_FILE_KIND) {
    if (value.schemaVersion !== CLOUD_SYNC_SNAPSHOT_FILE_SCHEMA_VERSION) {
      throw new Error('cloud sync snapshot file schema version is unsupported');
    }
    return value.snapshot;
  }

  return input;
}

function normalizeCloudSyncSnapshotForFile(snapshot: CloudSyncSnapshot): CloudSyncSnapshot {
  const data = normalizeCloudSyncDataSet(snapshot.data);
  return {
    schemaVersion: 1,
    deviceId: snapshot.deviceId,
    revision: snapshot.revision,
    createdAt: snapshot.createdAt,
    data,
    dataChecksum: snapshot.dataChecksum || createCloudSyncDataChecksum(data)
  };
}

function getSnapshotInfoTime(info: CloudSyncRemoteSnapshotInfo): number {
  const createdAtTime = info.createdAt ? new Date(info.createdAt).getTime() : Number.NaN;
  if (!Number.isNaN(createdAtTime)) {
    return createdAtTime;
  }

  const modifiedAtTime = info.modifiedAt ? new Date(info.modifiedAt).getTime() : Number.NaN;
  return Number.isNaN(modifiedAtTime) ? 0 : modifiedAtTime;
}
