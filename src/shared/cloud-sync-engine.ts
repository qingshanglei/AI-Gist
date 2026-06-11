/**
 * Deterministic record-level sync merge helpers.
 *
 * The engine is intentionally storage-agnostic: WebDAV, iCloud, and local
 * tests can all pass snapshots into this module and get the same decisions.
 */

import {
  createStableChecksum,
  stableSerialize
} from './data-checksum';

export type CloudSyncCollectionName =
  | 'categories'
  | 'prompts'
  | 'promptVariables'
  | 'promptHistories'
  | 'aiConfigs'
  | 'quickOptimizationConfigs'
  | 'aiHistory'
  | 'settings';

export interface CloudSyncDataSet {
  categories?: any[];
  prompts?: any[];
  promptVariables?: any[];
  promptHistories?: any[];
  aiConfigs?: any[];
  quickOptimizationConfigs?: any[];
  aiHistory?: any[];
  settings?: any[];
  syncTombstones?: CloudSyncTombstone[];
  [collection: string]: any[] | undefined;
}

export interface CloudSyncTombstone {
  id?: number;
  storeName?: string;
  collectionName: string;
  recordKey: string;
  recordUuid?: string;
  deletedAt: string | Date;
  recordSnapshot?: any;
}

export interface CloudSyncSnapshot {
  schemaVersion: 1;
  deviceId: string;
  revision: string;
  createdAt: string;
  data: CloudSyncDataSet;
  dataChecksum?: string;
}

export type CloudSyncConflictReason =
  | 'both_modified'
  | 'create_collision'
  | 'delete_vs_update';

export type CloudSyncResolution =
  | 'keep-local'
  | 'take-remote'
  | 'take-newer';

export interface CloudSyncConflict {
  collection: string;
  key: string;
  reason: CloudSyncConflictReason;
  resolution: CloudSyncResolution;
  local?: any;
  remote?: any;
  base?: any;
}

export interface CloudSyncMergeSummary {
  added: number;
  updated: number;
  deleted: number;
  kept: number;
  conflicts: number;
}

export interface CloudSyncMergeResult<TData extends CloudSyncDataSet = CloudSyncDataSet> {
  data: TData;
  conflicts: CloudSyncConflict[];
  summary: CloudSyncMergeSummary;
  hasConflicts: boolean;
}

export interface CloudSyncMergeOptions {
  prefer?: 'local' | 'remote' | 'newer';
}

export interface CloudSyncSnapshotValidationResult {
  valid: boolean;
  reason?: string;
}

const DEFAULT_COLLECTIONS: CloudSyncCollectionName[] = [
  'categories',
  'prompts',
  'promptVariables',
  'promptHistories',
  'aiConfigs',
  'quickOptimizationConfigs',
  'aiHistory',
  'settings'
];

const IDENTITY_FIELDS: Record<string, string[]> = {
  categories: ['uuid', 'id'],
  prompts: ['uuid', 'id'],
  promptVariables: ['uuid', 'id'],
  promptHistories: ['uuid', 'id'],
  aiConfigs: ['uuid', 'configId', 'id'],
  quickOptimizationConfigs: ['uuid', 'id'],
  aiHistory: ['uuid', 'historyId', 'id'],
  settings: ['key', 'id'],
  syncTombstones: ['recordKey', 'recordUuid', 'id']
};

export function createCloudSyncSnapshot(
  data: CloudSyncDataSet,
  deviceId: string,
  revision = createRevision()
): CloudSyncSnapshot {
  const snapshotData = cloneValue(data);
  return {
    schemaVersion: 1,
    deviceId,
    revision,
    createdAt: new Date().toISOString(),
    data: snapshotData,
    dataChecksum: createCloudSyncDataChecksum(snapshotData)
  };
}

export function createCloudSyncDataChecksum(data: CloudSyncDataSet): string {
  return createStableChecksum(data);
}

