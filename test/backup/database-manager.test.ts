/**
 * DatabaseServiceManager 备份/恢复测试
 * 覆盖：本地备份恢复、桌面备份数据结构、图片序列化
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { testDataGenerators } from '../helpers/test-utils'
import { createBackupPayload } from '../../src/shared/backup-integrity'

// ---- mock 所有外部依赖 ----

vi.mock('~/lib/utils/uuid', () => ({ generateUUID: () => 'mock-uuid-1234' }))

// mock 各子服务
const mockCategoryService = {
  getInstance: vi.fn(),
  initialize: vi.fn().mockResolvedValue(undefined),
  waitForInitialization: vi.fn().mockResolvedValue(undefined),
  getBasicCategories: vi.fn(),
  getSyncTombstones: vi.fn(),
  createCategory: vi.fn(),
  checkObjectStoreExists: vi.fn().mockResolvedValue(true),
  repairDatabase: vi.fn().mockResolvedValue({ success: true }),
  close: vi.fn(),
  upsertCategory: vi.fn(),
  // mock db 对象，供 forceCleanAllTables 使用
  db: {
    objectStoreNames: { contains: vi.fn().mockReturnValue(false) },
    transaction: vi.fn(),
    version: 1,
  },
}
const mockPromptService = {
  getInstance: vi.fn(),
  getAllPromptsForTags: vi.fn(),
  getAllPromptVariables: vi.fn(),
  getAllPromptHistories: vi.fn(),
  createPrompt: vi.fn(),
  createPromptVariableFromBackup: vi.fn(),
  createPromptHistoryFromBackup: vi.fn(),
  upsertPrompt: vi.fn(),
}
const mockAIConfigService = {
  getInstance: vi.fn(),
  getAllAIConfigs: vi.fn(),
  createAIConfig: vi.fn(),
  upsertAIConfig: vi.fn(),
}
const mockAIHistoryService = {
  getInstance: vi.fn(),
  getAllAIGenerationHistory: vi.fn(),
  createAIGenerationHistory: vi.fn(),
}
const mockAppSettingsService = {
  getInstance: vi.fn(),
  getAllSettings: vi.fn(),
  updateSettingByKey: vi.fn(),
  getSettingByKey: vi.fn().mockResolvedValue(null),
}
const mockQuickOptService = {
  getInstance: vi.fn(),
  getAllQuickOptimizationConfigs: vi.fn(),
  createQuickOptimizationConfigFromBackup: vi.fn(),
}

vi.mock('~/lib/services/category.service', () => ({
  CategoryService: { getInstance: () => mockCategoryService }
}))
vi.mock('~/lib/services/prompt.service', () => ({
  PromptService: { getInstance: () => mockPromptService }
}))
vi.mock('~/lib/services/ai-config.service', () => ({
  AIConfigService: { getInstance: () => mockAIConfigService }
}))
vi.mock('~/lib/services/ai-generation-history.service', () => ({
  AIGenerationHistoryService: { getInstance: () => mockAIHistoryService }
}))
vi.mock('~/lib/services/app-settings.service', () => ({
  AppSettingsService: { getInstance: () => mockAppSettingsService }
}))
vi.mock('~/lib/services/quick-optimization.service', () => ({
  QuickOptimizationService: { getInstance: () => mockQuickOptService }
}))

// mock FileReader for blobToBase64
global.FileReader = class {
  result: any = null
  onload: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
  readAsDataURL(blob: Blob) {
    setTimeout(() => {
      this.result = 'data:image/png;base64,mockbase64data'
      this.onload?.({ target: this })
    }, 0)
  }
} as any

// mock fetch for base64ToBlob
global.fetch = vi.fn().mockResolvedValue({
  blob: () => Promise.resolve(new Blob(['mock'], { type: 'image/png' }))
}) as any

import { DatabaseServiceManager } from '~/lib/services/database-manager.service'

// 测试数据
const mockCategory = testDataGenerators.createMockCategory({ id: 1, name: '分类A' })
const mockPrompt = testDataGenerators.createMockPrompt({ id: 1, categoryId: 1, title: '提示词A' })
const mockPromptVariable = {
  id: 1,
  uuid: 'variable-1',
  promptId: 1,
  name: 'tone',
  type: 'text' as const,
  defaultValue: 'friendly',
  required: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
const mockPromptHistory = {
  id: 1,
  uuid: 'history-1',
  promptId: 1,
  title: '提示词A v1',
  content: '历史内容',
  version: 1,
  createdAt: new Date().toISOString(),
}
const mockAIConfig = testDataGenerators.createMockAIConfig({ id: 1 })
const mockQuickOptimizationConfig = {
  id: 1,
  uuid: 'quick-opt-1',
  name: '更清晰',
  description: '优化表达',
  prompt: '请优化：{{content}}',
  enabled: true,
  sortOrder: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
const mockSetting = { key: 'theme', value: 'dark', type: 'string', description: '' }
const mockSyncTombstone = {
  id: 1,
  storeName: 'prompts',
  collectionName: 'prompts',
  recordKey: 'uuid:prompt-1',
  recordUuid: 'prompt-1',
  deletedAt: new Date().toISOString(),
}

function makeExportData() {
  return {
    categories: [mockCategory],
    prompts: [mockPrompt],
    promptVariables: [mockPromptVariable],
    promptHistories: [mockPromptHistory],
    aiConfigs: [mockAIConfig],
    quickOptimizationConfigs: [mockQuickOptimizationConfig],
    aiHistory: [],
    settings: [mockSetting],
  }
}

describe('DatabaseServiceManager', () => {
  let manager: DatabaseServiceManager

  beforeEach(() => {
    // 重置单例
    ;(DatabaseServiceManager as any).instance = undefined
    manager = DatabaseServiceManager.getInstance()

    // clearMocks 会清除 mockReturnValue，需要在每个 beforeEach 重新设置
    mockCategoryService.checkObjectStoreExists.mockResolvedValue(true)
    mockCategoryService.repairDatabase.mockResolvedValue({ success: true })
    mockCategoryService.waitForInitialization.mockResolvedValue(undefined)
    mockCategoryService.initialize.mockResolvedValue(undefined)

    // 重设 fetch mock（clearMocks 会清除）
    global.fetch = vi.fn().mockResolvedValue({
      blob: () => Promise.resolve(new Blob(['mock'], { type: 'image/png' }))
    }) as any

    mockCategoryService.getBasicCategories.mockResolvedValue([mockCategory])
    mockCategoryService.getSyncTombstones.mockResolvedValue([mockSyncTombstone])
    mockPromptService.getAllPromptsForTags.mockResolvedValue([mockPrompt])
    mockPromptService.getAllPromptVariables.mockResolvedValue([mockPromptVariable])
    mockPromptService.getAllPromptHistories.mockResolvedValue([mockPromptHistory])
    mockAIConfigService.getAllAIConfigs.mockResolvedValue([mockAIConfig])
    mockQuickOptService.getAllQuickOptimizationConfigs.mockResolvedValue([mockQuickOptimizationConfig])
    mockAIHistoryService.getAllAIGenerationHistory.mockResolvedValue([])
    mockAppSettingsService.getAllSettings.mockResolvedValue([mockSetting])

    mockCategoryService.createCategory.mockResolvedValue({ ...mockCategory, id: 10 })
    mockPromptService.createPrompt.mockResolvedValue({ ...mockPrompt, id: 20 })
    mockPromptService.createPromptVariableFromBackup.mockResolvedValue({ ...mockPromptVariable, id: 30, promptId: 20 })
    mockPromptService.createPromptHistoryFromBackup.mockResolvedValue({ ...mockPromptHistory, id: 40, promptId: 20 })
    mockAIConfigService.createAIConfig.mockResolvedValue({ ...mockAIConfig, id: 30 })
    mockQuickOptService.createQuickOptimizationConfigFromBackup.mockResolvedValue({ ...mockQuickOptimizationConfig, id: 50 })
    mockAIHistoryService.createAIGenerationHistory.mockResolvedValue({})
    mockAppSettingsService.updateSettingByKey.mockResolvedValue({})
  })

  // ---- exportAllData ----

  describe('exportAllData', () => {
    it('导出所有数据，返回正确结构', async () => {
      const result = await manager.exportAllData()

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data!.categories).toHaveLength(1)
      expect(result.data!.prompts).toHaveLength(1)
      expect(result.data!.promptVariables).toHaveLength(1)
      expect(result.data!.promptHistories).toHaveLength(1)
      expect(result.data!.aiConfigs).toHaveLength(1)
      expect(result.data!.quickOptimizationConfigs).toHaveLength(1)
      expect(result.data!.settings).toHaveLength(1)
    })

    it('任一子服务失败时不生成部分数据导出', async () => {
      mockAIConfigService.getAllAIConfigs.mockRejectedValue(new Error('DB error'))

      const result = await manager.exportAllData()

      expect(result.success).toBe(false)
      expect(result.error).toContain('读取数据表失败: aiConfigs')
      expect(result.data).toBeUndefined()
    })
  })

  // ---- exportAllDataForBackup（图片序列化）----

  describe('exportAllDataForBackup', () => {
    it('prompt 有 imageBlobs 时序列化为 base64', async () => {
      const blob = new Blob(['img'], { type: 'image/png' })
      mockPromptService.getAllPromptsForTags.mockResolvedValue([
        { ...mockPrompt, imageBlobs: [blob] }
      ])

      const result = await manager.exportAllDataForBackup()

      expect(result.success).toBe(true)
      const serializedPrompt = result.data!.prompts[0]
      expect(serializedPrompt.imageBlobs[0]).toMatch(/^data:/)
    })

    it('prompt 没有 imageBlobs 时正常导出', async () => {
      const result = await manager.exportAllDataForBackup()

      expect(result.success).toBe(true)
      expect(result.data!.prompts[0].imageBlobs).toBeUndefined()
    })

    it('已序列化的 data URL 图片不会在再次备份时丢失', async () => {
      const dataUrl = 'data:image/png;base64,existingbase64'
      mockPromptService.getAllPromptsForTags.mockResolvedValue([
        { ...mockPrompt, imageBlobs: [dataUrl] }
      ])
      mockPromptService.getAllPromptHistories.mockResolvedValue([
        { ...mockPromptHistory, imageBlobs: [dataUrl] }
      ])

      const result = await manager.exportAllDataForBackup()

      expect(result.success).toBe(true)
      expect(result.data!.prompts[0].imageBlobs).toEqual([dataUrl])
      expect(result.data!.promptHistories![0].imageBlobs).toEqual([dataUrl])
    })

    it('遇到无法序列化的图片数据时不生成部分缺图备份', async () => {
      mockPromptService.getAllPromptsForTags.mockResolvedValue([
        { ...mockPrompt, imageBlobs: [{ invalid: true }] }
      ])

      const result = await manager.exportAllDataForBackup()

      expect(result.success).toBe(false)
      expect(result.error).toContain('图片数据格式无效')
    })

    it('backupData 使用备份专用图片序列化', async () => {
      const blob = new Blob(['img'], { type: 'image/png' })
      mockPromptService.getAllPromptsForTags.mockResolvedValue([
        { ...mockPrompt, imageBlobs: [blob] }
      ])

      const result = await manager.backupData()

      expect(result.success).toBe(true)
      expect(result.data!.prompts[0].imageBlobs[0]).toMatch(/^data:/)
    })
  })

  describe('exportAllDataForSync', () => {
    it('同步导出包含删除标记', async () => {
      const result = await manager.exportAllDataForSync()

      expect(result.success).toBe(true)
      expect(result.data!.syncTombstones).toEqual([mockSyncTombstone])
    })

    it('删除标记读取失败时不生成缺删除标记快照', async () => {
      mockCategoryService.getSyncTombstones.mockRejectedValue(new Error('tombstone store failed'))

      const result = await manager.exportAllDataForSync()

      expect(result.success).toBe(false)
      expect(result.error).toContain('读取同步删除标记失败')
      expect(result.data).toBeUndefined()
    })
  })

  // ---- importData ----

  describe('importData', () => {
    it('导入完整数据，所有记录被创建', async () => {
      const result = await manager.importData(makeExportData())

      expect(result.success).toBe(true)
      expect(mockCategoryService.createCategory).toHaveBeenCalledTimes(1)
      expect(mockPromptService.createPrompt).toHaveBeenCalledTimes(1)
      expect(mockPromptService.createPromptVariableFromBackup).toHaveBeenCalledTimes(1)
      expect(mockPromptService.createPromptHistoryFromBackup).toHaveBeenCalledTimes(1)
      expect(mockAIConfigService.createAIConfig).toHaveBeenCalledTimes(1)
      expect(mockQuickOptService.createQuickOptimizationConfigFromBackup).toHaveBeenCalledTimes(1)
      expect(mockAppSettingsService.updateSettingByKey).toHaveBeenCalledTimes(1)
    })

    it('分类 ID 映射正确传递给提示词', async () => {
      const result = await manager.importData(makeExportData())

      expect(result.success).toBe(true)
      // createPrompt 被调用时，categoryId 应该是新 ID (10)，而不是旧 ID (1)
      const promptArg = mockPromptService.createPrompt.mock.calls[0][0]
      expect(promptArg.categoryId).toBe(10)
      const variableArg = mockPromptService.createPromptVariableFromBackup.mock.calls[0][0]
      expect(variableArg.promptId).toBe(20)
      const historyArg = mockPromptService.createPromptHistoryFromBackup.mock.calls[0][0]
      expect(historyArg.promptId).toBe(20)
    })

    it('数据格式无效时返回失败', async () => {
      const result = await manager.importData(null)
      expect(result.success).toBe(false)
    })

    it('base64 imageBlobs 被反序列化为 Blob', async () => {
      const dataWithBase64 = {
        ...makeExportData(),
        prompts: [{ ...mockPrompt, imageBlobs: ['data:image/png;base64,abc123'] }]
      }

      const result = await manager.importData(dataWithBase64)
      expect(result.success).toBe(true)

      expect(mockPromptService.createPrompt).toHaveBeenCalledTimes(1)
      const promptArg = mockPromptService.createPrompt.mock.calls[0][0]
      expect(promptArg.imageBlobs[0]).toBeInstanceOf(Blob)
    })

    it('base64 promptHistories.imageBlobs 被反序列化为 Blob', async () => {
      const dataWithBase64History = {
        ...makeExportData(),
        promptHistories: [{ ...mockPromptHistory, imageBlobs: ['data:image/png;base64,abc123'] }]
      }

      const result = await manager.importData(dataWithBase64History)
      expect(result.success).toBe(true)

      const historyArg = mockPromptService.createPromptHistoryFromBackup.mock.calls[0][0]
      expect(historyArg.imageBlobs[0]).toBeInstanceOf(Blob)
    })
  })

  // ---- replaceAllData ----

  describe('replaceAllData', () => {
    it('先清空再恢复数据', async () => {
      // mock forceCleanAllTables
      const cleanSpy = vi.spyOn(manager, 'forceCleanAllTables').mockResolvedValue()

      const result = await manager.replaceAllData(makeExportData())

      expect(cleanSpy).toHaveBeenCalledTimes(1)
      expect(result.success).toBe(true)
    })

    it('恢复同步删除标记，避免删除记录在下次同步复活', async () => {
      const restoredTombstones: any[] = []
      const cleanSpy = vi.spyOn(manager, 'forceCleanAllTables').mockResolvedValue()
      mockCategoryService.db = createMockDbWithSyncTombstones(restoredTombstones)

      const result = await manager.replaceAllData({
        ...makeExportData(),
        syncTombstones: [mockSyncTombstone]
      })

      expect(cleanSpy).toHaveBeenCalledTimes(1)
      expect(result.success).toBe(true)
      expect(result.details?.syncTombstones).toBe(1)
      expect(restoredTombstones).toHaveLength(1)
      expect(restoredTombstones[0]).toMatchObject({
        collectionName: 'prompts',
        recordKey: 'uuid:prompt-1',
        recordUuid: 'prompt-1'
      })
      expect(restoredTombstones[0].id).toBeUndefined()
      expect(restoredTombstones[0].deletedAt).toBeInstanceOf(Date)
    })

    it('任一记录恢复失败时返回失败，避免同步状态误标为成功', async () => {
      vi.spyOn(manager, 'forceCleanAllTables').mockResolvedValue()
      mockAppSettingsService.updateSettingByKey.mockRejectedValueOnce(new Error('settings write failed'))

      const result = await manager.replaceAllData(makeExportData())

      expect(result.success).toBe(false)
      expect(result.totalErrors).toBe(1)
      expect(result.error).toContain('恢复过程中有 1 条记录失败')
    })

    it('备份校验失败时不会先清空本地数据', async () => {
      const data = {
        ...makeExportData(),
        prompts: [...makeExportData().prompts]
      }
      const payload = createBackupPayload({
        id: 'bad-backup',
        name: 'bad-backup',
        createdAt: '2026-06-12T00:00:00.000Z',
        data
      })
      payload.data.prompts.push({ ...mockPrompt, id: 2, title: '损坏数据' })
      const cleanSpy = vi.spyOn(manager, 'forceCleanAllTables').mockResolvedValue()

      const result = await manager.replaceAllData(payload)

      expect(result.success).toBe(false)
      expect(result.error).toContain('备份数据校验失败')
      expect(cleanSpy).not.toHaveBeenCalled()
    })
  })
})

function createMockDbWithSyncTombstones(restoredTombstones: any[]) {
  return {
    objectStoreNames: {
      contains: vi.fn((storeName: string) => storeName === 'syncTombstones')
    },
    transaction: vi.fn(() => {
      const transaction: any = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: vi.fn(() => ({
          add: vi.fn((record: any) => {
            restoredTombstones.push(record)
            const request = createSuccessfulRequest()
            setTimeout(() => transaction.oncomplete?.(), 0)
            return request
          })
        }))
      }
      return transaction
    }),
    version: 1
  }
}

function createSuccessfulRequest() {
  const request: any = {}
  setTimeout(() => request.onsuccess?.(), 0)
  return request
}
