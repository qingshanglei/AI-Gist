/**
 * Cloud sync robustness E2E tests.
 *
 * These scenarios use the real local WebDAV test server and the desktop
 * WebDAV provider path, then inject narrowly-scoped failures around it.
 */

// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWebDAVServer } from '../helpers/webdav-server'
import { CloudSyncService } from '~/lib/services/cloud-sync.service'
import { WebDAVProvider } from '../../src/main/cloud/webdav-provider'
import type { CloudSyncDataSet, CloudSyncSnapshot } from '@shared/cloud-sync-engine'
import {
  createCloudSyncDataChecksum,
  createCloudSyncSnapshot
} from '@shared/cloud-sync-engine'
import type {
  CloudSyncManifest,
  CloudSyncManifestSaveOptions,
  CloudSyncManifestSaveResult
} from '@shared/cloud-sync-manifest'
import {
  assertValidCloudSyncManifest,
  createCloudSyncManifestRevisionConflictError,
  createEmptyCloudSyncManifest,
  doesCloudSyncManifestMatchExpectedRevision,
  getCloudSyncManifestRevision,
  readCloudSyncManifestWithFallback
} from '@shared/cloud-sync-manifest'
import {
  getCloudSyncManifestBackupPath,
  getCloudSyncManifestPath,
  getCloudSyncSnapshotPath,
  getCloudSyncSnapshotRevisionFromFileName,
  getCloudSyncSnapshotsDirectoryPath
} from '@shared/cloud-backup-paths'
import type { CloudSyncRemoteSnapshotInfo } from '@shared/cloud-sync-snapshots'
import {
  assertValidCloudSyncSnapshotFile,
  createCloudSyncSnapshotFile
} from '@shared/cloud-sync-snapshots'

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

class MutableSyncDatabase {
  data: CloudSyncDataSet
  readonly exportAllDataForSync = vi.fn()
  readonly replaceAllData = vi.fn()

  constructor(data: CloudSyncDataSet) {
    this.data = cloneData(data)
    this.exportAllDataForSync.mockImplementation(async () => ({
      success: true,
      message: 'ok',
      data: cloneData(this.data)
    }))
    this.replaceAllData.mockImplementation(async (nextData: CloudSyncDataSet) => {
      this.data = cloneData(nextData)
      return {
        success: true,
        message: 'ok'
      }
    })
  }
}

interface TestCloudClientHooks {
  saveCloudSyncManifest?: (
    context: {
      storageId: string
      manifest: CloudSyncManifest
      options: CloudSyncManifestSaveOptions
    },
    saveNormally: () => Promise<CloudSyncManifestSaveResult>
  ) => Promise<CloudSyncManifestSaveResult>
  getCloudSyncManifest?: (storageId: string) => Promise<CloudSyncManifest>
}

const USERNAME = 'testuser'
const PASSWORD = 'testpass'
const PORT = 18767

let server: TestWebDAVServer