export function validateCloudSyncSnapshot(value: unknown): CloudSyncSnapshotValidationResult {
  if (!value || typeof value !== 'object') {
    return { valid: false, reason: 'snapshot must be an object' };
  }

  const snapshot = value as Partial<CloudSyncSnapshot>;
  if (snapshot.schemaVersion !== 1) {
    return { valid: false, reason: 'unsupported snapshot schema version' };
  }

  if (typeof snapshot.deviceId !== 'string' || !snapshot.deviceId) {
    return { valid: false, reason: 'snapshot deviceId is missing' };
  }

  if (typeof snapshot.revision !== 'string' || !snapshot.revision) {
    return { valid: false, reason: 'snapshot revision is missing' };
  }

  if (typeof snapshot.createdAt !== 'string' || !snapshot.createdAt) {
    return { valid: false, reason: 'snapshot createdAt is missing' };
  }

  if (!snapshot.data || typeof snapshot.data !== 'object' || Array.isArray(snapshot.data)) {
    return { valid: false, reason: 'snapshot data must be an object' };
  }

  if (snapshot.dataChecksum === undefined) {
    return { valid: true };
  }

  if (typeof snapshot.dataChecksum !== 'string' || !snapshot.dataChecksum) {
    return { valid: false, reason: 'snapshot dataChecksum is invalid' };
  }

  const actualChecksum = createCloudSyncDataChecksum(snapshot.data);
  if (snapshot.dataChecksum !== actualChecksum) {
    return { valid: false, reason: 'snapshot data checksum mismatch' };
  }

  return { valid: true };
}

export function mergeCloudSyncData<TData extends CloudSyncDataSet>(
  localData: TData,
  remoteData: CloudSyncDataSet,
  baseData: CloudSyncDataSet = {},
  options: CloudSyncMergeOptions = {}
): CloudSyncMergeResult<TData> {
  const resultData: CloudSyncDataSet = {};
  const conflicts: CloudSyncConflict[] = [];
  const summary: CloudSyncMergeSummary = {
    added: 0,
    updated: 0,
    deleted: 0,
    kept: 0,
    conflicts: 0
  };

  const collections = getAllCollectionNames(localData, remoteData, baseData);

  for (const collection of collections) {
    const merged = mergeCollection(
      collection,
      localData[collection] || [],
      remoteData[collection] || [],
      baseData[collection] || [],
      options
    );

    resultData[collection] = merged.records;
    conflicts.push(...merged.conflicts);
    summary.added += merged.summary.added;
    summary.updated += merged.summary.updated;
    summary.deleted += merged.summary.deleted;
    summary.kept += merged.summary.kept;
    summary.conflicts += merged.summary.conflicts;
  }

  const dataWithDeletesApplied = applyCloudSyncTombstones(resultData) as TData;

  return {
    data: dataWithDeletesApplied,
    conflicts,
    summary,
    hasConflicts: conflicts.length > 0
  };
}

export function getCloudSyncRecordKey(collection: string, record: any): string {
  if (collection === 'syncTombstones') {
    const tombstoneKey = getCloudSyncTombstoneKey(record);
    if (tombstoneKey) {
      return `tombstone:${tombstoneKey}`;
    }
  }

  const fields = IDENTITY_FIELDS[collection] || ['uuid', 'key', 'id'];

  for (const field of fields) {
    const value = record?.[field];
    if (value !== undefined && value !== null && value !== '') {
      return `${field}:${String(value)}`;
    }
  }

  return `hash:${stableSerialize(normalizeForCompare(collection, record))}`;
}

export function applyCloudSyncTombstones<TData extends CloudSyncDataSet>(data: TData): TData {
  const cloned = cloneValue(data) as CloudSyncDataSet;
  const tombstones = normalizeCloudSyncTombstones(cloned.syncTombstones || []);

  for (const collection of Object.keys(cloned)) {
    if (collection === 'syncTombstones') {
      continue;
    }

    const records = cloned[collection];
    if (!Array.isArray(records)) {
      continue;
    }

    cloned[collection] = records.filter(record =>
      !tombstones.some(tombstone => tombstoneDeletesRecord(tombstone, collection, record))
    );
  }

  cloned.syncTombstones = tombstones;
  return cloned as TData;
}

