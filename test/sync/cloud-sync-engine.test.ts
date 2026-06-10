import { describe, expect, it } from 'vitest'
import {
  createCloudSyncSnapshot,
  getCloudSyncRecordKey,
  mergeCloudSyncData
} from '@shared/cloud-sync-engine'

describe('cloud sync engine', () => {
  it('merges new local and remote records when there is no base snapshot', () => {
    const local = {
      categories: [
        { id: 1, uuid: 'cat-local', name: 'Local', updatedAt: '2026-01-01T00:00:00.000Z' }
      ],
      prompts: []
    }
    const remote = {
      categories: [
        { id: 9, uuid: 'cat-remote', name: 'Remote', updatedAt: '2026-01-02T00:00:00.000Z' }
      ],
      prompts: []
    }

    const result = mergeCloudSyncData(local, remote)

    expect(result.hasConflicts).toBe(false)
    expect(result.data.categories?.map(item => item.uuid).sort()).toEqual(['cat-local', 'cat-remote'])
    expect(result.summary.added).toBe(1)
  })

  it('uses uuid and business keys instead of device-local numeric ids', () => {
    const localPrompt = {
      id: 10,
      uuid: 'prompt-1',
      title: 'Prompt',
      content: 'Hello',
      categoryId: 1,
      category: { id: 1, uuid: 'cat-1', name: 'Category' },
      tags: ['b', 'a'],
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    const remotePrompt = {
      id: 99,
      uuid: 'prompt-1',
      title: 'Prompt',
      content: 'Hello',
      categoryId: 77,
      category: { id: 77, uuid: 'cat-1', name: 'Category' },
      tags: 'a,b',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }

    const result = mergeCloudSyncData({ prompts: [localPrompt] }, { prompts: [remotePrompt] })

    expect(getCloudSyncRecordKey('prompts', localPrompt)).toBe('uuid:prompt-1')
    expect(result.hasConflicts).toBe(false)
    expect(result.data.prompts).toHaveLength(1)
  })

  it('merges prompt variables as first-class metadata', () => {
    const local = {
      promptVariables: [
        { id: 1, uuid: 'variable-1', promptId: 1, name: 'tone', updatedAt: '2026-01-01T00:00:00.000Z' }
      ]
    }
    const remote = {
      promptVariables: [
        { id: 99, uuid: 'variable-1', promptId: 9, name: 'tone', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 100, uuid: 'variable-2', promptId: 9, name: 'audience', updatedAt: '2026-01-02T00:00:00.000Z' }
      ]
    }

    const result = mergeCloudSyncData(local, remote)

    expect(getCloudSyncRecordKey('promptVariables', local.promptVariables[0])).toBe('uuid:variable-1')
    expect(result.hasConflicts).toBe(false)
    expect(result.data.promptVariables?.map(item => item.uuid).sort()).toEqual(['variable-1', 'variable-2'])
  })

  it('applies remote-only changes against a shared base', () => {
    const base = {
      settings: [
        { id: 1, key: 'theme', value: 'light', updatedAt: '2026-01-01T00:00:00.000Z' }
      ]
    }
    const local = {
      settings: [
        { id: 2, key: 'theme', value: 'light', updatedAt: '2026-01-01T00:00:00.000Z' }
      ]
    }
    const remote = {
      settings: [
        { id: 3, key: 'theme', value: 'dark', updatedAt: '2026-01-02T00:00:00.000Z' }
      ]
    }

    const result = mergeCloudSyncData(local, remote, base)

    expect(result.hasConflicts).toBe(false)
    expect(result.data.settings?.[0].value).toBe('dark')
    expect(result.summary.updated).toBe(1)
  })

  it('keeps updated data instead of letting a hard delete win silently', () => {
    const base = {
      categories: [
        { id: 1, uuid: 'cat-1', name: 'Original', updatedAt: '2026-01-01T00:00:00.000Z' }
      ]
    }
    const local = {
      categories: []
    }
    const remote = {
      categories: [
        { id: 2, uuid: 'cat-1', name: 'Remote edit', updatedAt: '2026-01-02T00:00:00.000Z' }
      ]
    }

    const result = mergeCloudSyncData(local, remote, base)

    expect(result.hasConflicts).toBe(true)
    expect(result.conflicts[0]).toMatchObject({
      collection: 'categories',
      key: 'uuid:cat-1',
      reason: 'delete_vs_update',
      resolution: 'take-remote'
    })
    expect(result.data.categories?.[0].name).toBe('Remote edit')
  })

  it('detects both-modified conflicts and takes the newer record by default', () => {
    const base = {
      prompts: [
        { id: 1, uuid: 'prompt-1', title: 'Base', content: 'A', updatedAt: '2026-01-01T00:00:00.000Z' }
      ]
    }
    const local = {
      prompts: [
        { id: 2, uuid: 'prompt-1', title: 'Local', content: 'A', updatedAt: '2026-01-02T00:00:00.000Z' }
      ]
    }
    const remote = {
      prompts: [
        { id: 3, uuid: 'prompt-1', title: 'Remote', content: 'A', updatedAt: '2026-01-03T00:00:00.000Z' }
      ]
    }

    const result = mergeCloudSyncData(local, remote, base)

    expect(result.hasConflicts).toBe(true)
    expect(result.conflicts[0]).toMatchObject({
      collection: 'prompts',
      reason: 'both_modified',
      resolution: 'take-newer'
    })
    expect(result.data.prompts?.[0].title).toBe('Remote')
  })

  it('creates sync snapshots without mutating input data', () => {
    const data = {
      aiConfigs: [
        { id: 1, configId: 'openai', name: 'OpenAI', updatedAt: '2026-01-01T00:00:00.000Z' }
      ]
    }

    const snapshot = createCloudSyncSnapshot(data, 'device-a', 'rev-1')
    snapshot.data.aiConfigs![0].name = 'Changed'

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      deviceId: 'device-a',
      revision: 'rev-1'
    })
    expect(data.aiConfigs[0].name).toBe('OpenAI')
  })

  it('applies tombstones so deleted records do not come back from older remote data', () => {
    const local = {
      prompts: [],
      syncTombstones: [
        {
          collectionName: 'prompts',
          recordKey: 'uuid:prompt-1',
          recordUuid: 'prompt-1',
          deletedAt: '2026-01-03T00:00:00.000Z'
        }
      ]
    }
    const remote = {
      prompts: [
        { id: 3, uuid: 'prompt-1', title: 'Deleted remotely stale', updatedAt: '2026-01-02T00:00:00.000Z' }
      ],
      syncTombstones: []
    }

    const result = mergeCloudSyncData(local, remote)

    expect(result.data.prompts).toEqual([])
    expect(result.data.syncTombstones).toHaveLength(1)
  })

  it('does not let an older tombstone delete a newer record update', () => {
    const local = {
      prompts: [],
      syncTombstones: [
        {
          collectionName: 'prompts',
          recordKey: 'uuid:prompt-1',
          recordUuid: 'prompt-1',
          deletedAt: '2026-01-02T00:00:00.000Z'
        }
      ]
    }
    const remote = {
      prompts: [
        { id: 3, uuid: 'prompt-1', title: 'Newer remote edit', updatedAt: '2026-01-03T00:00:00.000Z' }
      ]
    }

    const result = mergeCloudSyncData(local, remote)

    expect(result.data.prompts).toHaveLength(1)
    expect(result.data.prompts?.[0].title).toBe('Newer remote edit')
  })
})
