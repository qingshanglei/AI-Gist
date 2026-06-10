import type {
  CloudSyncConflict,
  CloudSyncSnapshot
} from './cloud-sync-engine';

export const CLOUD_SYNC_MANIFEST_KIND = 'ai-gist-cloud-sync-manifest';
export const CLOUD_SYNC_MANIFEST_SCHEMA_VERSION = 1;

export interface CloudSyncDeviceState {
  deviceId: string;
  deviceName?: string;
  platform?: string;
  lastSyncAt: string;
  lastKnownRevision?: string;
}

export interface CloudSyncManifest {
  kind: typeof CLOUD_SYNC_MANIFEST_KIND;
  schemaVersion: typeof CLOUD_SYNC_MANIFEST_SCHEMA_VERSION;
  updatedAt: string;
  latestSnapshot?: CloudSyncSnapshot;
  baseSnapshot?: CloudSyncSnapshot;
  devices: Record<string, CloudSyncDeviceState>;
  conflicts: CloudSyncConflict[];
}

export function createEmptyCloudSyncManifest(now = new Date().toISOString()): CloudSyncManifest {
  return {
    kind: CLOUD_SYNC_MANIFEST_KIND,
    schemaVersion: CLOUD_SYNC_MANIFEST_SCHEMA_VERSION,
    updatedAt: now,
    devices: {},
    conflicts: []
  };
}

export function normalizeCloudSyncManifest(input: unknown): CloudSyncManifest {
  if (!input || typeof input !== 'object') {
    return createEmptyCloudSyncManifest();
  }

  const value = input as Partial<CloudSyncManifest>;
  return {
    kind: CLOUD_SYNC_MANIFEST_KIND,
    schemaVersion: CLOUD_SYNC_MANIFEST_SCHEMA_VERSION,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    latestSnapshot: isCloudSyncSnapshot(value.latestSnapshot) ? value.latestSnapshot : undefined,
    baseSnapshot: isCloudSyncSnapshot(value.baseSnapshot) ? value.baseSnapshot : undefined,
    devices: value.devices && typeof value.devices === 'object' ? value.devices : {},
    conflicts: Array.isArray(value.conflicts) ? value.conflicts : []
  };
}

export function updateCloudSyncManifestDevice(
  manifest: CloudSyncManifest,
  device: CloudSyncDeviceState
): CloudSyncManifest {
  return {
    ...manifest,
    updatedAt: device.lastSyncAt,
    devices: {
      ...manifest.devices,
      [device.deviceId]: device
    }
  };
}

function isCloudSyncSnapshot(value: unknown): value is CloudSyncSnapshot {
  return !!value &&
    typeof value === 'object' &&
    (value as CloudSyncSnapshot).schemaVersion === 1 &&
    typeof (value as CloudSyncSnapshot).deviceId === 'string' &&
    typeof (value as CloudSyncSnapshot).revision === 'string' &&
    !!(value as CloudSyncSnapshot).data;
}
