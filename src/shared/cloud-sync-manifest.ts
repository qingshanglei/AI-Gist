import type {
  CloudSyncConflict,
  CloudSyncSnapshot
} from './cloud-sync-engine';
import { validateCloudSyncSnapshot } from './cloud-sync-engine';

export const CLOUD_SYNC_MANIFEST_KIND = 'ai-gist-cloud-sync-manifest';
export const CLOUD_SYNC_MANIFEST_SCHEMA_VERSION = 1;
const MAX_CONFLICT_METADATA_STRING_LENGTH = 512;
const MAX_CONFLICT_METADATA_ARRAY_ITEMS = 10;
const MAX_CONFLICT_METADATA_OBJECT_KEYS = 40;

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

export interface CloudSyncManifestFallbackReadOptions {
  readPrimary: () => Promise<CloudSyncManifest>;
  readBackup: () => Promise<CloudSyncManifest>;
  isNotFoundError?: (error: unknown) => boolean;
  describeError?: (error: unknown) => string;
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
    conflicts: sanitizeCloudSyncConflictsForMetadata(value.conflicts)
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

export async function readCloudSyncManifestWithFallback(
  options: CloudSyncManifestFallbackReadOptions
): Promise<CloudSyncManifest> {
  const isNotFoundError = options.isNotFoundError || isCloudSyncManifestNotFoundError;
  const describeError = options.describeError || describeCloudSyncManifestError;

  try {
    const primaryManifest = await options.readPrimary();
    try {
      const backupManifest = await options.readBackup();
      return selectNewestManifest(primaryManifest, backupManifest);
    } catch {
      return primaryManifest;
    }
  } catch (primaryError) {
    try {
      return await options.readBackup();
    } catch (backupError) {
      if (isNotFoundError(primaryError) && isNotFoundError(backupError)) {
        return createEmptyCloudSyncManifest();
      }

      throw new Error(
        `读取云同步 manifest 失败，且备份副本不可用: ${describeError(primaryError)}；` +
        `备份副本错误: ${describeError(backupError)}`
      );
    }
  }
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

function selectNewestManifest(
  primaryManifest: CloudSyncManifest,
  backupManifest: CloudSyncManifest
): CloudSyncManifest {
  return getManifestTime(backupManifest) > getManifestTime(primaryManifest)
    ? backupManifest
    : primaryManifest;
}

function getManifestTime(manifest: CloudSyncManifest): number {
  const candidates = [
    manifest.updatedAt,
    manifest.latestSnapshot?.createdAt,
    manifest.baseSnapshot?.createdAt
  ];

  for (const candidate of candidates) {
    const time = new Date(candidate || '').getTime();
    if (!Number.isNaN(time)) {
      return time;
    }
  }

  return 0;
}

export function sanitizeCloudSyncConflictsForMetadata(input: unknown): CloudSyncConflict[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map(conflict => sanitizeCloudSyncConflictForMetadata(conflict))
    .filter((conflict): conflict is CloudSyncConflict => !!conflict);
}

export function isCloudSyncManifestNotFoundError(error: unknown): boolean {
  const message = describeCloudSyncManifestError(error);
  return /404|not\s*found|no such file|does not exist|ENOENT|不存在|未找到/i.test(message);
}

function describeCloudSyncManifestError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function sanitizeCloudSyncConflictForMetadata(value: unknown): CloudSyncConflict | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const conflict = value as Partial<CloudSyncConflict>;
  if (
    typeof conflict.collection !== 'string' ||
    typeof conflict.key !== 'string' ||
    !isCloudSyncConflictReason(conflict.reason) ||
    !isCloudSyncResolution(conflict.resolution)
  ) {
    return null;
  }

  const sanitized: CloudSyncConflict = {
    collection: conflict.collection,
    key: conflict.key,
    reason: conflict.reason,
    resolution: conflict.resolution
  };

  if (conflict.local !== undefined) {
    sanitized.local = sanitizeConflictValueForMetadata(conflict.local);
  }
  if (conflict.remote !== undefined) {
    sanitized.remote = sanitizeConflictValueForMetadata(conflict.remote);
  }
  if (conflict.base !== undefined) {
    sanitized.base = sanitizeConflictValueForMetadata(conflict.base);
  }

  return sanitized;
}

function sanitizeConflictValueForMetadata(value: unknown, seen = new WeakSet<object>(), fieldName?: string): any {
  if (fieldName === 'imageBlobs') {
    if (isOmittedImageBlobsSummary(value)) {
      return value;
    }
    return summarizeOmittedImageBlobs(value);
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return value.length > MAX_CONFLICT_METADATA_STRING_LENGTH
      ? `${value.slice(0, MAX_CONFLICT_METADATA_STRING_LENGTH)}...`
      : value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return {
      omitted: true,
      type: 'Blob',
      size: value.size,
      mimeType: value.type || undefined
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_CONFLICT_METADATA_ARRAY_ITEMS)
      .map(item => sanitizeConflictValueForMetadata(item, seen));
    if (value.length > MAX_CONFLICT_METADATA_ARRAY_ITEMS) {
      items.push({
        omitted: true,
        type: 'array-items',
        itemCount: value.length - MAX_CONFLICT_METADATA_ARRAY_ITEMS
      });
    }
    return items;
  }

  const sanitized: Record<string, any> = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, MAX_CONFLICT_METADATA_OBJECT_KEYS)) {
    sanitized[key] = sanitizeConflictValueForMetadata(item, seen, key);
  }
  if (entries.length > MAX_CONFLICT_METADATA_OBJECT_KEYS) {
    sanitized.__omittedKeys = entries.length - MAX_CONFLICT_METADATA_OBJECT_KEYS;
  }

  return sanitized;
}

function summarizeOmittedImageBlobs(value: unknown): Record<string, unknown> {
  return {
    omitted: true,
    type: 'imageBlobs',
    itemCount: Array.isArray(value) ? value.length : undefined
  };
}

function isOmittedImageBlobsSummary(value: unknown): value is Record<string, unknown> {
  return !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).omitted === true &&
    (value as Record<string, unknown>).type === 'imageBlobs';
}

function isCloudSyncConflictReason(value: unknown): value is CloudSyncConflict['reason'] {
  return value === 'both_modified' ||
    value === 'create_collision' ||
    value === 'delete_vs_update';
}

function isCloudSyncResolution(value: unknown): value is CloudSyncConflict['resolution'] {
  return value === 'keep-local' ||
    value === 'take-remote' ||
    value === 'take-newer';
}
