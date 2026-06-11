import type {
  CloudSyncConflict,
  CloudSyncSnapshot
} from './cloud-sync-engine';
import { validateCloudSyncSnapshot } from './cloud-sync-engine';

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

export interface CloudSyncManifestValidationResult {
  valid: boolean;
  reason?: string;
  manifest?: CloudSyncManifest;
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
    devices: normalizeDeviceStates(value.devices),
    conflicts: Array.isArray(value.conflicts) ? value.conflicts : []
  };
}

export function validateCloudSyncManifest(input: unknown): CloudSyncManifestValidationResult {
  if (!input || typeof input !== 'object') {
    return {
      valid: false,
      reason: 'manifest must be an object'
    };
  }

  const value = input as Partial<CloudSyncManifest>;
  if (value.kind !== undefined && value.kind !== CLOUD_SYNC_MANIFEST_KIND) {
    return {
      valid: false,
      reason: 'manifest kind is invalid'
    };
  }

  if (value.schemaVersion !== undefined && value.schemaVersion !== CLOUD_SYNC_MANIFEST_SCHEMA_VERSION) {
    return {
      valid: false,
      reason: 'manifest schema version is unsupported'
    };
  }

  const latestSnapshotValidation = validateOptionalSnapshot('latestSnapshot', value.latestSnapshot);
  if (!latestSnapshotValidation.valid) {
    return latestSnapshotValidation;
  }

  const baseSnapshotValidation = validateOptionalSnapshot('baseSnapshot', value.baseSnapshot);
  if (!baseSnapshotValidation.valid) {
    return baseSnapshotValidation;
  }

  return {
    valid: true,
    manifest: normalizeCloudSyncManifest(input)
  };
}

export function assertValidCloudSyncManifest(input: unknown): CloudSyncManifest {
  const result = validateCloudSyncManifest(input);
  if (!result.valid || !result.manifest) {
    throw new Error(result.reason || 'cloud sync manifest is invalid');
  }
  return result.manifest;
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
  return validateCloudSyncSnapshot(value).valid;
}

function validateOptionalSnapshot(
  fieldName: 'latestSnapshot' | 'baseSnapshot',
  value: unknown
): CloudSyncManifestValidationResult {
  if (value === undefined || value === null) {
    return { valid: true };
  }

  const snapshotValidation = validateCloudSyncSnapshot(value);
  if (!snapshotValidation.valid) {
    return {
      valid: false,
      reason: `${fieldName} ${snapshotValidation.reason || 'is invalid'}`
    };
  }

  return { valid: true };
}

function normalizeDeviceStates(input: unknown): Record<string, CloudSyncDeviceState> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  const devices: Record<string, CloudSyncDeviceState> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object') {
      continue;
    }

    const device = value as Partial<CloudSyncDeviceState>;
    if (typeof device.deviceId !== 'string' || typeof device.lastSyncAt !== 'string') {
      continue;
    }

    devices[key] = {
      deviceId: device.deviceId,
      deviceName: typeof device.deviceName === 'string' ? device.deviceName : undefined,
      platform: typeof device.platform === 'string' ? device.platform : undefined,
      lastSyncAt: device.lastSyncAt,
      lastKnownRevision: typeof device.lastKnownRevision === 'string' ? device.lastKnownRevision : undefined
    };
  }

  return devices;
}