function mergeCollection(
  collection: string,
  localRecords: any[],
  remoteRecords: any[],
  baseRecords: any[],
  options: CloudSyncMergeOptions
): {
  records: any[];
  conflicts: CloudSyncConflict[];
  summary: CloudSyncMergeSummary;
} {
  const local = indexBySyncKey(collection, localRecords);
  const remote = indexBySyncKey(collection, remoteRecords);
  const base = indexBySyncKey(collection, baseRecords);
  const keys = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
  const records: any[] = [];
  const conflicts: CloudSyncConflict[] = [];
  const summary: CloudSyncMergeSummary = {
    added: 0,
    updated: 0,
    deleted: 0,
    kept: 0,
    conflicts: 0
  };

  for (const key of keys) {
    const localRecord = local.get(key);
    const remoteRecord = remote.get(key);
    const baseRecord = base.get(key);

    if (!baseRecord) {
      mergeWithoutBase(collection, key, localRecord, remoteRecord, records, conflicts, summary, options);
      continue;
    }

    mergeWithBase(collection, key, localRecord, remoteRecord, baseRecord, records, conflicts, summary, options);
  }

  return { records, conflicts, summary };
}

function mergeWithoutBase(
  collection: string,
  key: string,
  localRecord: any | undefined,
  remoteRecord: any | undefined,
  records: any[],
  conflicts: CloudSyncConflict[],
  summary: CloudSyncMergeSummary,
  options: CloudSyncMergeOptions
): void {
  const localExists = isPresent(localRecord);
  const remoteExists = isPresent(remoteRecord);

  if (localExists && remoteExists) {
    if (recordsEqual(collection, localRecord, remoteRecord)) {
      records.push(cloneValue(localRecord));
      summary.kept++;
      return;
    }

    const chosen = chooseRecord(localRecord, remoteRecord, options);
    records.push(cloneValue(chosen.record));
    addConflict(conflicts, summary, {
      collection,
      key,
      reason: 'create_collision',
      resolution: chosen.resolution,
      local: localRecord,
      remote: remoteRecord
    });
    if (chosen.record === remoteRecord) {
      summary.updated++;
    } else {
      summary.kept++;
    }
    return;
  }

  if (remoteExists) {
    records.push(cloneValue(remoteRecord));
    summary.added++;
    return;
  }

  if (localExists) {
    records.push(cloneValue(localRecord));
    summary.kept++;
  }
}

function mergeWithBase(
  collection: string,
  key: string,
  localRecord: any | undefined,
  remoteRecord: any | undefined,
  baseRecord: any,
  records: any[],
  conflicts: CloudSyncConflict[],
  summary: CloudSyncMergeSummary,
  options: CloudSyncMergeOptions
): void {
  const localExists = isPresent(localRecord);
  const remoteExists = isPresent(remoteRecord);

  if (!localExists && !remoteExists) {
    summary.deleted++;
    return;
  }

  if (!localExists) {
    const remoteChanged = !recordsEqual(collection, remoteRecord, baseRecord);
    if (!remoteChanged) {
      summary.deleted++;
      return;
    }

    records.push(cloneValue(remoteRecord));
    addConflict(conflicts, summary, {
      collection,
      key,
      reason: 'delete_vs_update',
      resolution: 'take-remote',
      local: localRecord,
      remote: remoteRecord,
      base: baseRecord
    });
    summary.updated++;
    return;
  }

  if (!remoteExists) {
    const localChanged = !recordsEqual(collection, localRecord, baseRecord);
    if (!localChanged) {
      summary.deleted++;
      return;
    }

    records.push(cloneValue(localRecord));
    addConflict(conflicts, summary, {
      collection,
      key,
      reason: 'delete_vs_update',
      resolution: 'keep-local',
      local: localRecord,
      remote: remoteRecord,
      base: baseRecord
    });
    summary.kept++;
    return;
  }

  if (recordsEqual(collection, localRecord, remoteRecord)) {
    records.push(cloneValue(localRecord));
    summary.kept++;
    return;
  }

  const localChanged = !recordsEqual(collection, localRecord, baseRecord);
  const remoteChanged = !recordsEqual(collection, remoteRecord, baseRecord);

  if (!localChanged && remoteChanged) {
    records.push(cloneValue(remoteRecord));
    summary.updated++;
    return;
  }

  if (localChanged && !remoteChanged) {
    records.push(cloneValue(localRecord));
    summary.kept++;
    return;
  }

  const chosen = chooseRecord(localRecord, remoteRecord, options);
  records.push(cloneValue(chosen.record));
  addConflict(conflicts, summary, {
    collection,
    key,
    reason: 'both_modified',
    resolution: chosen.resolution,
    local: localRecord,
    remote: remoteRecord,
    base: baseRecord
  });

  if (chosen.record === remoteRecord) {
    summary.updated++;
  } else {
    summary.kept++;
  }
}

