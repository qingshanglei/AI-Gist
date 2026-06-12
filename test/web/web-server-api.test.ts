/**
 * @vitest-environment node
 */

import http from 'http'
import fsp from 'fs/promises'
import path from 'path'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { TestWebDAVServer } from '../helpers/webdav-server'
import {
  createCloudSyncDataChecksum,
  createCloudSyncSnapshot,
  type CloudSyncDataSet
} from '@shared/cloud-sync-engine'
import { getCloudSyncSnapshotPath } from '@shared/cloud-backup-paths'

const webServerModule = await import('../../scripts/web-server.js')
const createWebRequestHandler = (
  webServerModule.createWebRequestHandler ||
  webServerModule.default.createWebRequestHandler
) as typeof webServerModule.createWebRequestHandler

describe('web server API handler', () => {
  let server: http.Server | null = null
  let webdavServer: TestWebDAVServer | null = null

  afterEach(async () => {
    if (!server) {
      if (webdavServer) {
        await webdavServer.stop()
        webdavServer = null
      }
      return
    }

    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = null
    if (webdavServer) {
      await webdavServer.stop()
      webdavServer = null
    }
  })

  it('serves WebDAV proxy capabilities through the reusable Vite middleware handler', async () => {
    server = http.createServer(createWebRequestHandler({ serveStaticFiles: false }))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as AddressInfo

    const response = await fetch(`http://127.0.0.1:${address.port}/api/capabilities`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: '{}'
    })
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      success: true,
      data: {
        webBackend: true,
        webdavProxy: true
      }
    })
  })

  it('proxies the full WebDAV cloud sync manifest and snapshot API without 404s', async () => {
    webdavServer = new TestWebDAVServer({
      port: 18768,
      username: 'testuser',
      password: 'testpass'
    })
    await webdavServer.start()
    server = http.createServer(createWebRequestHandler({ serveStaticFiles: false }))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as AddressInfo
    const apiBaseUrl = `http://127.0.0.1:${address.port}`
    const config = {
      id: 'web-proxy-sync-e2e',
      name: 'Web Proxy WebDAV',
      type: 'webdav',
      url: `${webdavServer.baseUrl}/web-proxy-sync-e2e`,
      username: 'testuser',
      password: 'testpass',
      createdAt: '2026-06-13T20:00:00.000Z',
      updatedAt: '2026-06-13T20:00:00.000Z'
    }
    const data = createWebSyncDataSet()
    const snapshot = createCloudSyncSnapshot(data, 'web-device-a', 'web-proxy-rev-1')
    const manifest = {
      kind: 'ai-gist-cloud-sync-manifest',
      schemaVersion: 1,
      updatedAt: '2026-06-13T20:01:00.000Z',
      latestSnapshot: snapshot,
      baseSnapshot: snapshot,
      devices: {
        'web-device-a': {
          deviceId: 'web-device-a',
          deviceName: 'Web Browser A',
          platform: 'web',
          lastSyncAt: '2026-06-13T20:01:00.000Z',
          lastKnownRevision: snapshot.revision
        }
      },
      conflicts: []
    }

    const emptyManifest = await postApi(apiBaseUrl, '/api/cloud/webdav/get-sync-manifest', { config })
    expect(emptyManifest.status).toBe(200)
    expect(emptyManifest.payload).toMatchObject({
      success: true,
      data: {
        kind: 'ai-gist-cloud-sync-manifest',
        schemaVersion: 1
      }
    })
    expect(emptyManifest.payload.data.latestSnapshot).toBeUndefined()

    const savedSnapshot = await postApi(apiBaseUrl, '/api/cloud/webdav/save-sync-snapshot', {
      config,
      snapshot
    })
    expect(savedSnapshot.status).toBe(200)
    expect(savedSnapshot.payload).toMatchObject({ success: true, data: { ok: true } })

    const listedSnapshots = await postApi(apiBaseUrl, '/api/cloud/webdav/list-sync-snapshots', { config })
    expect(listedSnapshots.status).toBe(200)
    expect(listedSnapshots.payload.data).toEqual([expect.objectContaining({
      revision: snapshot.revision,
      path: getCloudSyncSnapshotPath(snapshot.revision)
    })])

    const loadedSnapshot = await postApi(apiBaseUrl, '/api/cloud/webdav/read-sync-snapshot', {
      config,
      snapshot: snapshot.revision
    })
    expect(loadedSnapshot.status).toBe(200)
    expect(loadedSnapshot.payload.data).toMatchObject({
      revision: snapshot.revision,
      dataChecksum: createCloudSyncDataChecksum(data)
    })
    expect(loadedSnapshot.payload.data.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'web-prompt-main',
        title: 'Web 端代理同步提示词',
        imageBlobs: [WEB_IMAGE]
      })
    ]))
    expect(loadedSnapshot.payload.data.data.promptHistories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'web-history-main',
        promptUuid: 'web-prompt-main',
        imageBlobs: [WEB_IMAGE]
      })
    ]))

    const savedManifest = await postApi(apiBaseUrl, '/api/cloud/webdav/save-sync-manifest', {
      config,
      manifest,
      options: { expectedRevision: null }
    })
    expect(savedManifest.status).toBe(200)
    expect(savedManifest.payload).toMatchObject({ success: true, data: { ok: true } })

    const loadedManifest = await postApi(apiBaseUrl, '/api/cloud/webdav/get-sync-manifest', { config })
    expect(loadedManifest.status).toBe(200)
    expect(loadedManifest.payload.data.latestSnapshot).toMatchObject({
      revision: snapshot.revision,
      dataChecksum: createCloudSyncDataChecksum(data)
    })
    expect(loadedManifest.payload.data.latestSnapshot.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'web-prompt-main',
        imageBlobs: [WEB_IMAGE]
      })
    ]))
    expect(loadedManifest.payload.data.latestSnapshot.data.promptHistories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uuid: 'web-history-main',
        imageBlobs: [WEB_IMAGE]
      })
    ]))

    const manifestFile = JSON.parse(await fsp.readFile(
      path.join(webdavServer.rootDir, 'web-proxy-sync-e2e', 'AI-Gist-Backup', 'sync-manifest.json'),
      'utf-8'
    ))
    const backupManifestFile = JSON.parse(await fsp.readFile(
      path.join(webdavServer.rootDir, 'web-proxy-sync-e2e', 'AI-Gist-Backup', 'sync-manifest.backup.json'),
      'utf-8'
    ))
    const snapshotFile = JSON.parse(await fsp.readFile(
      path.join(webdavServer.rootDir, 'web-proxy-sync-e2e', getCloudSyncSnapshotPath(snapshot.revision)),
      'utf-8'
    ))
    expect(manifestFile.latestSnapshot.revision).toBe(snapshot.revision)
    expect(backupManifestFile.latestSnapshot.revision).toBe(snapshot.revision)
    expect(snapshotFile.kind).toBe('ai-gist-cloud-sync-snapshot')
    expect(snapshotFile.snapshot.data.prompts[0].imageBlobs).toEqual([WEB_IMAGE])
  })
})