describe('Cloud sync robustness E2E over WebDAV', () => {
  beforeAll(async () => {
    server = new TestWebDAVServer({ port: PORT, username: USERNAME, password: PASSWORD })
    await server.start()
  })

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('长时间离线后同步能合并两端不同记录变更，不丢任一端数据', async () => {
    const storageId = 'robust-offline-merge'
    const client = createWebDAVSyncClient(storageId)
    const initialData = createDataSet({
      promptTitle: 'Initial prompt',
      categoryName: 'Initial category',
      settingValue: 'dark'
    })
    const deviceADatabase = new MutableSyncDatabase(initialData)
    const deviceAStorage = new MemoryStorage()
    const deviceA = createSyncService(client, deviceADatabase, deviceAStorage, 'device-a')

    const firstSync = await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })
    expect(firstSync).toMatchObject({ success: true, action: 'uploaded' })

    const deviceBDatabase = new MutableSyncDatabase(emptyDataSet())
    const deviceB = createSyncService(client, deviceBDatabase, new MemoryStorage(), 'device-b')
    const deviceBDownload = await deviceB.syncNow(storageId, {
      deviceName: 'Desktop B',
      platform: 'electron',
      reason: 'manual'
    })
    expect(deviceBDownload).toMatchObject({ success: true, action: 'downloaded' })

    deviceADatabase.data = mutateDataSet(deviceADatabase.data, data => {
      data.categories![0].name = 'Offline category from A'
      data.categories![0].updatedAt = '2026-06-13T10:00:00.000Z'
    })
    deviceBDatabase.data = mutateDataSet(deviceBDatabase.data, data => {
      data.prompts![0].title = 'Remote prompt from B'
      data.prompts![0].updatedAt = '2026-06-13T10:05:00.000Z'
      data.settings = [{ key: 'theme', value: 'light', type: 'string', updatedAt: '2026-06-13T10:05:00.000Z' }]
    })

    const deviceBUpload = await deviceB.syncNow(storageId, {
      deviceName: 'Desktop B',
      platform: 'electron',
      reason: 'manual'
    })
    expect(deviceBUpload).toMatchObject({ success: true, action: 'uploaded' })

    const deviceAMerge = await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })
    expect(deviceAMerge, JSON.stringify(deviceAMerge, null, 2)).toMatchObject({ success: true, action: 'merged' })
    expect(deviceADatabase.replaceAllData).toHaveBeenCalledTimes(1)

    const manifest = await client.getCloudSyncManifest(storageId)
    expect(manifest.latestSnapshot?.data.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'cat-main', name: 'Offline category from A' })
    ]))
    expect(manifest.latestSnapshot?.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'prompt-main', title: 'Remote prompt from B' })
    ]))
    expect(manifest.latestSnapshot?.data.settings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'theme', value: 'light' })
    ]))
    expect(manifest.latestSnapshot?.dataChecksum).toBe(
      createCloudSyncDataChecksum(manifest.latestSnapshot!.data)
    )
  })

  it('多端编辑同一记录时自动按更新时间解决冲突并记录冲突审计', async () => {
    const storageId = 'robust-same-record-conflict'
    const client = createWebDAVSyncClient(storageId)
    const initialData = createDataSet({ promptTitle: 'Base prompt' })
    const deviceADatabase = new MutableSyncDatabase(initialData)
    const deviceAStorage = new MemoryStorage()
    const deviceA = createSyncService(client, deviceADatabase, deviceAStorage, 'device-a')
    expect((await deviceA.syncNow(storageId, { platform: 'electron' })).success).toBe(true)

    const deviceBDatabase = new MutableSyncDatabase(emptyDataSet())
    const deviceB = createSyncService(client, deviceBDatabase, new MemoryStorage(), 'device-b')
    expect((await deviceB.syncNow(storageId, { platform: 'electron' })).action).toBe('downloaded')

    deviceADatabase.data = mutateDataSet(deviceADatabase.data, data => {
      data.prompts![0].title = 'Older local edit from A'
      data.prompts![0].updatedAt = '2026-06-13T10:00:00.000Z'
    })
    deviceBDatabase.data = mutateDataSet(deviceBDatabase.data, data => {
      data.prompts![0].title = 'Newer remote edit from B'
      data.prompts![0].updatedAt = '2026-06-13T10:30:00.000Z'
    })
    expect((await deviceB.syncNow(storageId, { platform: 'electron' })).action).toBe('uploaded')

    const result = await deviceA.syncNow(storageId, {
      platform: 'electron',
      reason: 'manual'
    })

    expect(result.success, JSON.stringify(result, null, 2)).toBe(true)
    expect(result.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        collection: 'prompts',
        key: 'uuid:prompt-main',
        reason: 'both_modified',
        resolution: 'take-newer'
      })
    ]))
    expect(deviceADatabase.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'prompt-main', title: 'Newer remote edit from B' })
    ]))
    expect(deviceAStorage.getItem('ai_gist_cloud_sync_conflict_log')).toContain('prompt-main')
  })

  it('保存 manifest 前另一端抢先更新时会自动重读并合并后成功', async () => {
    const storageId = 'robust-remote-changes-during-save'
    const baseClient = createWebDAVSyncClient(storageId)
    const initialData = createDataSet({ promptTitle: 'Base prompt' })
    const deviceADatabase = new MutableSyncDatabase(initialData)
    const deviceBDatabase = new MutableSyncDatabase(emptyDataSet())
    const deviceB = createSyncService(baseClient, deviceBDatabase, new MemoryStorage(), 'device-b')
    const deviceAStorage = new MemoryStorage()

    const deviceAInitial = createSyncService(baseClient, deviceADatabase, deviceAStorage, 'device-a')
    expect((await deviceAInitial.syncNow(storageId, { platform: 'electron' })).success).toBe(true)
    expect((await deviceB.syncNow(storageId, { platform: 'electron' })).action).toBe('downloaded')

    deviceADatabase.data = mutateDataSet(deviceADatabase.data, data => {
      data.categories![0].name = 'A local category'
      data.categories![0].updatedAt = '2026-06-13T11:00:00.000Z'
    })
    deviceBDatabase.data = mutateDataSet(deviceBDatabase.data, data => {
      data.prompts![0].title = 'B remote prompt'
      data.prompts![0].updatedAt = '2026-06-13T11:01:00.000Z'
    })

    let injectedRemoteChange = false
    const racingClient = createWebDAVSyncClient(storageId, {
      saveCloudSyncManifest: async (_context, saveNormally) => {
        if (!injectedRemoteChange) {
          injectedRemoteChange = true
          const remoteResult = await deviceB.syncNow(storageId, {
            deviceName: 'Desktop B',
            platform: 'electron',
            reason: 'manual'
          })
          expect(remoteResult).toMatchObject({ success: true, action: 'uploaded' })
        }

        return saveNormally()
      }
    })
    const racingDeviceA = createSyncService(racingClient, deviceADatabase, deviceAStorage, 'device-a')

    const result = await racingDeviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })

    expect(result.success, JSON.stringify(result, null, 2)).toBe(true)
    expect(result.action).toBe('merged')
    expect(result.error).toBeUndefined()

    const manifest = await baseClient.getCloudSyncManifest(storageId)
    expect(manifest.latestSnapshot?.data.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'cat-main', name: 'A local category' })
    ]))
    expect(manifest.latestSnapshot?.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'prompt-main', title: 'B remote prompt' })
    ]))
  })

  it('同步到一半只写入 snapshot 时，下次启动能从快照文件恢复 manifest', async () => {
    const storageId = 'robust-half-written-sync'
    let failManifestWrite = true
    const failingClient = createWebDAVSyncClient(storageId, {
      saveCloudSyncManifest: async (_context, saveNormally) => {
        if (failManifestWrite) {
          failManifestWrite = false
          return { success: false, error: 'HTTP 500 while saving manifest' }
        }

        return saveNormally()
      }
    })
    const data = createDataSet({ promptTitle: 'Half written prompt' })
    const firstDatabase = new MutableSyncDatabase(data)
    const firstDevice = createSyncService(failingClient, firstDatabase, new MemoryStorage(), 'device-half')

    const failed = await firstDevice.syncNow(storageId, {
      deviceName: 'Half Device',
      platform: 'electron',
      reason: 'manual'
    })
    expect(failed.success).toBe(false)
    expect(failed.error).toContain('HTTP 500')

    const normalClient = createWebDAVSyncClient(storageId)
    expect(await normalClient.listCloudSyncSnapshots(storageId)).toHaveLength(1)
    expect((await normalClient.getCloudSyncManifest(storageId)).latestSnapshot).toBeUndefined()

    const restartedDevice = createSyncService(
      normalClient,
      new MutableSyncDatabase(data),
      new MemoryStorage(),
      'device-half'
    )
    const recovered = await restartedDevice.syncNow(storageId, {
      deviceName: 'Half Device Restarted',
      platform: 'electron',
      reason: 'manual'
    })
    expect(recovered.success).toBe(true)
    expect(recovered.error).toBeUndefined()

    const manifest = await normalClient.getCloudSyncManifest(storageId)
    expect(manifest.latestSnapshot?.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'prompt-main', title: 'Half written prompt' })
    ]))
  })

  it('大量数据并发连续点击同步时只生成必要快照且不会反复报错', async () => {
    const storageId = 'robust-large-concurrent-clicks'
    const client = createWebDAVSyncClient(storageId)
    const largeData = createLargeDataSet(600)
    const database = new MutableSyncDatabase(largeData)
    const service = createSyncService(client, database, new MemoryStorage(), 'device-large')

    const concurrentResults = await Promise.all([
      service.syncNow(storageId, { platform: 'electron', reason: 'manual' }),
      service.syncNow(storageId, { platform: 'electron', reason: 'manual' }),
      service.syncNow(storageId, { platform: 'electron', reason: 'manual' }),
      service.syncNow(storageId, { platform: 'electron', reason: 'manual' })
    ])
    expect(concurrentResults.every(result => result.success)).toBe(true)
    expect(new Set(concurrentResults.map(result => result.remoteRevision))).toHaveLength(1)

    const second = await service.syncNow(storageId, { platform: 'electron', reason: 'manual' })
    const third = await service.syncNow(storageId, { platform: 'electron', reason: 'manual' })
    expect(second).toMatchObject({ success: true, action: 'noop' })
    expect(third).toMatchObject({ success: true, action: 'noop' })

    const snapshots = await client.listCloudSyncSnapshots(storageId)
    expect(snapshots).toHaveLength(1)
    const manifest = await client.getCloudSyncManifest(storageId)
    expect(manifest.latestSnapshot?.data.prompts).toHaveLength(600)
    expect(manifest.latestSnapshot?.data.promptVariables).toHaveLength(600)
    expect(manifest.latestSnapshot?.data.promptHistories).toHaveLength(600)
  })

  it('断网或服务端临时错误后再次手动同步能成功且不会改写本地数据', async () => {
    const storageId = 'robust-offline-then-retry'
    let offline = true
    const client = createWebDAVSyncClient(storageId, {
      getCloudSyncManifest: async () => {
        if (offline) {
          throw new Error('ECONNRESET simulated offline')
        }

        return createWebDAVSyncClient(storageId).getCloudSyncManifest(storageId)
      }
    })
    const database = new MutableSyncDatabase(createDataSet({ promptTitle: 'Offline retry prompt' }))
    const service = createSyncService(client, database, new MemoryStorage(), 'device-offline')

    const failed = await service.syncNow(storageId, {
      platform: 'electron',
      reason: 'manual'
    })
    expect(failed.success).toBe(false)
    expect(failed.error).toContain('ECONNRESET')
    expect(database.replaceAllData).not.toHaveBeenCalled()

    offline = false
    const retried = await service.syncNow(storageId, {
      platform: 'electron',
      reason: 'manual'
    })
    expect(retried).toMatchObject({ success: true, action: 'uploaded' })
    expect(retried.error).toBeUndefined()
  })
})

