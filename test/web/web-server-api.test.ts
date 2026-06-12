/**
 * @vitest-environment node
 */

import http from 'http'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it } from 'vitest'

const webServerModule = await import('../../scripts/web-server.js')
const createWebRequestHandler = (
  webServerModule.createWebRequestHandler ||
  webServerModule.default.createWebRequestHandler
) as typeof webServerModule.createWebRequestHandler

describe('web server API handler', () => {
  let server: http.Server | null = null

  afterEach(async () => {
    if (!server) {
      return
    }

    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = null
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
})