const WEB_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADUlEQVR42mP8z8BQDwAFgwJ/lZ2nNwAAAABJRU5ErkJggg=='

async function postApi(apiBaseUrl: string, pathname: string, body: unknown) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  return {
    status: response.status,
    payload: await response.json()
  }
}

function createWebSyncDataSet(): CloudSyncDataSet {
  return {
    categories: [{
      id: 1,
      uuid: 'web-category-main',
      name: 'Web 端代理同步分类',
      isActive: true,
      sortOrder: 1,
      createdAt: '2026-06-13T20:00:00.000Z',
      updatedAt: '2026-06-13T20:00:00.000Z'
    }],
    prompts: [{
      id: 10,
      uuid: 'web-prompt-main',
      title: 'Web 端代理同步提示词',
      content: '请用 {{topic}} 生成网页端同步验证内容',
      categoryId: 1,
      categoryUuid: 'web-category-main',
      tags: ['web', 'webdav', 'proxy'],
      isFavorite: true,
      useCount: 2,
      isActive: true,
      imageBlobs: [WEB_IMAGE],
      createdAt: '2026-06-13T20:00:00.000Z',
      updatedAt: '2026-06-13T20:00:00.000Z'
    }],
    promptVariables: [{
      id: 20,
      uuid: 'web-variable-topic',
      promptId: 10,
      promptUuid: 'web-prompt-main',
      name: 'topic',
      type: 'text',
      defaultValue: 'cloud sync',
      required: true,
      sortOrder: 1,
      createdAt: '2026-06-13T20:00:00.000Z',
      updatedAt: '2026-06-13T20:00:00.000Z'
    }],
    promptHistories: [{
      id: 30,
      uuid: 'web-history-main',
      promptId: 10,
      promptUuid: 'web-prompt-main',
      title: 'Web 端代理同步提示词',
      content: '网页端第一次同步历史',
      result: 'Web proxy generated result',
      version: 1,
      imageBlobs: [WEB_IMAGE],
      createdAt: '2026-06-13T20:01:00.000Z',
      updatedAt: '2026-06-13T20:01:00.000Z'
    }],
    aiConfigs: [],
    quickOptimizationConfigs: [],
    aiHistory: [{
      id: 40,
      uuid: 'web-ai-history-main',
      promptUuid: 'web-prompt-main',
      input: '网页端生成',
      output: '网页端代理同步结果',
      provider: 'openai',
      model: 'gpt-4.1',
      createdAt: '2026-06-13T20:02:00.000Z',
      updatedAt: '2026-06-13T20:02:00.000Z'
    }],
    settings: [{
      key: 'theme',
      value: 'dark',
      type: 'string',
      updatedAt: '2026-06-13T20:00:00.000Z'
    }],
    syncTombstones: []
  }
}