function indexBySyncKey(collection: string, records: any[]): Map<string, any> {
  const indexed = new Map<string, any>();
  for (const record of records) {
    const key = getCloudSyncRecordKey(collection, record);
    if (indexed.has(key)) {
      throw new Error(`同步数据包含重复记录: ${collection} ${key}`);
    }
    indexed.set(key, record);
  }
  return indexed;
}

function addConflict(
  conflicts: CloudSyncConflict[],
  summary: CloudSyncMergeSummary,
  conflict: CloudSyncConflict
): void {
  conflicts.push({
    ...conflict,
    local: conflict.local === undefined ? undefined : cloneValue(conflict.local),
    remote: conflict.remote === undefined ? undefined : cloneValue(conflict.remote),
    base: conflict.base === undefined ? undefined : cloneValue(conflict.base)
  });
  summary.conflicts++;
}

function chooseRecord(
  localRecord: any,
  remoteRecord: any,
  options: CloudSyncMergeOptions
): { record: any; resolution: CloudSyncResolution } {
  if (options.prefer === 'local') {
    return { record: localRecord, resolution: 'keep-local' };
  }

  if (options.prefer === 'remote') {
    return { record: remoteRecord, resolution: 'take-remote' };
  }

  const localTime = getRecordTime(localRecord);
  const remoteTime = getRecordTime(remoteRecord);
  if (remoteTime > localTime) {
    return { record: remoteRecord, resolution: 'take-newer' };
  }

  return { record: localRecord, resolution: options.prefer === 'newer' ? 'take-newer' : 'keep-local' };
}

function isPresent(record: any | undefined): boolean {
  return !!record &&
    record._deleted !== true &&
    (record.deletedAt === undefined || isCloudSyncTombstone(record)) &&
    record.isDeleted !== true;
}

function recordsEqual(collection: string, left: any, right: any): boolean {
  if (!isPresent(left) || !isPresent(right)) {
    return isPresent(left) === isPresent(right);
  }

  return stableSerialize(normalizeForCompare(collection, left)) ===
    stableSerialize(normalizeForCompare(collection, right));
}

function normalizeForCompare(collection: string, value: any): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (isBlob(value)) {
    return {
      blobType: value.type,
      blobSize: value.size
    };
  }

  if (Array.isArray(value)) {
    const normalizedArray = value.map(item => normalizeForCompare(collection, item));
    if (collection === 'prompts' && value.every(item => item && typeof item === 'object')) {
      return normalizedArray.sort((a, b) =>
        stableSerialize(a).localeCompare(stableSerialize(b))
      );
    }
    return normalizedArray;
  }

  if (typeof value !== 'object') {
    return value;
  }

  const normalized: Record<string, any> = {};
  const valueRecord = value as Record<string, any>;

  if (collection === 'prompts' && valueRecord.category?.uuid) {
    normalized.categoryUuid = valueRecord.category.uuid;
  }

  for (const [key, fieldValue] of Object.entries(valueRecord)) {
    if (key === 'id' || key === 'category') {
      continue;
    }

    if (key === 'categoryId' && valueRecord.category?.uuid) {
      continue;
    }

    if (key === 'promptId' && (collection === 'promptHistories' || collection === 'promptVariables')) {
      continue;
    }

    if (key === 'tags') {
      normalized[key] = normalizeTags(fieldValue);
      continue;
    }

    normalized[key] = normalizeForCompare(collection, fieldValue);
  }

  return normalized;
}

