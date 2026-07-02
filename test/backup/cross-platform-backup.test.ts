/**
 * 跨平台备份兼容性测试
 * 覆盖：
 *   - 场景2：移动备份 → 桌面恢复（验证数据格式兼容）
 *   - 场景4：云端备份/恢复完整流程（通过 DatabaseServiceManager）
 *   - 备份文件格式一致性验证
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { testDataGenerators } from '../helpers/test-utils'
import { createBackupPayload } from '../../src/shared/backup-integrity'

// ---- mock 子服务（与 database-manager.test.ts 相同）----

vi.mock('~/lib/utils/uuid', () => ({ generateUUID: () => 'mock-uuid-5678' }))

const mockCategoryService = {
  getInstance: vi.fn(),
  initialize: vi.fn().mockResolvedValue(undefined),
  waitForInitialization: vi.fn().mockResolvedValue(undefined),
  getBasicCategories: vi.fn(),
  createCategory: vi.fn(),
  checkObjectStoreExists: vi.fn().mockResolvedValue(true),
  repairDatabase: vi.fn().mockResolvedValue({ success: true }),
  close: vi.fn(),
  upsertCategory: vi.fn(),
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

global.fetch = vi.fn().mockResolvedValue({
  blob: () => Promise.resolve(new Blob(['mock'], { type: 'image/png' }))
}) as any

import { DatabaseServiceManager } from '~/lib/services/database-manager.service'

// ---- 测试数据 ----

const mockCategory = testDataGenerators.createMockCategory({ id: 1, name: '分类A' })
const mockPrompt = testDataGenerators.createMockPrompt({ id: 1, categoryId: 1, title: '提示词A' })
const mockPromptVariable = {
  id: 1,
  uuid: 'variable-cross-1',
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
  uuid: 'history-cross-1',
  promptId: 1,
  title: '提示词A v1',
  content: '历史内容',
  version: 1,
  createdAt: new Date().toISOString(),
}
const mockAIConfig = testDataGenerators.createMockAIConfig({ id: 1 })
const mockQuickOptimizationConfig = {
  id: 1,
  uuid: 'quick-opt-cross-1',
  name: '更清晰',
  description: '优化表达',
  prompt: '请优化：{{content}}',
  enabled: true,
  sortOrder: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
const mockSetting = { key: 'theme', value: 'dark', type: 'string', description: '' }

const baseData = {
  categories: [mockCategory],
  prompts: [mockPrompt],
  promptVariables: [mockPromptVariable],
  promptHistories: [mockPromptHistory],
  aiConfigs: [mockAIConfig],
  quickOptimizationConfigs: [mockQuickOptimizationConfig],
  aiHistory: [],
  settings: [mockSetting],
}

// 移动端备份文件格式（createCloudBackup 生成的）
function makeMobileBackupFile(data = baseData) {
  const id = `mobile-${Date.now()}`
  return createBackupPayload({
    id,
    name: `backup-2026-03-12-${id.substring(0, 8)}`,
    description: '移动端云端备份',
    createdAt: new Date().toISOString(),
    data,
  })
}

// 桌面端备份文件格式（cloud-backup-manager.ts 生成的）
function makeDesktopBackupFile(data = baseData) {
  return createBackupPayload({
    id: 'desktop-backup-001',
    name: 'backup-2026-03-12-desktop0',
    description: '桌面端云端备份',
    createdAt: new Date().toISOString(),
    data,
  })
}

describe('跨平台备份兼容性', () => {
  let manager: DatabaseServiceManager
  let restoredRecords: Record<string, any[]>
  let restoredCounters: Record<string, number>

  const resetRestoredCapture = () => {
    restoredRecords = {}
    restoredCounters = {
      categories: 10,
      prompts: 20,
      promptVariables: 30,
      promptHistories: 40,
      ai_configs: 50,
      quick_optimization_configs: 60,
      ai_generation_history: 70,
      settings: 80
    }
  }

  beforeEach(() => {
    ;(DatabaseServiceManager as any).instance = undefined
    manager = DatabaseServiceManager.getInstance()
    resetRestoredCapture()

    vi.spyOn(manager as any, 'addRestoredRecord').mockImplementation(async (storeName: string, data: any) => {
      const id = restoredCounters[storeName] ?? 900
      restoredCounters[storeName] = id + 1
      const restored = { ...data, id }
      restoredRecords[storeName] = restoredRecords[storeName] || []
      restoredRecords[storeName].push(restored)
      return restored
    })

    mockCategoryService.checkObjectStoreExists.mockResolvedValue(true)
    mockCategoryService.repairDatabase.mockResolvedValue({ success: true })
    mockCategoryService.waitForInitialization.mockResolvedValue(undefined)
    mockCategoryService.initialize.mockResolvedValue(undefined)

    global.fetch = vi.fn().mockResolvedValue({
      blob: () => Promise.resolve(new Blob(['mock'], { type: 'image/png' }))
    }) as any

    mockCategoryService.getBasicCategories.mockResolvedValue([mockCategory])
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

  // ---- 场景2：移动备份 → 桌面恢复 ----

  describe('场景：移动备份 → 桌面恢复', () => {
    it('桌面端能恢复移动端备份的 data 字段', async () => {
      const mobileFile = makeMobileBackupFile()

      // 桌面端恢复时，从备份文件中取出 .data 字段传给 replaceAllData
      const result = await manager.replaceAllData(mobileFile.data)

      expect(result.success).toBe(true)
      expect(restoredRecords.categories).toHaveLength(1)
      expect(restoredRecords.prompts).toHaveLength(1)
      expect(restoredRecords.promptHistories).toHaveLength(1)
    })

    it('移动端备份包含 base64 图片时，桌面端能正确反序列化', async () => {
      const dataWithImages = {
        ...baseData,
        prompts: [{ ...mockPrompt, imageBlobs: ['data:image/png;base64,abc123'] }]
      }
      const mobileFile = makeMobileBackupFile(dataWithImages)

      const result = await manager.replaceAllData(mobileFile.data)

      expect(result.success).toBe(true)
      const promptArg = restoredRecords.prompts[0]
      expect(promptArg.imageBlobs[0]).toBeInstanceOf(Blob)
    })

    it('移动端备份的分类 ID 映射在桌面端恢复时正确处理', async () => {
      const result = await manager.replaceAllData(baseData)

      expect(result.success).toBe(true)
      // prompt 的 categoryId 应该映射到新创建的分类 ID (10)
      const promptArg = restoredRecords.prompts[0]
      expect(promptArg.categoryId).toBe(10)
      const historyArg = restoredRecords.promptHistories[0]
      expect(historyArg.promptId).toBe(20)
    })
  })

  // ---- 场景1：桌面备份 → 移动恢复（数据格式验证）----

  describe('场景：桌面备份 → 移动恢复（数据格式）', () => {
    it('桌面备份文件的 data 字段结构与移动端期望一致', () => {
      const desktopFile = makeDesktopBackupFile()

      // 移动端 restoreWebDAVBackup 返回 backupData.data
      const restoredData = desktopFile.data

      expect(restoredData).toHaveProperty('categories')
      expect(restoredData).toHaveProperty('prompts')
      expect(restoredData).toHaveProperty('promptVariables')
      expect(restoredData).toHaveProperty('promptHistories')
      expect(restoredData).toHaveProperty('aiConfigs')
      expect(restoredData).toHaveProperty('quickOptimizationConfigs')
      expect(restoredData).toHaveProperty('settings')
      expect(Array.isArray(restoredData.categories)).toBe(true)
      expect(Array.isArray(restoredData.prompts)).toBe(true)
      expect(Array.isArray(restoredData.promptVariables)).toBe(true)
    })

    it('桌面备份的 data 不含嵌套 data 字段', () => {
      const desktopFile = makeDesktopBackupFile()
      // 确保没有 { data: { data: ... } } 的双重嵌套
      expect(desktopFile.data.data).toBeUndefined()
    })

    it('移动端 replaceAllData 能处理桌面备份的 data', async () => {
      const desktopFile = makeDesktopBackupFile()

      // 模拟移动端恢复流程：result.data = backupData.data
      const result = await manager.replaceAllData(desktopFile.data)

      expect(result.success).toBe(true)
      expect(restoredRecords.categories).toHaveLength(1)
    })
  })

  // ---- 场景4：云端备份/恢复（exportAllDataForBackup + replaceAllData）----

  describe('场景：云端备份/恢复完整流程', () => {
    it('exportAllDataForBackup 生成的数据能被 replaceAllData 恢复', async () => {
      // 备份
      const exportResult = await manager.exportAllDataForBackup()
      expect(exportResult.success).toBe(true)

      resetRestoredCapture()

      // 恢复
      const restoreResult = await manager.replaceAllData(exportResult.data!)
      expect(restoreResult.success).toBe(true)
      expect(restoredRecords.categories).toHaveLength(1)
      expect(restoredRecords.prompts).toHaveLength(1)
      expect(restoredRecords.promptHistories).toHaveLength(1)
    })

    it('含图片的备份：序列化后能被反序列化恢复', async () => {
      const blob = new Blob(['img'], { type: 'image/png' })
      mockPromptService.getAllPromptsForTags.mockResolvedValue([
        { ...mockPrompt, imageBlobs: [blob] }
      ])
      mockPromptService.getAllPromptHistories.mockResolvedValue([
        { ...mockPromptHistory, imageBlobs: [blob] }
      ])

      // 备份（序列化图片）
      const exportResult = await manager.exportAllDataForBackup()
      expect(exportResult.success).toBe(true)

      const serializedPrompt = exportResult.data!.prompts[0]
      expect(typeof serializedPrompt.imageBlobs[0]).toBe('string') // base64
      const serializedHistory = exportResult.data!.promptHistories![0]
      expect(typeof serializedHistory.imageBlobs[0]).toBe('string')

      // 恢复（反序列化图片）
      resetRestoredCapture()

      const restoreResult = await manager.replaceAllData(exportResult.data!)
      expect(restoreResult.success).toBe(true)

      const promptArg = restoredRecords.prompts[0]
      expect(promptArg.imageBlobs[0]).toBeInstanceOf(Blob)
      const historyArg = restoredRecords.promptHistories[0]
      expect(historyArg.imageBlobs[0]).toBeInstanceOf(Blob)
    })

    it('多分类多提示词时 ID 映射全部正确', async () => {
      const cat1 = testDataGenerators.createMockCategory({ id: 1, name: '分类1' })
      const cat2 = testDataGenerators.createMockCategory({ id: 2, name: '分类2' })
      const p1 = testDataGenerators.createMockPrompt({ id: 1, title: '提示词1', categoryId: 1 })
      const p2 = testDataGenerators.createMockPrompt({ id: 2, title: '提示词2', categoryId: 2 })
      const p3 = testDataGenerators.createMockPrompt({ id: 3, title: '提示词3', categoryId: 1 })

      mockCategoryService.getBasicCategories.mockResolvedValue([cat1, cat2])
      mockPromptService.getAllPromptsForTags.mockResolvedValue([p1, p2, p3])
      mockPromptService.getAllPromptHistories.mockResolvedValue([])

      const exportResult = await manager.exportAllDataForBackup()

      resetRestoredCapture()

      const restoreResult = await manager.replaceAllData(exportResult.data!)
      expect(restoreResult.success).toBe(true)

      const restoredPrompts = restoredRecords.prompts
      expect(restoredPrompts).toHaveLength(3)

      // p1 和 p3 的 categoryId 应该映射到 cat1 的新 ID (10)
      // p2 的 categoryId 应该映射到 cat2 的新 ID (11)
      const p1Arg = restoredPrompts.find((prompt: any) => prompt.title === '提示词1')
      const p2Arg = restoredPrompts.find((prompt: any) => prompt.title === '提示词2')
      const p3Arg = restoredPrompts.find((prompt: any) => prompt.title === '提示词3')

      expect(p1Arg?.categoryId).toBe(10)
      expect(p2Arg?.categoryId).toBe(11)
      expect(p3Arg?.categoryId).toBe(10)
    })
  })

  // ---- 备份文件格式一致性 ----

  describe('备份文件格式一致性', () => {
    it('桌面端和移动端备份文件顶层结构相同', () => {
      const desktop = makeDesktopBackupFile()
      const mobile = makeMobileBackupFile()

      const desktopKeys = Object.keys(desktop).sort()
      const mobileKeys = Object.keys(mobile).sort()

      expect(desktopKeys).toEqual(mobileKeys)
    })

    it('备份文件的 data 字段包含所有必要的数据类型', () => {
      const file = makeDesktopBackupFile()
      const requiredKeys = ['categories', 'prompts', 'aiConfigs', 'settings']

      for (const key of requiredKeys) {
        expect(file.data).toHaveProperty(key)
        expect(Array.isArray((file.data as any)[key])).toBe(true)
      }
    })

    it('exportAllDataForBackup 生成的数据结构符合备份格式', async () => {
      const result = await manager.exportAllDataForBackup()

      expect(result.success).toBe(true)
      expect(result.data).toHaveProperty('categories')
      expect(result.data).toHaveProperty('prompts')
      expect(result.data).toHaveProperty('aiConfigs')
      expect(result.data).toHaveProperty('aiHistory')
      expect(result.data).toHaveProperty('promptHistories')
      expect(result.data).toHaveProperty('settings')
    })
  })
})
