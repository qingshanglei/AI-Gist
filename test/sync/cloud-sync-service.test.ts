import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { CloudSyncService, type CloudSyncServiceDeps } from '~/lib/services/cloud-sync.service'
import { createCloudSyncSnapshot } from '@shared/cloud-sync-engine'
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
  const cloudClient = {
    getCloudSyncManifest: vi.fn().mockResolvedValue(manifest),
    saveCloudSyncManifest: vi.fn().mockResolvedValue({ success: true })
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

  it('does not schedule another upload from data changes emitted while applying remote data', async () => {
    vi.useFakeTimers()
    let dataChangeListener: ((change: any) => void) | undefined
    const emptyLocalData = {
      categories: [],
      prompts: [],
      promptVariables: [],
      promptHistories: [],
      aiConfigs: [],
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
