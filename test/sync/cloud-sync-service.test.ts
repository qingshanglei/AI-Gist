import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  CloudSyncService,
  DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES,
  type CloudSyncServiceDeps
} from '~/lib/services/cloud-sync.service'
import { emitDataChange } from '~/lib/services/data-change-events'
import {
  createCloudSyncDataChecksum,
  createCloudSyncSnapshot
} from '@shared/cloud-sync-engine'
import { createEmptyCloudSyncManifest } from '@shared/cloud-sync-manifest'

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) || null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const baseData = {
  categories: [{ id: 1, uuid: 'cat-1', name: 'Base', updatedAt: '2026-01-01T00:00:00.000Z' }],
  prompts: [{ id: 1, uuid: 'prompt-1', title: 'Base', updatedAt: '2026-01-01T00:00:00.000Z' }],
  promptVariables: [],
  promptHistories: [],
  aiConfigs: [],
  quickOptimizationConfigs: [],
  aiHistory: [],
  settings: [],
  syncTombstones: []
}

const enabledWebDAVConfig = {
  id: 'cfg-1',
  name: 'WebDAV',
  type: 'webdav' as const,
  enabled: true,
  url: 'http://127.0.0.1/webdav',
  username: 'user',
  password: 'pass',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

function createService(
  data: any,
  manifest = createEmptyCloudSyncManifest('2026-01-01T00:00:00.000Z'),
  extraDeps: CloudSyncServiceDeps = {}
) {
  const storage = new MemoryStorage()
  let cloudManifest = manifest
  const cloudClient = {
    getCloudSyncManifest: vi.fn().mockImplementation(async () => cloudManifest),
    saveCloudSyncManifest: vi.fn().mockImplementation(async (_storageId: string, nextManifest: any) => {
      cloudManifest = nextManifest
      return { success: true }
    })
  }
  const database = {
    exportAllDataForSync: vi.fn().mockResolvedValue({
      success: true,
      message: 'ok',
      data
    }),
    replaceAllData: vi.fn().mockResolvedValue({
      success: true,
      message: 'ok'
    })
  }
  const service = new CloudSyncService({
    cloudClient,
    database,
    storage,
    createDeviceId: () => 'device-a',
    ...extraDeps
  })

  return {
    service,
    cloudClient,
    database,
    storage
  }
}

describe('CloudSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uploads a local snapshot when the cloud manifest is empty', async () => {
    const { service, cloudClient, storage } = createService(baseData)

    const result = await service.syncNow('cfg-1', {
      deviceName: 'iPhone',
      platform: 'ios'
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('uploaded')
    expect(cloudClient.saveCloudSyncManifest).toHaveBeenCalledTimes(1)
    const savedManifest = cloudClient.saveCloudSyncManifest.mock.calls[0][1]
    expect(savedManifest.latestSnapshot.data.prompts[0].uuid).toBe('prompt-1')
    expect(savedManifest.devices['device-a']).toMatchObject({
      deviceName: 'iPhone',
      platform: 'ios'
    })
    expect(storage.getItem('ai_gist_cloud_sync_state:cfg-1')).toContain(savedManifest.latestSnapshot.revision)
  })

  it('continues sync when noncritical local sync metadata cannot be stored', async () => {
    const storage = new MemoryStorage()
    const storageSetSpy = vi.spyOn(storage, 'setItem')
      .mockImplementation((key: string, value: string) => {
        if (
          key === 'ai_gist_cloud_sync_last_auto_attempt_at' ||
          key === 'ai_gist_cloud_sync_device_id'
        ) {
          throw new Error('QuotaExceededError')
        }
        MemoryStorage.prototype.setItem.call(storage, key, value)
      })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { service, cloudClient } = createService(baseData, createEmptyCloudSyncManifest(), { storage })

    try {
      const result = await service.syncNow('cfg-1')

      expect(result.success).toBe(true)
      expect(cloudClient.saveCloudSyncManifest).toHaveBeenCalledTimes(1)
      expect(storageSetSpy).toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        '保存云同步自动尝试时间失败:',
        expect.any(Error)
      )
      expect(warnSpy).toHaveBeenCalledWith(
        '保存云同步设备 ID 失败:',
        expect.any(Error)
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('fails sync when a saved manifest cannot be read back with the same revision', async () => {
    const emptyManifest = createEmptyCloudSyncManifest('2026-01-01T00:00:00.000Z')
    const { service, cloudClient, storage } = createService(baseData, emptyManifest)
    cloudClient.getCloudSyncManifest
      .mockReset()
      .mockResolvedValueOnce(emptyManifest)
      .mockResolvedValueOnce(emptyManifest)
      .mockResolvedValueOnce(emptyManifest)

    const result = await service.syncNow('cfg-1')

    expect(result.success).toBe(false)
    expect(result.error).toContain('云同步 manifest 保存后校验失败')
    expect(cloudClient.saveCloudSyncManifest).toHaveBeenCalledTimes(1)
    expect(storage.getItem('ai_gist_cloud_sync_state:cfg-1')).toBeNull()
  })

  it('fails sync when a saved manifest reads back the same revision with different data', async () => {
    const emptyManifest = createEmptyCloudSyncManifest('2026-01-01T00:00:00.000Z')
    const { service, cloudClient, storage } = createService(baseData, emptyManifest)
    let corruptedSavedManifest: any = emptyManifest

    cloudClient.getCloudSyncManifest
      .mockReset()
      .mockResolvedValueOnce(emptyManifest)
      .mockResolvedValueOnce(emptyManifest)
      .mockImplementation(async () => corruptedSavedManifest)
    cloudClient.saveCloudSyncManifest.mockImplementation(async (_storageId: string, manifest: any) => {
      const corruptedData = {
        ...manifest.latestSnapshot.data,
        prompts: [
          { ...manifest.latestSnapshot.data.prompts[0], title: 'Corrupted cloud copy' }
        ]
      }
      corruptedSavedManifest = {
        ...manifest,
        latestSnapshot: {
          ...manifest.latestSnapshot,
          data: corruptedData,
          dataChecksum: createCloudSyncDataChecksum(corruptedData)
        }
      }
      return { success: true }
    })

    const result = await service.syncNow('cfg-1')

    expect(result.success).toBe(false)
    expect(result.error).toContain('云同步 manifest 保存后数据校验失败')
    expect(storage.getItem('ai_gist_cloud_sync_state:cfg-1')).toBeNull()
  })

  it('downloads and applies remote changes when local data matches the previous base', async () => {
    const baseSnapshot = createCloudSyncSnapshot(baseData, 'device-a', 'rev-base')
    const remoteData = {
      ...baseData,
      prompts: [{ id: 9, uuid: 'prompt-1', title: 'Remote edit', updatedAt: '2026-01-02T00:00:00.000Z' }]
    }
    const remoteSnapshot = createCloudSyncSnapshot(remoteData, 'device-b', 'rev-remote')
    const manifest = {
      ...createEmptyCloudSyncManifest('2026-01-02T00:00:00.000Z'),
      latestSnapshot: remoteSnapshot,
      baseSnapshot
    }
    const { service, cloudClient, database, storage } = createService(baseData, manifest)
    storage.setItem('ai_gist_cloud_sync_state:cfg-1', JSON.stringify({
      storageId: 'cfg-1',
      deviceId: 'device-a',
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      lastKnownRevision: 'rev-base',
      baseSnapshot
    }))

    const result = await service.syncNow('cfg-1')

    expect(result.success).toBe(true)
    expect(result.action).toBe('downloaded')
    expect(database.replaceAllData).toHaveBeenCalledWith(expect.objectContaining({
      prompts: [expect.objectContaining({ title: 'Remote edit' })]
    }))
    expect(cloudClient.saveCloudSyncManifest).not.toHaveBeenCalled()
    expect(storage.getItem('ai_gist_cloud_sync_state:cfg-1')).toContain('rev-remote')
  })

  it('treats a device without local sync state as a new device and pulls remote data', async () => {
    const emptyLocalData = {
      categories: [],
      prompts: [],
      promptVariables: [],
      promptHistories: [],
      aiConfigs: [],
      quickOptimizationConfigs: [],
      aiHistory: [],
      settings: [],
      syncTombstones: []
    }
    const remoteSnapshot = createCloudSyncSnapshot(baseData, 'device-b', 'rev-remote')
    const manifest = {
      ...createEmptyCloudSyncManifest('2026-01-02T00:00:00.000Z'),
      latestSnapshot: remoteSnapshot,
      baseSnapshot: remoteSnapshot
    }
    const { service, cloudClient, database } = createService(emptyLocalData, manifest)

    const result = await service.syncNow('cfg-1')

    expect(result.success).toBe(true)
    expect(result.action).toBe('downloaded')
    expect(database.replaceAllData).toHaveBeenCalledWith(expect.objectContaining({
      prompts: [expect.objectContaining({ uuid: 'prompt-1' })]
    }))
    expect(cloudClient.saveCloudSyncManifest).not.toHaveBeenCalled()
  })

  it('uploads a merged snapshot that preserves tombstones over stale remote records', async () => {
    const tombstone = {
      collectionName: 'prompts',
      recordKey: 'uuid:prompt-1',
      recordUuid: 'prompt-1',
      deletedAt: '2026-01-03T00:00:00.000Z'
    }
    const localData = {
      ...baseData,
      prompts: [],
      syncTombstones: [tombstone]
    }
    const remoteData = {
      ...baseData,
      prompts: [{ id: 9, uuid: 'prompt-1', title: 'Stale remote', updatedAt: '2026-01-02T00:00:00.000Z' }]
    }
    const remoteSnapshot = createCloudSyncSnapshot(remoteData, 'device-b', 'rev-remote')
    const manifest = {
      ...createEmptyCloudSyncManifest('2026-01-02T00:00:00.000Z'),
      latestSnapshot: remoteSnapshot,
      baseSnapshot: remoteSnapshot
    }
    const { service, cloudClient, database } = createService(localData, manifest)

    const result = await service.syncNow('cfg-1')

    expect(result.success).toBe(true)
    expect(result.action).toBe('uploaded')
    expect(database.replaceAllData).not.toHaveBeenCalled()
    const savedManifest = cloudClient.saveCloudSyncManifest.mock.calls[0][1]
    expect(savedManifest.latestSnapshot.data.prompts).toEqual([])
    expect(savedManifest.latestSnapshot.data.syncTombstones).toHaveLength(1)
  })

  it('rechecks the remote revision before upload and retries against newer cloud data', async () => {
    const baseSnapshot = createCloudSyncSnapshot(baseData, 'device-a', 'rev-base')
    const localData = {
      ...baseData,
      prompts: [{ id: 1, uuid: 'prompt-1', title: 'Local edit', updatedAt: '2026-01-03T00:00:00.000Z' }]
    }
    const remoteDataWrittenByOtherDevice = {
      ...baseData,
      categories: [
        ...baseData.categories,
        { id: 2, uuid: 'cat-2', name: 'Remote category', updatedAt: '2026-01-02T00:00:00.000Z' }
      ]
    }
    const initialManifest = {
      ...createEmptyCloudSyncManifest('2026-01-01T00:00:00.000Z'),
      latestSnapshot: baseSnapshot,
      baseSnapshot
    }
    const changedManifest = {
      ...createEmptyCloudSyncManifest('2026-01-02T00:00:00.000Z'),
      latestSnapshot: createCloudSyncSnapshot(remoteDataWrittenByOtherDevice, 'device-b', 'rev-remote-newer'),
      baseSnapshot
    }
    const { service, cloudClient, database, storage } = createService(localData, initialManifest)
    storage.setItem('ai_gist_cloud_sync_state:cfg-1', JSON.stringify({
      storageId: 'cfg-1',
      deviceId: 'device-a',
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      lastKnownRevision: 'rev-base',
      baseSnapshot
    }))
    cloudClient.getCloudSyncManifest
      .mockReset()
      .mockResolvedValueOnce(initialManifest)
      .mockResolvedValueOnce(changedManifest)
      .mockResolvedValueOnce(changedManifest)
      .mockResolvedValueOnce(changedManifest)
      .mockImplementation(async () => cloudClient.saveCloudSyncManifest.mock.calls[0]?.[1] || changedManifest)

    const result = await service.syncNow('cfg-1')

    expect(result.success).toBe(true)
    expect(cloudClient.saveCloudSyncManifest).toHaveBeenCalledTimes(1)
    expect(database.replaceAllData).toHaveBeenCalledWith(expect.objectContaining({
      categories: expect.arrayContaining([expect.objectContaining({ uuid: 'cat-2' })]),
      prompts: expect.arrayContaining([expect.objectContaining({ title: 'Local edit' })])
    }))
    const savedManifest = cloudClient.saveCloudSyncManifest.mock.calls[0][1]
    expect(savedManifest.latestSnapshot.data.categories).toEqual(
      expect.arrayContaining([expect.objectContaining({ uuid: 'cat-2' })])
    )
    expect(savedManifest.latestSnapshot.data.prompts).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Local edit' })])
    )
  })

  it('ignores corrupted local base snapshots before merging', async () => {
    const localData = {
      ...baseData,
      prompts: [{ id: 1, uuid: 'prompt-1', title: 'Local edit', updatedAt: '2026-01-03T00:00:00.000Z' }]
    }
    const remoteData = {
      ...baseData,
      prompts: [{ id: 9, uuid: 'prompt-1', title: 'Remote edit', updatedAt: '2026-01-02T00:00:00.000Z' }]
    }
    const remoteSnapshot = createCloudSyncSnapshot(remoteData, 'device-b', 'rev-remote')
    const manifest = {
      ...createEmptyCloudSyncManifest('2026-01-02T00:00:00.000Z'),
      latestSnapshot: remoteSnapshot,
      baseSnapshot: remoteSnapshot
    }
    const { service, cloudClient, database, storage } = createService(localData, manifest)
    const corruptBaseSnapshot = createCloudSyncSnapshot(baseData, 'device-a', 'rev-base')
    corruptBaseSnapshot.data = localData
    storage.setItem('ai_gist_cloud_sync_state:cfg-1', JSON.stringify({
      storageId: 'cfg-1',
      deviceId: 'device-a',
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      lastKnownRevision: 'rev-base',
      baseSnapshot: corruptBaseSnapshot
    }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const result = await service.syncNow('cfg-1')

      expect(result.success).toBe(true)
      expect(result.action).toBe('uploaded')
      expect(database.replaceAllData).not.toHaveBeenCalled()
      const savedManifest = cloudClient.saveCloudSyncManifest.mock.calls[0][1]
      expect(savedManifest.latestSnapshot.data.prompts).toEqual([
        expect.objectContaining({ title: 'Local edit' })
      ])
      expect(warnSpy).toHaveBeenCalledWith(
        '本地同步状态已损坏，忽略本地 baseSnapshot:',
        'snapshot data checksum mismatch'
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('ignores local sync state when its revision does not match the base snapshot', async () => {
    const baseSnapshot = createCloudSyncSnapshot(baseData, 'device-a', 'rev-base')
    const localData = {
      ...baseData,
      prompts: []
    }
    const remoteSnapshot = createCloudSyncSnapshot(baseData, 'device-b', 'rev-remote')
    const manifest = {
      ...createEmptyCloudSyncManifest('2026-01-02T00:00:00.000Z'),
      latestSnapshot: remoteSnapshot,
      baseSnapshot: remoteSnapshot
    }
    const { service, cloudClient, database, storage } = createService(localData, manifest)
    storage.setItem('ai_gist_cloud_sync_state:cfg-1', JSON.stringify({
      storageId: 'cfg-1',
      deviceId: 'device-a',
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      lastKnownRevision: 'different-rev',
      baseSnapshot
    }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const result = await service.syncNow('cfg-1')

      expect(result.success).toBe(true)
      expect(result.action).toBe('downloaded')
      expect(cloudClient.saveCloudSyncManifest).not.toHaveBeenCalled()
      expect(database.replaceAllData).toHaveBeenCalledWith(expect.objectContaining({
        prompts: [expect.objectContaining({ uuid: 'prompt-1' })]
      }))
      expect(warnSpy).toHaveBeenCalledWith(
        '本地同步状态 revision 不一致，忽略本地 baseSnapshot:',
        'different-rev',
        'rev-base'
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('persists an audit log when conflicts are automatically resolved', async () => {
    const baseSnapshot = createCloudSyncSnapshot(baseData, 'device-a', 'rev-base')
    const localData = {
      ...baseData,
      prompts: [{ id: 1, uuid: 'prompt-1', title: 'Local edit', updatedAt: '2026-01-03T00:00:00.000Z' }]
    }
    const remoteData = {
      ...baseData,
      prompts: [{ id: 9, uuid: 'prompt-1', title: 'Remote edit', updatedAt: '2026-01-02T00:00:00.000Z' }]
    }
    const remoteSnapshot = createCloudSyncSnapshot(remoteData, 'device-b', 'rev-remote')
    const manifest = {
      ...createEmptyCloudSyncManifest('2026-01-02T00:00:00.000Z'),
      latestSnapshot: remoteSnapshot,
      baseSnapshot
    }
    const { service, storage } = createService(localData, manifest)
    storage.setItem('ai_gist_cloud_sync_state:cfg-1', JSON.stringify({
      storageId: 'cfg-1',
      deviceId: 'device-a',
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      lastKnownRevision: 'rev-base',
      baseSnapshot
    }))

    const result = await service.syncNow('cfg-1')

    expect(result.success).toBe(true)
    expect(result.conflicts).toHaveLength(1)

    const conflictLog = service.getConflictLog('cfg-1')
    expect(conflictLog).toHaveLength(1)
    expect(conflictLog[0]).toMatchObject({
      storageId: 'cfg-1',
      localRevision: 'rev-base',
      remoteRevision: 'rev-remote'
    })
    expect(conflictLog[0].resolvedRevision).toBe(result.remoteRevision)
    expect(conflictLog[0].conflicts[0]).toMatchObject({
      collection: 'prompts',
      key: 'uuid:prompt-1',
      reason: 'both_modified',
      resolution: 'take-newer'
    })
    expect(service.getStatus().conflictLogCount).toBe(1)

    service.clearConflictLog('cfg-1')
    expect(service.getConflictLog('cfg-1')).toEqual([])
    expect(service.getStatus().conflictLogCount).toBe(0)
  })

  it('does not fail sync when conflict audit log storage is unavailable', async () => {
    const baseSnapshot = createCloudSyncSnapshot(baseData, 'device-a', 'rev-base')
    const localData = {
      ...baseData,
      prompts: [{ id: 1, uuid: 'prompt-1', title: 'Local edit', updatedAt: '2026-01-03T00:00:00.000Z' }]
    }
    const remoteData = {
      ...baseData,
      prompts: [{ id: 9, uuid: 'prompt-1', title: 'Remote edit', updatedAt: '2026-01-02T00:00:00.000Z' }]
    }
    const remoteSnapshot = createCloudSyncSnapshot(remoteData, 'device-b', 'rev-remote')
    const manifest = {
      ...createEmptyCloudSyncManifest('2026-01-02T00:00:00.000Z'),
      latestSnapshot: remoteSnapshot,
      baseSnapshot
    }
    const storage = new MemoryStorage()
    const storageSetSpy = vi.spyOn(storage, 'setItem')
      .mockImplementation((key: string, value: string) => {
        if (key === 'ai_gist_cloud_sync_conflict_log') {
          throw new Error('QuotaExceededError')
        }
        MemoryStorage.prototype.setItem.call(storage, key, value)
      })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { service } = createService(localData, manifest, { storage })
    storage.setItem('ai_gist_cloud_sync_state:cfg-1', JSON.stringify({
      storageId: 'cfg-1',
      deviceId: 'device-a',
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      lastKnownRevision: 'rev-base',
      baseSnapshot
    }))

    try {
      const result = await service.syncNow('cfg-1')

      expect(result.success).toBe(true)
      expect(result.conflicts).toHaveLength(1)
      expect(warnSpy).toHaveBeenCalledWith(
        '同步冲突审计记录保存失败:',
        expect.any(Error)
      )
      expect(storageSetSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('automatically syncs enabled storage after local data changes', async () => {
    vi.useFakeTimers()
    let dataChangeListener: ((change: any) => void) | undefined
    const { service, cloudClient } = createService(baseData, createEmptyCloudSyncManifest(), {
      configClient: {
        getStorageConfigs: vi.fn().mockResolvedValue([enabledWebDAVConfig])
      },
      subscribeToDataChanges: listener => {
        dataChangeListener = listener
        return vi.fn()
      }
    })

    service.startAutoSync({
      syncOnStart: false,
      debounceMs: 25,
      pollIntervalMs: 0,
      retryMs: 0
    })
    dataChangeListener?.({
      storeName: 'prompts',
      action: 'update',
      id: 1,
      timestamp: Date.now(),
      sourceId: 'test'
    })

    expect(service.getStatus().status).toBe('scheduled')

    await vi.advanceTimersByTimeAsync(25)

    expect(cloudClient.saveCloudSyncManifest).toHaveBeenCalledTimes(1)
    expect(service.getStatus()).toMatchObject({
      status: 'success',
      pending: false,
      storageId: 'cfg-1'
    })

    service.stopAutoSync()
  })

  it('automatically syncs quick optimization config changes through the default event bus', async () => {
    vi.useFakeTimers()
    const { service, cloudClient } = createService(baseData, createEmptyCloudSyncManifest(), {
      configClient: {
        getStorageConfigs: vi.fn().mockResolvedValue([enabledWebDAVConfig])
      }
    })

    service.startAutoSync({
      syncOnStart: false,
      debounceMs: 25,
      pollIntervalMs: 0,
      retryMs: 0
    })
    emitDataChange({
      storeName: 'quick_optimization_configs',
      action: 'update',
      id: 1
    })

    expect(service.getStatus().status).toBe('scheduled')

    await vi.advanceTimersByTimeAsync(25)

    expect(cloudClient.saveCloudSyncManifest).toHaveBeenCalledTimes(1)

    service.stopAutoSync()
  })

  it('uses a 15 minute remote polling interval by default', async () => {
    vi.useFakeTimers()
    const { service, cloudClient } = createService(baseData, createEmptyCloudSyncManifest(), {
      configClient: {
        getStorageConfigs: vi.fn().mockResolvedValue([enabledWebDAVConfig])
      }
    })

    service.startAutoSync({
      syncOnStart: false,
      retryMs: 0
    })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(cloudClient.saveCloudSyncManifest).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES * 60 * 1000 - 30_000)
    expect(cloudClient.saveCloudSyncManifest).toHaveBeenCalledTimes(1)

    service.stopAutoSync()
  })

  it('throttles automatic local-change syncs until the configured interval has elapsed', async () => {
    vi.useFakeTimers()
    let dataChangeListener: ((change: any) => void) | undefined
    const { service, cloudClient, database } = createService(baseData, createEmptyCloudSyncManifest(), {
      configClient: {
        getStorageConfigs: vi.fn().mockResolvedValue([enabledWebDAVConfig])
      },
      subscribeToDataChanges: listener => {
        dataChangeListener = listener
        return vi.fn()
      }
    })

    service.startAutoSync({
      syncOnStart: false,
      debounceMs: 25,
      retryMs: 0
    })
    await service.syncNow('cfg-1')
    cloudClient.saveCloudSyncManifest.mockClear()
    database.exportAllDataForSync.mockResolvedValue({
      success: true,
      message: 'ok',
      data: {
        ...baseData,
        prompts: [{ id: 1, uuid: 'prompt-1', title: 'Local throttled edit', updatedAt: '2026-01-03T00:00:00.000Z' }]
      }
    })

    dataChangeListener?.({
      storeName: 'prompts',
      action: 'update',
      id: 1,
      timestamp: Date.now(),
      sourceId: 'test'
    })

    await vi.advanceTimersByTimeAsync(25)
    expect(cloudClient.saveCloudSyncManifest).not.toHaveBeenCalled()
    expect(service.getStatus()).toMatchObject({
      status: 'scheduled',
      pending: true
    })

    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES * 60 * 1000)
    expect(cloudClient.saveCloudSyncManifest).toHaveBeenCalledTimes(1)

    service.stopAutoSync()
  })

  it('backs off automatic retries after a transient cloud read failure', async () => {
    vi.useFakeTimers()
    let dataChangeListener: ((change: any) => void) | undefined
    const { service, cloudClient } = createService(baseData, createEmptyCloudSyncManifest(), {
      configClient: {
        getStorageConfigs: vi.fn().mockResolvedValue([enabledWebDAVConfig])
      },
      subscribeToDataChanges: listener => {
        dataChangeListener = listener
        return vi.fn()
      }
    })
    cloudClient.getCloudSyncManifest.mockRejectedValue(new Error('ECONNRESET'))

    service.startAutoSync({
      syncOnStart: false,
      debounceMs: 25
    })
    dataChangeListener?.({
      storeName: 'prompts',
      action: 'update',
      id: 1,
      timestamp: Date.now(),
      sourceId: 'test'
    })

    await vi.advanceTimersByTimeAsync(25)
    expect(cloudClient.getCloudSyncManifest).toHaveBeenCalledTimes(1)
    expect(service.getStatus()).toMatchObject({
      status: 'error',
      pending: true,
      failureCount: 1
    })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(cloudClient.getCloudSyncManifest).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES * 60 * 1000 - 30_000)
    expect(cloudClient.getCloudSyncManifest).toHaveBeenCalledTimes(2)

    service.stopAutoSync()
  })

  it('surfaces storage config failures and retries instead of going idle', async () => {
    vi.useFakeTimers()
    let dataChangeListener: ((change: any) => void) | undefined
    const getStorageConfigs = vi.fn().mockRejectedValue(new Error('settings unavailable'))
    const { service, cloudClient } = createService(baseData, createEmptyCloudSyncManifest(), {
      configClient: {
        getStorageConfigs
      },
      subscribeToDataChanges: listener => {
        dataChangeListener = listener
        return vi.fn()
      }
    })

    service.startAutoSync({
      syncOnStart: false,
      debounceMs: 25
    })
    dataChangeListener?.({
      storeName: 'prompts',
      action: 'update',
      id: 1,
      timestamp: Date.now(),
      sourceId: 'test'
    })

    await vi.advanceTimersByTimeAsync(25)
    expect(getStorageConfigs).toHaveBeenCalledTimes(1)
    expect(cloudClient.getCloudSyncManifest).not.toHaveBeenCalled()
    expect(service.getStatus()).toMatchObject({
      status: 'error',
      pending: true,
      failureCount: 1
    })
    expect(service.getStatus().error).toContain('获取自动同步存储配置失败')

    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES * 60 * 1000)
    expect(getStorageConfigs).toHaveBeenCalledTimes(2)

    service.stopAutoSync()
  })

  it('retries only the storage that failed during automatic sync', async () => {
    vi.useFakeTimers()
    let dataChangeListener: ((change: any) => void) | undefined
    const secondConfig = {
      ...enabledWebDAVConfig,
      id: 'cfg-2',
      name: 'Second WebDAV'
    }
    const manifests: Record<string, any> = {
      'cfg-2': createEmptyCloudSyncManifest('2026-01-01T00:00:00.000Z')
    }
    const manifestReads: string[] = []
    const { service, cloudClient } = createService(baseData, createEmptyCloudSyncManifest(), {
      configClient: {
        getStorageConfigs: vi.fn().mockResolvedValue([enabledWebDAVConfig, secondConfig])
      },
      subscribeToDataChanges: listener => {
        dataChangeListener = listener
        return vi.fn()
      }
    })
    cloudClient.getCloudSyncManifest.mockImplementation(async (storageId: string) => {
      manifestReads.push(storageId)
      if (storageId === 'cfg-1') {
        throw new Error('ECONNRESET')
      }
      return manifests[storageId] || createEmptyCloudSyncManifest('2026-01-01T00:00:00.000Z')
    })
    cloudClient.saveCloudSyncManifest.mockImplementation(async (storageId: string, manifest: any) => {
      manifests[storageId] = manifest
      return { success: true }
    })

    service.startAutoSync({
      syncOnStart: false,
      debounceMs: 25
    })
    dataChangeListener?.({
      storeName: 'prompts',
      action: 'update',
      id: 1,
      timestamp: Date.now(),
      sourceId: 'test'
    })

    await vi.advanceTimersByTimeAsync(25)
    expect(manifestReads).toContain('cfg-1')
    expect(manifestReads).toContain('cfg-2')
    const cfg2ReadsAfterFirstRun = manifestReads.filter(storageId => storageId === 'cfg-2').length
    expect(service.getStatus()).toMatchObject({
      status: 'error',
      pending: true,
      storageId: 'cfg-1'
    })

    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES * 60 * 1000)

    expect(manifestReads.filter(storageId => storageId === 'cfg-1').length).toBeGreaterThan(1)
    expect(manifestReads.filter(storageId => storageId === 'cfg-2')).toHaveLength(cfg2ReadsAfterFirstRun)

    service.stopAutoSync()
  })

  it('does not schedule another upload from data changes emitted while applying remote data', async () => {
    vi.useFakeTimers()
    let dataChangeListener: ((change: any) => void) | undefined
    const emptyLocalData = {
      categories: [],
      prompts: [],
      promptVariables: [],
      promptHistories: [],
      aiConfigs: [],
      quickOptimizationConfigs: [],
      aiHistory: [],
      settings: [],
      syncTombstones: []
    }
    const remoteSnapshot = createCloudSyncSnapshot(baseData, 'device-b', 'rev-remote')
    const manifest = {
      ...createEmptyCloudSyncManifest('2026-01-02T00:00:00.000Z'),
      latestSnapshot: remoteSnapshot,
      baseSnapshot: remoteSnapshot
    }
    const { service, database } = createService(emptyLocalData, manifest, {
      configClient: {
        getStorageConfigs: vi.fn().mockResolvedValue([enabledWebDAVConfig])
      },
      subscribeToDataChanges: listener => {
        dataChangeListener = listener
        return vi.fn()
      }
    })
    database.replaceAllData.mockImplementation(async () => {
      dataChangeListener?.({
        storeName: 'prompts',
        action: 'create',
        id: 1,
        timestamp: Date.now(),
        sourceId: 'test'
      })
      return {
        success: true,
        message: 'ok'
      }
    })

    service.startAutoSync({
      syncOnStart: false,
      debounceMs: 25,
      pollIntervalMs: 0,
      retryMs: 0
    })

    const result = await service.syncNow('cfg-1')
    expect(result.success).toBe(true)
    expect(result.action).toBe('downloaded')

    await vi.advanceTimersByTimeAsync(25)

    expect(database.exportAllDataForSync).toHaveBeenCalledTimes(1)
    expect(service.getStatus()).toMatchObject({
      status: 'success',
      pending: false
    })

    service.stopAutoSync()
  })
})