function createSyncService(
  cloudClient: ReturnType<typeof createWebDAVSyncClient>,
  database: MutableSyncDatabase,
  storage: MemoryStorage,
  deviceId: string
): CloudSyncService {
  return new CloudSyncService({
    cloudClient,
    database,
    storage,
    createDeviceId: () => deviceId
  })
}

function createWebDAVSyncClient(
  storageId: string,
  hooks: TestCloudClientHooks = {}
) {
  const provider = new WebDAVProvider({
    id: storageId,
    name: `WebDAV ${storageId}`,
    type: 'webdav',
    enabled: true,
    url: `${server.baseUrl}/${storageId}`,
    username: USERNAME,
    password: PASSWORD,
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z'
  })
  const formatError = (error: unknown) => error instanceof Error ? error.message : String(error)
  const isNotFoundError = (error: unknown) => /404|not\s*found|does not exist|ENOENT|不存在|未找到/i
    .test(formatError(error))
  const isRevisionConflictError = (error: unknown) => /Precondition|412|if-match|if-none-match|已存在，取消覆盖|已被其他设备更新/i
    .test(formatError(error))

  const readManifestFile = async (cloudPath: string) => {
    const data = await provider.readFile(cloudPath)
    return assertValidCloudSyncManifest(JSON.parse(Buffer.from(data).toString('utf-8')))
  }

  const readManifest = async () => readCloudSyncManifestWithFallback({
    readPrimary: () => readManifestFile(getCloudSyncManifestPath()),
    readBackup: () => readManifestFile(getCloudSyncManifestBackupPath()),
    isNotFoundError,
    describeError: formatError
  })

  const readSnapshot = async (snapshot: CloudSyncRemoteSnapshotInfo | string) => {
    const snapshotPath = typeof snapshot === 'string'
      ? getCloudSyncSnapshotPath(snapshot)
      : snapshot.path || getCloudSyncSnapshotPath(snapshot.revision)
    const data = await provider.readFile(snapshotPath)
    return assertValidCloudSyncSnapshotFile(JSON.parse(Buffer.from(data).toString('utf-8')))
  }

  const client = {
    async getCloudSyncManifest(targetStorageId: string) {
      if (hooks.getCloudSyncManifest) {
        return hooks.getCloudSyncManifest(targetStorageId)
      }

      return readManifest()
    },

    async saveCloudSyncManifest(
      targetStorageId: string,
      manifest: CloudSyncManifest,
      options: CloudSyncManifestSaveOptions = {}
    ) {
      const saveNormally = async (): Promise<CloudSyncManifestSaveResult> => {
        try {
          await provider.initializeDirectories()
          const currentManifest = await readManifest()
          if (!doesCloudSyncManifestMatchExpectedRevision(currentManifest, options.expectedRevision)) {
            throw createCloudSyncManifestRevisionConflictError(
              options.expectedRevision,
              getCloudSyncManifestRevision(currentManifest)
            )
          }

          const primaryInfo = await provider.getFileInfo(getCloudSyncManifestPath())
          const content = Buffer.from(JSON.stringify(assertValidCloudSyncManifest(manifest), null, 2), 'utf-8')
          await provider.writeFile(getCloudSyncManifestPath(), content, {
            ifMatch: primaryInfo?.etag,
            ifNoneMatch: !primaryInfo && !currentManifest.latestSnapshot
          })
          await provider.writeFile(getCloudSyncManifestBackupPath(), content)
          return { success: true }
        } catch (error) {
          return {
            success: false,
            conflict: isRevisionConflictError(error),
            error: formatError(error),
            currentRevision: isRevisionConflictError(error)
              ? getCloudSyncManifestRevision(await readManifest().catch(() => createEmptyCloudSyncManifest()))
              : undefined
          }
        }
      }

      if (hooks.saveCloudSyncManifest) {
        return hooks.saveCloudSyncManifest({
          storageId: targetStorageId,
          manifest,
          options
        }, saveNormally)
      }

      return saveNormally()
    },

    async listCloudSyncSnapshots(_targetStorageId: string) {
      try {
        const files = await provider.listFiles(getCloudSyncSnapshotsDirectoryPath())
        return files
          .filter(file => !file.isDirectory)
          .map(file => {
            const revision = getCloudSyncSnapshotRevisionFromFileName(file.name)
            return revision
              ? {
                  revision,
                  path: getCloudSyncSnapshotPath(revision),
                  modifiedAt: file.modifiedAt,
                  size: file.size
                }
              : null
          })
          .filter((snapshot): snapshot is CloudSyncRemoteSnapshotInfo => !!snapshot)
      } catch (error) {
        if (isNotFoundError(error)) {
          return []
        }
        throw error
      }
    },

    async readCloudSyncSnapshot(_targetStorageId: string, snapshot: CloudSyncRemoteSnapshotInfo | string) {
      return readSnapshot(snapshot)
    },

    async saveCloudSyncSnapshot(_targetStorageId: string, snapshot: CloudSyncSnapshot) {
      try {
        await provider.initializeDirectories()
        const normalizedSnapshot = assertValidCloudSyncSnapshotFile(snapshot)
        const content = Buffer.from(
          JSON.stringify(createCloudSyncSnapshotFile(normalizedSnapshot), null, 2),
          'utf-8'
        )
        const snapshotPath = getCloudSyncSnapshotPath(normalizedSnapshot.revision)
        try {
          await provider.writeFile(snapshotPath, content, { ifNoneMatch: true })
          return { success: true }
        } catch (error) {
          if (!isRevisionConflictError(error)) {
            throw error
          }

          const existingSnapshot = await readSnapshot(normalizedSnapshot.revision)
          if (
            existingSnapshot.revision === normalizedSnapshot.revision &&
            existingSnapshot.dataChecksum === normalizedSnapshot.dataChecksum &&
            JSON.stringify(existingSnapshot.data) === JSON.stringify(normalizedSnapshot.data)
          ) {
            return { success: true }
          }

          throw new Error(`云同步快照 ${normalizedSnapshot.revision} 已存在但内容不一致`)
        }
      } catch (error) {
        return { success: false, error: formatError(error) }
      }
    }
  }

  return client
}

