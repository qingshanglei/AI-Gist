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
const INITIAL_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZ2nNwAAAABJRU5ErkJggg=='
const UPDATED_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADUlEQVR42mP8z8BQDwAFgwJ/lZ2nNwAAAABJRU5ErkJggg=='

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

  it('真实创建含图片和历史的数据后跨端更新不会丢失元数据', async () => {
    const storageId = 'robust-real-create-then-update'
    const client = createWebDAVSyncClient(storageId)
    const deviceADatabase = new MutableSyncDatabase(createRealisticDataSet())
    const deviceAStorage = new MemoryStorage()
    const deviceA = createSyncService(client, deviceADatabase, deviceAStorage, 'device-a')

    const createUpload = await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })
    expect(createUpload).toMatchObject({ success: true, action: 'uploaded' })

    const deviceBDatabase = new MutableSyncDatabase(emptyDataSet())
    const deviceB = createSyncService(client, deviceBDatabase, new MemoryStorage(), 'device-b')
    const firstDownload = await deviceB.syncNow(storageId, {
      deviceName: 'Phone B',
      platform: 'ios',
      reason: 'manual'
    })
    expect(firstDownload).toMatchObject({ success: true, action: 'downloaded' })
    expect(deviceBDatabase.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'real-prompt-launch',
        imageBlobs: [INITIAL_IMAGE]
      })
    ]))
    expect(deviceBDatabase.data.promptHistories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'real-history-initial',
        imageBlobs: [INITIAL_IMAGE]
      })
    ]))

    deviceBDatabase.data = mutateDataSet(deviceBDatabase.data, data => {
      data.categories![0].name = '真实项目资料-移动端更新'
      data.categories![0].updatedAt = '2026-06-13T14:00:00.000Z'
      data.prompts![0].title = '发布计划提示词 - 移动端更新'
      data.prompts![0].content = '请用 {{tone}} 语气生成移动端更新版发布计划'
      data.prompts![0].tags = ['release', 'mobile', 'updated']
      data.prompts![0].imageBlobs = [INITIAL_IMAGE, UPDATED_IMAGE]
      data.prompts![0].updatedAt = '2026-06-13T14:00:00.000Z'
      data.promptVariables![0].defaultValue = 'precise'
      data.promptVariables![0].updatedAt = '2026-06-13T14:00:00.000Z'
      data.promptHistories!.push({
        id: 42,
        uuid: 'real-history-mobile-update',
        promptId: 31,
        promptUuid: 'real-prompt-launch',
        title: '发布计划提示词 - 移动端更新',
        content: '移动端更新后再次生成发布计划',
        result: 'Updated launch plan from mobile',
        version: 2,
        imageBlobs: [UPDATED_IMAGE],
        createdAt: '2026-06-13T14:01:00.000Z',
        updatedAt: '2026-06-13T14:01:00.000Z'
      })
      data.aiHistory!.push({
        id: 51,
        uuid: 'real-ai-history-mobile-update',
        promptUuid: 'real-prompt-launch',
        input: '生成移动端更新发布计划',
        output: '移动端更新后的发布计划结果',
        provider: 'openai',
        model: 'gpt-4.1',
        createdAt: '2026-06-13T14:02:00.000Z',
        updatedAt: '2026-06-13T14:02:00.000Z'
      })
      data.settings = [
        { key: 'theme', value: 'light', type: 'string', updatedAt: '2026-06-13T14:00:00.000Z' },
        { key: 'cloud.sync.intervalMinutes', value: 5, type: 'number', updatedAt: '2026-06-13T14:00:00.000Z' }
      ]
      data.quickOptimizationConfigs![0].prompt = '请更精确地优化：{{content}}'
      data.quickOptimizationConfigs![0].updatedAt = '2026-06-13T14:00:00.000Z'
    })

    const updateUpload = await deviceB.syncNow(storageId, {
      deviceName: 'Phone B',
      platform: 'ios',
      reason: 'manual'
    })
    expect(updateUpload).toMatchObject({ success: true, action: 'uploaded' })

    const backToA = await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })
    expect(backToA.success, JSON.stringify(backToA, null, 2)).toBe(true)
    expect(backToA.error).toBeUndefined()
    expect(deviceADatabase.data.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'real-category-product', name: '真实项目资料-移动端更新' })
    ]))
    expect(deviceADatabase.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'real-prompt-launch',
        title: '发布计划提示词 - 移动端更新',
        imageBlobs: [INITIAL_IMAGE, UPDATED_IMAGE]
      })
    ]))
    expect(deviceADatabase.data.promptVariables).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'real-variable-tone', defaultValue: 'precise' })
    ]))
    expect(deviceADatabase.data.promptHistories).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'real-history-initial', imageBlobs: [INITIAL_IMAGE] }),
      expect.objectContaining({ uuid: 'real-history-mobile-update', imageBlobs: [UPDATED_IMAGE] })
    ]))
    expect(deviceADatabase.data.aiHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'real-ai-history-mobile-update',
        output: '移动端更新后的发布计划结果'
      })
    ]))
    expect(deviceADatabase.data.settings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'theme', value: 'light' }),
      expect.objectContaining({ key: 'cloud.sync.intervalMinutes', value: 5 })
    ]))
    expect(deviceADatabase.data.quickOptimizationConfigs).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'quick-real-cleanup', prompt: '请更精确地优化：{{content}}' })
    ]))

    const manifest = await client.getCloudSyncManifest(storageId)
    expect(manifest.latestSnapshot?.dataChecksum)
      .toBe(createCloudSyncDataChecksum(manifest.latestSnapshot!.data))
    const finalNoop = await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })
    expect(finalNoop).toMatchObject({ success: true, action: 'noop' })
  })

  it('删除提示词后会通过 tombstone 跨端删除变量和历史且不会复活', async () => {
    const storageId = 'robust-delete-propagates-tombstones'
    const client = createWebDAVSyncClient(storageId)
    const deviceADatabase = new MutableSyncDatabase(createRealisticDataSet())
    const deviceA = createSyncService(client, deviceADatabase, new MemoryStorage(), 'device-a')

    const firstUpload = await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })
    expect(firstUpload).toMatchObject({ success: true, action: 'uploaded' })

    const deviceBDatabase = new MutableSyncDatabase(emptyDataSet())
    const deviceB = createSyncService(client, deviceBDatabase, new MemoryStorage(), 'device-b')
    expect(await deviceB.syncNow(storageId, {
      deviceName: 'Phone B',
      platform: 'ios',
      reason: 'manual'
    })).toMatchObject({ success: true, action: 'downloaded' })
    expect(deviceBDatabase.data.prompts).toHaveLength(1)
    expect(deviceBDatabase.data.promptVariables).toHaveLength(1)
    expect(deviceBDatabase.data.promptHistories).toHaveLength(1)

    deviceADatabase.data = mutateDataSet(deviceADatabase.data, data => {
      const deletedAt = '2026-06-13T15:00:00.000Z'
      data.prompts = []
      data.promptVariables = []
      data.promptHistories = []
      data.syncTombstones = [
        createTombstone('prompts', 'real-prompt-launch', deletedAt),
        createTombstone('promptVariables', 'real-variable-tone', deletedAt),
        createTombstone('promptHistories', 'real-history-initial', deletedAt)
      ]
    })

    const deleteUpload = await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })
    expect(deleteUpload, JSON.stringify(deleteUpload, null, 2))
      .toMatchObject({ success: true, action: 'uploaded' })

    const deleteDownload = await deviceB.syncNow(storageId, {
      deviceName: 'Phone B',
      platform: 'ios',
      reason: 'manual'
    })
    expect(deleteDownload, JSON.stringify(deleteDownload, null, 2))
      .toMatchObject({ success: true, action: 'downloaded' })
    expect(deviceBDatabase.data.prompts).toEqual([])
    expect(deviceBDatabase.data.promptVariables).toEqual([])
    expect(deviceBDatabase.data.promptHistories).toEqual([])
    expect(deviceBDatabase.data.syncTombstones).toEqual(expect.arrayContaining([
      expect.objectContaining({ collectionName: 'prompts', recordUuid: 'real-prompt-launch' }),
      expect.objectContaining({ collectionName: 'promptVariables', recordUuid: 'real-variable-tone' }),
      expect.objectContaining({ collectionName: 'promptHistories', recordUuid: 'real-history-initial' })
    ]))

    const retry = await deviceB.syncNow(storageId, {
      deviceName: 'Phone B',
      platform: 'ios',
      reason: 'manual'
    })
    expect(retry).toMatchObject({ success: true, action: 'noop' })
  })

  it('旧 tombstone 遇到另一端较新的更新时不会误删用户新内容', async () => {
    const storageId = 'robust-older-delete-newer-update'
    const client = createWebDAVSyncClient(storageId)
    const deviceADatabase = new MutableSyncDatabase(createDataSet({
      promptTitle: 'Delete conflict base',
      promptUpdatedAt: '2026-06-13T15:00:00.000Z'
    }))
    const deviceAStorage = new MemoryStorage()
    const deviceA = createSyncService(client, deviceADatabase, deviceAStorage, 'device-a')
    expect(await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })).toMatchObject({ success: true, action: 'uploaded' })

    const deviceBDatabase = new MutableSyncDatabase(emptyDataSet())
    const deviceB = createSyncService(client, deviceBDatabase, new MemoryStorage(), 'device-b')
    expect(await deviceB.syncNow(storageId, {
      deviceName: 'Desktop B',
      platform: 'electron',
      reason: 'manual'
    })).toMatchObject({ success: true, action: 'downloaded' })

    deviceADatabase.data = mutateDataSet(deviceADatabase.data, data => {
      data.prompts = []
      data.syncTombstones = [
        createTombstone('prompts', 'prompt-main', '2026-06-13T15:05:00.000Z')
      ]
    })
    deviceBDatabase.data = mutateDataSet(deviceBDatabase.data, data => {
      data.prompts![0].title = 'Newer edit should survive delete'
      data.prompts![0].updatedAt = '2026-06-13T15:10:00.000Z'
    })

    const deleteUpload = await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })
    expect(deleteUpload).toMatchObject({ success: true, action: 'uploaded' })

    const conflictResult = await deviceB.syncNow(storageId, {
      deviceName: 'Desktop B',
      platform: 'electron',
      reason: 'manual'
    })
    expect(conflictResult.success, JSON.stringify(conflictResult, null, 2)).toBe(true)
    expect(conflictResult.action).toBe('merged')
    expect(conflictResult.uploadedRemote).toBe(true)
    expect(conflictResult.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        collection: 'prompts',
        key: 'uuid:prompt-main',
        reason: 'delete_vs_update',
        resolution: 'keep-local'
      })
    ]))

    const manifest = await client.getCloudSyncManifest(storageId)
    expect(manifest.latestSnapshot?.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'prompt-main',
        title: 'Newer edit should survive delete'
      })
    ]))
    expect(manifest.latestSnapshot?.dataChecksum)
      .toBe(createCloudSyncDataChecksum(manifest.latestSnapshot!.data))

    const deviceCDatabase = new MutableSyncDatabase(emptyDataSet())
    const deviceC = createSyncService(client, deviceCDatabase, new MemoryStorage(), 'device-c')
    const cDownload = await deviceC.syncNow(storageId, {
      deviceName: 'Tablet C',
      platform: 'web',
      reason: 'manual'
    })
    expect(cDownload).toMatchObject({ success: true, action: 'downloaded' })
    expect(deviceCDatabase.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'prompt-main',
        title: 'Newer edit should survive delete'
      })
    ]))
  })

  it('新设备只有本地数字 ID 重建时不会误上传新 revision 或打断引用关系', async () => {
    const storageId = 'robust-reinstall-regenerated-local-ids'
    const client = createWebDAVSyncClient(storageId)
    const remoteData = createRealisticDataSet()
    const deviceADatabase = new MutableSyncDatabase(remoteData)
    const deviceA = createSyncService(client, deviceADatabase, new MemoryStorage(), 'device-a')

    const firstUpload = await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })
    expect(firstUpload).toMatchObject({ success: true, action: 'uploaded' })
    const manifestBeforeReinstall = await client.getCloudSyncManifest(storageId)
    const snapshotsBeforeReinstall = await client.listCloudSyncSnapshots(storageId)

    const regeneratedLocalData = regenerateLocalNumericIds(remoteData, 5000)
    expect(createCloudSyncDataChecksum(regeneratedLocalData))
      .not.toBe(createCloudSyncDataChecksum(remoteData))

    const newInstallDatabase = new MutableSyncDatabase(regeneratedLocalData)
    const newInstall = createSyncService(client, newInstallDatabase, new MemoryStorage(), 'device-new-install')
    const result = await newInstall.syncNow(storageId, {
      deviceName: 'Fresh Install',
      platform: 'web',
      reason: 'manual'
    })

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      success: true,
      action: 'noop',
      uploadedRemote: false,
      appliedLocal: false
    })
    const manifestAfterReinstall = await client.getCloudSyncManifest(storageId)
    const snapshotsAfterReinstall = await client.listCloudSyncSnapshots(storageId)
    expect(manifestAfterReinstall.latestSnapshot?.revision)
      .toBe(manifestBeforeReinstall.latestSnapshot?.revision)
    expect(snapshotsAfterReinstall).toHaveLength(snapshotsBeforeReinstall.length)
    expect(newInstallDatabase.replaceAllData).not.toHaveBeenCalled()
    expect(newInstallDatabase.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'real-prompt-launch',
        id: 5031,
        categoryId: 5011,
        categoryUuid: 'real-category-product'
      })
    ]))
    expect(newInstallDatabase.data.promptVariables).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'real-variable-tone',
        id: 5041,
        promptId: 5031,
        promptUuid: 'real-prompt-launch'
      })
    ]))
    expect(newInstallDatabase.data.promptHistories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'real-history-initial',
        id: 5041,
        promptId: 5031,
        promptUuid: 'real-prompt-launch'
      })
    ]))
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

  it('应用远端数据中途失败时会回滚本机数据，下次同步能继续完整下载', async () => {
    const storageId = 'robust-local-apply-rollback'
    const client = createWebDAVSyncClient(storageId)
    const baseData = createDataSet({ promptTitle: 'Rollback base prompt' })
    const deviceADatabase = new MutableSyncDatabase(baseData)
    const deviceAStorage = new MemoryStorage()
    const deviceA = createSyncService(client, deviceADatabase, deviceAStorage, 'device-a')

    const firstSync = await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })
    expect(firstSync).toMatchObject({ success: true, action: 'uploaded' })
    const localBeforeFailedDownload = cloneData(deviceADatabase.data)

    const deviceBDatabase = new MutableSyncDatabase(emptyDataSet())
    const deviceB = createSyncService(client, deviceBDatabase, new MemoryStorage(), 'device-b')
    expect((await deviceB.syncNow(storageId, { platform: 'electron' })).action).toBe('downloaded')

    deviceBDatabase.data = mutateDataSet(deviceBDatabase.data, data => {
      data.prompts![0].title = 'Rollback remote prompt from B'
      data.prompts![0].updatedAt = '2026-06-13T12:00:00.000Z'
      data.promptVariables![0].defaultValue = 'remote value'
      data.promptVariables![0].updatedAt = '2026-06-13T12:00:00.000Z'
      data.promptHistories!.push({
        id: 31,
        uuid: 'history-remote-v2',
        promptId: 10,
        promptUuid: 'prompt-main',
        title: 'Rollback remote prompt from B',
        content: 'Remote v2 history',
        version: 2,
        updatedAt: '2026-06-13T12:00:00.000Z'
      })
      data.settings = [{
        key: 'theme',
        value: 'remote-light',
        type: 'string',
        updatedAt: '2026-06-13T12:00:00.000Z'
      }]
    })
    const bUpload = await deviceB.syncNow(storageId, {
      deviceName: 'Desktop B',
      platform: 'electron',
      reason: 'manual'
    })
    expect(bUpload).toMatchObject({ success: true, action: 'uploaded' })
    const remoteRevisionBeforeFailedDownload = (await client.getCloudSyncManifest(storageId)).latestSnapshot?.revision

    let replaceCalls = 0
    deviceADatabase.replaceAllData.mockImplementation(async (nextData: CloudSyncDataSet) => {
      replaceCalls += 1
      if (replaceCalls === 1) {
        deviceADatabase.data = mutateDataSet(nextData, data => {
          data.promptHistories = []
        })
        return {
          success: false,
          message: 'partial IndexedDB restore failed',
          error: 'partial IndexedDB restore failed'
        }
      }

      deviceADatabase.data = cloneData(nextData)
      return {
        success: true,
        message: 'ok'
      }
    })

    const failedDownload = await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })
    expect(failedDownload.success).toBe(false)
    expect(failedDownload.error).toContain('partial IndexedDB restore failed')
    expect(failedDownload.appliedLocal).toBe(false)
    expect(replaceCalls).toBe(2)
    expect(deviceADatabase.data).toEqual(localBeforeFailedDownload)
    expect((await client.getCloudSyncManifest(storageId)).latestSnapshot?.revision)
      .toBe(remoteRevisionBeforeFailedDownload)
    expect(deviceAStorage.getItem('ai_gist_cloud_sync_state:robust-local-apply-rollback'))
      .toContain(firstSync.remoteRevision)

    deviceADatabase.replaceAllData.mockImplementation(async (nextData: CloudSyncDataSet) => {
      deviceADatabase.data = cloneData(nextData)
      return {
        success: true,
        message: 'ok'
      }
    })

    const retriedDownload = await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })
    expect(retriedDownload, JSON.stringify(retriedDownload, null, 2))
      .toMatchObject({ success: true, action: 'downloaded' })
    expect(deviceADatabase.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'prompt-main', title: 'Rollback remote prompt from B' })
    ]))
    expect(deviceADatabase.data.promptVariables).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'var-main', defaultValue: 'remote value' })
    ]))
    expect(deviceADatabase.data.promptHistories).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'history-main' }),
      expect.objectContaining({ uuid: 'history-remote-v2', promptUuid: 'prompt-main' })
    ]))
    expect(deviceADatabase.data.settings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'theme', value: 'remote-light' })
    ]))
  })

  it('自动同步遇到临时服务端错误后会自动重试并成功上传', async () => {
    const storageId = 'robust-auto-retry-after-server-error'
    let firstRead = true
    const client = createWebDAVSyncClient(storageId, {
      getCloudSyncManifest: async () => {
        if (firstRead) {
          firstRead = false
          throw new Error('HTTP 503 simulated transient manifest read failure')
        }

        return createWebDAVSyncClient(storageId).getCloudSyncManifest(storageId)
      }
    })
    const database = new MutableSyncDatabase(createDataSet({
      promptTitle: 'Auto retry prompt',
      settingValue: 'auto'
    }))
    const storage = new MemoryStorage()
    const service = createSyncService(client, database, storage, 'device-auto-retry')

    service.startAutoSync({
      enabled: true,
      storageIds: [storageId],
      debounceMs: 0,
      retryMs: 10,
      pollIntervalMs: 0,
      startupDelayMs: 0,
      syncOnStart: false
    })

    try {
      service.scheduleSync('local-change', { storageId, delayMs: 0 })

      await waitForCondition(() => {
        const status = service.getStatus()
        return status.status === 'error' &&
          status.pending &&
          status.failureCount === 1 &&
          status.error?.includes('HTTP 503')
      })

      await waitForCondition(() => {
        const status = service.getStatus()
        return status.status === 'success' &&
          !status.pending &&
          status.lastResult?.success === true &&
          status.lastResult.action === 'uploaded'
      })

      const manifest = await createWebDAVSyncClient(storageId).getCloudSyncManifest(storageId)
      expect(manifest.latestSnapshot?.deviceId).toBe('device-auto-retry')
      expect(manifest.latestSnapshot?.data.prompts).toEqual(expect.arrayContaining([
        expect.objectContaining({ uuid: 'prompt-main', title: 'Auto retry prompt' })
      ]))
      expect(service.getStatus().failureCount).toBe(0)
      expect(service.getStatus().error).toBeUndefined()
    } finally {
      service.stopAutoSync()
    }
  })

  it('远端快照文件局部损坏时仍能使用 manifest 内联快照继续同步', async () => {
    const storageId = 'robust-corrupt-snapshot-file-uses-manifest'
    const client = createWebDAVSyncClient(storageId)
    const deviceADatabase = new MutableSyncDatabase(createDataSet({
      promptTitle: 'Snapshot file corruption base'
    }))
    const deviceAStorage = new MemoryStorage()
    const deviceA = createSyncService(client, deviceADatabase, deviceAStorage, 'device-a')

    const initial = await deviceA.syncNow(storageId, {
      deviceName: 'Laptop A',
      platform: 'electron',
      reason: 'manual'
    })
    expect(initial).toMatchObject({ success: true, action: 'uploaded' })

    const manifestBeforeCorruption = await client.getCloudSyncManifest(storageId)
    expect(manifestBeforeCorruption.latestSnapshot?.revision).toBe(initial.remoteRevision)
    await corruptRemoteFile(storageId, getCloudSyncSnapshotPath(initial.remoteRevision!), '{"kind":')

    const deviceBDatabase = new MutableSyncDatabase(emptyDataSet())
    const deviceB = createSyncService(client, deviceBDatabase, new MemoryStorage(), 'device-b')
    const download = await deviceB.syncNow(storageId, {
      deviceName: 'Desktop B',
      platform: 'electron',
      reason: 'manual'
    })
    expect(download, JSON.stringify(download, null, 2))
      .toMatchObject({ success: true, action: 'downloaded' })
    expect(deviceBDatabase.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'prompt-main', title: 'Snapshot file corruption base' })
    ]))

    deviceBDatabase.data = mutateDataSet(deviceBDatabase.data, data => {
      data.prompts![0].title = 'Snapshot file corruption recovered'
      data.prompts![0].updatedAt = '2026-06-13T13:00:00.000Z'
    })
    const uploaded = await deviceB.syncNow(storageId, {
      deviceName: 'Desktop B',
      platform: 'electron',
      reason: 'manual'
    })
    expect(uploaded, JSON.stringify(uploaded, null, 2))
      .toMatchObject({ success: true, action: 'uploaded' })

    const manifest = await client.getCloudSyncManifest(storageId)
    expect(manifest.latestSnapshot?.revision).toBe(uploaded.remoteRevision)
    expect(manifest.latestSnapshot?.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ uuid: 'prompt-main', title: 'Snapshot file corruption recovered' })
    ]))
    expect(manifest.latestSnapshot?.dataChecksum)
      .toBe(createCloudSyncDataChecksum(manifest.latestSnapshot!.data))
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