function normalizeTags(tags: any): string[] {
  if (Array.isArray(tags)) {
    return tags.map(tag => String(tag).trim()).filter(Boolean).sort();
  }

  if (typeof tags === 'string') {
    return tags.split(',').map(tag => tag.trim()).filter(Boolean).sort();
  }

  return [];
}

function getRecordTime(record: any): number {
  const candidates = [
    record?.updatedAt,
    record?.createdAt,
    record?.deletedAt,
    record?.modifiedAt
  ];

  for (const candidate of candidates) {
    const time = new Date(candidate).getTime();
    if (!Number.isNaN(time)) {
      return time;
    }
  }

  return 0;
}

function normalizeCloudSyncTombstones(tombstones: any[]): CloudSyncTombstone[] {
  const indexed = new Map<string, CloudSyncTombstone>();

  for (const tombstone of tombstones) {
    if (!isCloudSyncTombstone(tombstone)) {
      continue;
    }

    const key = getCloudSyncTombstoneKey(tombstone);
    if (!key) {
      continue;
    }

    const normalized = cloneValue(tombstone);
    const current = indexed.get(key);
    if (!current || getTombstoneTime(normalized) >= getTombstoneTime(current)) {
      indexed.set(key, normalized);
    }
  }

  return Array.from(indexed.values())
    .sort((left, right) => getCloudSyncTombstoneKey(left).localeCompare(getCloudSyncTombstoneKey(right)));
}

function isCloudSyncTombstone(value: any): value is CloudSyncTombstone {
  return !!value &&
    typeof value === 'object' &&
    typeof value.collectionName === 'string' &&
    typeof value.recordKey === 'string' &&
    value.recordKey.length > 0;
}

function getCloudSyncTombstoneKey(tombstone: any): string {
  if (!tombstone || typeof tombstone !== 'object') {
    return '';
  }

  const collectionName = typeof tombstone.collectionName === 'string'
    ? tombstone.collectionName
    : '';
  const recordKey = typeof tombstone.recordKey === 'string'
    ? tombstone.recordKey
    : '';

  if (collectionName && recordKey) {
    return `${collectionName}:${recordKey}`;
  }

  if (collectionName && typeof tombstone.recordUuid === 'string' && tombstone.recordUuid) {
    return `${collectionName}:uuid:${tombstone.recordUuid}`;
  }

  return '';
}

function tombstoneDeletesRecord(tombstone: CloudSyncTombstone, collection: string, record: any): boolean {
  if (tombstone.collectionName !== collection || !isPresent(record)) {
    return false;
  }

  const recordKey = getCloudSyncRecordKey(collection, record);
  const matchesKey = tombstone.recordKey === recordKey;
  const matchesUuid = !!tombstone.recordUuid && tombstone.recordUuid === record?.uuid;

  if (!matchesKey && !matchesUuid) {
    return false;
  }

  const tombstoneTime = getTombstoneTime(tombstone);
  const recordTime = getRecordTime(record);
  return tombstoneTime === 0 || recordTime === 0 || tombstoneTime >= recordTime;
}

function getTombstoneTime(tombstone: CloudSyncTombstone): number {
  const time = new Date(tombstone.deletedAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function cloneValue<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }

  if (isBlob(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => cloneValue(item)) as T;
  }

  if (typeof value === 'object') {
    const cloned: Record<string, any> = {};
    for (const [key, fieldValue] of Object.entries(value as Record<string, any>)) {
      cloned[key] = cloneValue(fieldValue);
    }
    return cloned as T;
  }

  return value;
}

function getAllCollectionNames(...dataSets: CloudSyncDataSet[]): string[] {
  const names = new Set<string>(DEFAULT_COLLECTIONS);
  for (const dataSet of dataSets) {
    for (const key of Object.keys(dataSet)) {
      if (Array.isArray(dataSet[key])) {
        names.add(key);
      }
    }
  }
  return Array.from(names);
}

function isBlob(value: any): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function createRevision(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
