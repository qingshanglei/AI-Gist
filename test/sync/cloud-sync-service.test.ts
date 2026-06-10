import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CloudSyncService } from '~/lib/services/cloud-sync.service'
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
  promptHistories: [],
  aiConfigs: [],
  aiHistory: [],
  settings: [],
  syncTombstones: []
}

function createService(data: any, manifest = createEmptyCloudSyncManifest('2026-01-01T00:00:00.000Z')) {
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
    createDeviceId: () => 'device-a'
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
})