function createRealisticDataSet(): CloudSyncDataSet {
  return {
    categories: [{
      id: 11,
      uuid: 'real-category-product',
      name: '真实项目资料',
      isActive: true,
      sortOrder: 1,
      createdAt: '2026-06-13T13:00:00.000Z',
      updatedAt: '2026-06-13T13:00:00.000Z'
    }],
    prompts: [{
      id: 31,
      uuid: 'real-prompt-launch',
      title: '发布计划提示词',
      content: '请用 {{tone}} 语气生成发布计划',
      categoryId: 11,
      categoryUuid: 'real-category-product',
      tags: ['release', 'webdav', 'initial'],
      isFavorite: true,
      useCount: 3,
      isActive: true,
      imageBlobs: [INITIAL_IMAGE],
      createdAt: '2026-06-13T13:00:00.000Z',
      updatedAt: '2026-06-13T13:00:00.000Z'
    }],
    promptVariables: [{
      id: 41,
      uuid: 'real-variable-tone',
      promptId: 31,
      promptUuid: 'real-prompt-launch',
      name: 'tone',
      type: 'select',
      defaultValue: 'friendly',
      options: ['friendly', 'precise'],
      required: true,
      sortOrder: 1,
      createdAt: '2026-06-13T13:00:00.000Z',
      updatedAt: '2026-06-13T13:00:00.000Z'
    }],
    promptHistories: [{
      id: 41,
      uuid: 'real-history-initial',
      promptId: 31,
      promptUuid: 'real-prompt-launch',
      title: '发布计划提示词',
      content: '第一次生成发布计划',
      result: 'Initial launch plan',
      version: 1,
      imageBlobs: [INITIAL_IMAGE],
      createdAt: '2026-06-13T13:01:00.000Z',
      updatedAt: '2026-06-13T13:01:00.000Z'
    }],
    aiConfigs: [{
      id: 51,
      uuid: 'ai-config-openai-real',
      name: 'OpenAI Real',
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: 'https://api.openai.com/v1',
      isDefault: true,
      enabled: true,
      createdAt: '2026-06-13T13:00:00.000Z',
      updatedAt: '2026-06-13T13:00:00.000Z'
    }],
    quickOptimizationConfigs: [{
      id: 61,
      uuid: 'quick-real-cleanup',
      name: '更清晰',
      description: '优化表达',
      prompt: '请优化：{{content}}',
      enabled: true,
      sortOrder: 1,
      createdAt: '2026-06-13T13:00:00.000Z',
      updatedAt: '2026-06-13T13:00:00.000Z'
    }],
    aiHistory: [{
      id: 71,
      uuid: 'real-ai-history-initial',
      promptUuid: 'real-prompt-launch',
      input: '生成发布计划',
      output: '初始发布计划结果',
      provider: 'openai',
      model: 'gpt-4.1',
      createdAt: '2026-06-13T13:02:00.000Z',
      updatedAt: '2026-06-13T13:02:00.000Z'
    }],
    settings: [{
      key: 'theme',
      value: 'dark',
      type: 'string',
      updatedAt: '2026-06-13T13:00:00.000Z'
    }],
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

function createTombstone(collectionName: string, uuid: string, deletedAt: string) {
  return {
    storeName: collectionName,
    collectionName,
    recordKey: `uuid:${uuid}`,
    recordUuid: uuid,
    deletedAt,
    recordSnapshot: { uuid }
  }
}

function regenerateLocalNumericIds(data: CloudSyncDataSet, offset: number): CloudSyncDataSet {
  const nextData = cloneData(data)
  const categoryIdByUuid = new Map<string, number>()
  const promptIdByUuid = new Map<string, number>()

  nextData.categories = (nextData.categories || []).map(category => {
    const nextId = Number(category.id || 0) + offset
    categoryIdByUuid.set(category.uuid, nextId)
    return { ...category, id: nextId }
  })

  nextData.prompts = (nextData.prompts || []).map(prompt => {
    const nextId = Number(prompt.id || 0) + offset
    promptIdByUuid.set(prompt.uuid, nextId)
    return {
      ...prompt,
      id: nextId,
      categoryId: prompt.categoryUuid
        ? categoryIdByUuid.get(prompt.categoryUuid)
        : Number(prompt.categoryId || 0) + offset
    }
  })

  nextData.promptVariables = (nextData.promptVariables || []).map(variable => ({
    ...variable,
    id: Number(variable.id || 0) + offset,
    promptId: variable.promptUuid
      ? promptIdByUuid.get(variable.promptUuid)
      : Number(variable.promptId || 0) + offset
  }))

  nextData.promptHistories = (nextData.promptHistories || []).map(history => ({
    ...history,
    id: Number(history.id || 0) + offset,
    promptId: history.promptUuid
      ? promptIdByUuid.get(history.promptUuid)
      : Number(history.promptId || 0) + offset,
    categoryId: history.categoryUuid
      ? categoryIdByUuid.get(history.categoryUuid)
      : history.categoryId
  }))

  nextData.settings = (nextData.settings || []).map(setting => ({
    ...setting,
    id: setting.id === undefined ? undefined : Number(setting.id || 0) + offset
  }))

  return nextData
}

function cloneData<T>(data: T): T {
  return JSON.parse(JSON.stringify(data))
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000,
  intervalMs = 10
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error('Timed out waiting for condition')
}

async function corruptRemoteFile(storageId: string, cloudPath: string, content: string): Promise<void> {
  const provider = new WebDAVProvider({
    id: `${storageId}-corruptor`,
    name: `WebDAV corruptor ${storageId}`,
    type: 'webdav',
    enabled: true,
    url: `${server.baseUrl}/${storageId}`,
    username: USERNAME,
    password: PASSWORD,
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z'
  })
  await provider.writeFile(cloudPath, Buffer.from(content, 'utf-8'))
}