function createDataSet(input: {
  promptTitle?: string
  categoryName?: string
  settingValue?: string
  promptUpdatedAt?: string
} = {}): CloudSyncDataSet {
  const updatedAt = input.promptUpdatedAt || '2026-06-13T09:00:00.000Z'
  return {
    categories: [{
      id: 1,
      uuid: 'cat-main',
      name: input.categoryName || 'Main category',
      isActive: true,
      sortOrder: 1,
      updatedAt
    }],
    prompts: [{
      id: 10,
      uuid: 'prompt-main',
      title: input.promptTitle || 'Main prompt',
      content: 'Write a summary for {{topic}}',
      categoryId: 1,
      tags: ['sync', 'robustness'],
      isFavorite: false,
      useCount: 1,
      isActive: true,
      updatedAt
    }],
    promptVariables: [{
      id: 20,
      uuid: 'var-main',
      promptId: 10,
      name: 'topic',
      type: 'text',
      defaultValue: 'sync',
      required: true,
      sortOrder: 1,
      updatedAt
    }],
    promptHistories: [{
      id: 30,
      uuid: 'history-main',
      promptId: 10,
      promptUuid: 'prompt-main',
      title: input.promptTitle || 'Main prompt',
      content: 'Write a summary for {{topic}}',
      version: 1,
      updatedAt
    }],
    aiConfigs: [],
    quickOptimizationConfigs: [],
    aiHistory: [],
    settings: [{ key: 'theme', value: input.settingValue || 'dark', type: 'string', updatedAt }],
    syncTombstones: []
  }
}

