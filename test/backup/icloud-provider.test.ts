// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import { ICloudProvider } from '../../src/main/cloud/icloud-provider'

const mockOs = vi.hoisted(() => ({
  homeDir: ''
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<any>('os')
  return {
    ...actual,
    default: {
      ...actual.default,
      platform: () => 'darwin',
      homedir: () => mockOs.homeDir
    },
    platform: () => 'darwin',
    homedir: () => mockOs.homeDir
  }
})

describe('ICloudProvider', () => {
  let tempHome: string

  beforeEach(async () => {
    tempHome = await fsp.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'ai-gist-icloud-'))
    mockOs.homeDir = tempHome
    await fsp.mkdir(path.join(tempHome, 'Library/Mobile Documents/com~apple~CloudDocs'), { recursive: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fsp.rm(tempHome, { recursive: true, force: true })
  })

  it('writes files and verifies the bytes that were persisted locally', async () => {
    const provider = new ICloudProvider(createICloudConfig())
    const payload = Buffer.from(JSON.stringify({ ok: true }), 'utf-8')

    await provider.writeFile('sync-manifest.json', payload)

    const readBack = await provider.readFile('sync-manifest.json')
    expect(Buffer.compare(readBack, payload)).toBe(0)
  })
})

function createICloudConfig() {
  return {
    id: 'icloud-test',
    name: 'iCloud Test',
    type: 'icloud' as const,
    enabled: true,
    path: 'AI-Gist-Test',
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z'
  }
}
