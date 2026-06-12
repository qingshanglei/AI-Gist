import { describe, expect, it, vi, afterEach } from 'vitest'
import { WebCloudBackupService } from '~/lib/services/web-cloud-backup.service'

const webdavConfig = {
  id: 'web-cfg',
  name: 'WebDAV',
  type: 'webdav' as const,
  enabled: true,
  url: 'http://127.0.0.1:18766/webdav',
  username: 'user',
  password: 'pass',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

describe('WebCloudBackupService', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports a missing Web backend proxy instead of surfacing a generic 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain'
      }
    }))

    const service = WebCloudBackupService.getInstance()
    const result = await service.testStorageConnection(webdavConfig)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Web 端 WebDAV 代理未启用')
  })
})