function createLargeDataSet(count: number): CloudSyncDataSet {
  const data = emptyDataSet()
  data.categories = [
    { id: 1, uuid: 'cat-large', name: 'Large category', isActive: true, updatedAt: '2026-06-13T09:00:00.000Z' }
  ]
  data.prompts = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    uuid: `prompt-large-${index}`,
    title: `Large prompt ${index}`,
    content: `Content ${index} with {{topic_${index}}}`,
    categoryId: 1,
    tags: ['large', `batch-${Math.floor(index / 50)}`],
    isFavorite: index % 7 === 0,
    useCount: index,
    isActive: true,
    updatedAt: '2026-06-13T09:00:00.000Z'
  }))
  data.promptVariables = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    uuid: `var-large-${index}`,
    promptId: index + 1,
    name: `topic_${index}`,
    type: 'text',
    defaultValue: `Topic ${index}`,
    required: index % 2 === 0,
    sortOrder: index,
    updatedAt: '2026-06-13T09:00:00.000Z'
  }))
  data.promptHistories = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    uuid: `history-large-${index}`,
    promptId: index + 1,
    promptUuid: `prompt-large-${index}`,
    title: `Large prompt ${index}`,
    content: `Previous content ${index}`,
    version: 1,
    updatedAt: '2026-06-13T09:00:00.000Z'
  }))
  data.settings = [{ key: 'theme', value: 'dark', type: 'string', updatedAt: '2026-06-13T09:00:00.000Z' }]
  return data
}

function emptyDataSet(): CloudSyncDataSet {
  return {
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
}

function mutateDataSet(data: CloudSyncDataSet, mutate: (data: CloudSyncDataSet) => void): CloudSyncDataSet {
  const nextData = cloneData(data)
  mutate(nextData)
  return nextData
}

function cloneData<T>(data: T): T {
  return JSON.parse(JSON.stringify(data))
}
