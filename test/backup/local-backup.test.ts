/**
 * 本地备份/恢复测试（DataManagementAPI）
 * 覆盖：JSON 导出/导入、CSV 导出/导入、完整备份流程
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { testDataGenerators } from '../helpers/test-utils'
import { PlatformDetector } from '../../src/shared/platform'
import { createBackupPayload } from '../../src/shared/backup-integrity'

// DataManagementAPI 通过 window.electronAPI 和 window.databaseAPI 操作
// 直接测试其静态方法，mock window 对象

const mockExportData = {
  categories: [testDataGenerators.createMockCategory({ id: 1, name: '分类A' })],
  prompts: [testDataGenerators.createMockPrompt({ id: 1, categoryId: 1, title: '提示词A' })],
  aiConfigs: [testDataGenerators.createMockAIConfig({ id: 1 })],
  aiHistory: [],
  settings: [{ key: 'theme', value: 'dark', type: 'string', description: '' }],
}

function setupWindowMocks(overrides: Record<string, any> = {}) {
  ;(window as any).electronAPI = {
    invoke: vi.fn(async (channel: string, _args: any) => {
      if (channel === 'data:select-export-path') return '/mock/path/backup.json'
      if (channel === 'data:select-import-file') return '/mock/path/backup.json'
      if (channel === 'data:write-file') return { success: true }
      if (channel === 'data:read-file') return {
        success: true,
        content: JSON.stringify(mockExportData)
      }
      return null
    }),
    ...overrides.electronAPI,
  }

  ;(window as any).databaseAPI = {
    exportAllData: vi.fn().mockResolvedValue({ success: true, data: mockExportData }),
    exportAllDataForBackup: vi.fn().mockResolvedValue({ success: true, data: mockExportData }),
    replaceAllData: vi.fn().mockResolvedValue({ success: true, imported: { categories: 1, prompts: 1 } }),
    importData: vi.fn().mockResolvedValue({ success: true }),
    ...overrides.databaseAPI,
  }
}

import { DataManagementAPI } from '../../src/renderer/lib/api/data-management.api'

describe('DataManagementAPI - 本地备份/恢复', () => {
  beforeEach(() => {
    ;(PlatformDetector as any)._platform = null
    setupWindowMocks()
  })

  // ---- 文件读写 ----

  describe('文件操作', () => {
    it('writeFile 调用 electronAPI', async () => {
      const result = await DataManagementAPI.writeFile('/path/file.json', '{"test":1}')
      expect(result).toBe(true)
      expect((window as any).electronAPI.invoke).toHaveBeenCalledWith(
        'data:write-file',
        expect.objectContaining({ filePath: '/path/file.json' })
      )
    })

    it('readFile 返回文件内容', async () => {
      const content = await DataManagementAPI.readFile('/path/file.json')
      expect(content).toBe(JSON.stringify(mockExportData))
    })

    it('Electron 不可用时 writeFile 抛出错误', async () => {
      ;(window as any).electronAPI = undefined
      await expect(DataManagementAPI.writeFile('/path', 'data')).rejects.toThrow()
    })
  })

  // ---- JSON 导出/导入 ----

  describe('JSON 格式导出/导入', () => {
    it('exportDataToFile 将数据序列化为 JSON 并写入', async () => {
      const result = await DataManagementAPI.exportDataToFile(mockExportData, '/path/backup.json', 'json')
      expect(result).toBe(true)

      const writeCall = (window as any).electronAPI.invoke.mock.calls.find(
        (c: any[]) => c[0] === 'data:write-file'
      )
      expect(writeCall).toBeDefined()
      const written = JSON.parse(writeCall[1].content)
      expect(written.categories).toHaveLength(1)
      expect(written.prompts).toHaveLength(1)
    })

    it('importDataFromFile 读取并解析 JSON', async () => {
      const data = await DataManagementAPI.importDataFromFile('/path/backup.json', 'json')
      expect(data).toBeDefined()
      expect(data.categories).toHaveLength(1)
      expect(data.prompts).toHaveLength(1)
    })

    it('文件读取失败时 importDataFromFile 返回 null', async () => {
      ;(window as any).electronAPI.invoke = vi.fn().mockResolvedValue({ success: false, content: null })
      const data = await DataManagementAPI.importDataFromFile('/path/bad.json', 'json')
      expect(data).toBeNull()
    })
  })

  // ---- CSV 导出/导入 ----

  describe('CSV 格式导出/导入', () => {
    it('exportDataToFile 将数据转换为 CSV', async () => {
      const result = await DataManagementAPI.exportDataToFile(mockExportData, '/path/backup.csv', 'csv')
      expect(result).toBe(true)

      const writeCall = (window as any).electronAPI.invoke.mock.calls.find(
        (c: any[]) => c[0] === 'data:write-file'
      )
      const csv = writeCall[1].content
      expect(csv).toContain('Categories')
      expect(csv).toContain('Prompts')
      expect(csv).toContain('分类A')
      expect(csv).toContain('提示词A')
    })

    it('importDataFromFile 解析 CSV 并返回结构化数据', async () => {
      const csvContent = [
        'Categories',
        'ID,Name,Description,CreatedAt',
        '1,分类A,描述,2026-01-01',
        '',
        'Prompts',
        'ID,Title,Content,CategoryId,CreatedAt',
        '1,提示词A,内容A,1,2026-01-01',
      ].join('\n')

      ;(window as any).electronAPI.invoke = vi.fn().mockResolvedValue({
        success: true,
        content: csvContent
      })

      const data = await DataManagementAPI.importDataFromFile('/path/backup.csv', 'csv')
      expect(data.categories).toHaveLength(1)
      expect(data.categories[0].Name).toBe('分类A')
      expect(data.prompts).toHaveLength(1)
      expect(data.prompts[0].Title).toBe('提示词A')
    })
  })

  // ---- 完整备份流程 ----

  describe('exportFullBackup', () => {
    it('成功导出完整备份', async () => {
      const result = await DataManagementAPI.exportFullBackup()
      expect(result.success).toBe(true)
      expect(result.filePath).toBe('/mock/path/backup.json')

      const writeCall = (window as any).electronAPI.invoke.mock.calls.find(
        (c: any[]) => c[0] === 'data:write-file'
      )
      const payload = JSON.parse(writeCall[1].content)
      expect(payload.data.categories).toHaveLength(1)
      expect(payload.checksum).toMatch(/^fnv1a32:/)
    })

    it('用户取消选择路径时返回失败', async () => {
      ;(window as any).electronAPI.invoke = vi.fn().mockImplementation(async (channel: string) => {
        if (channel === 'data:select-export-path') return null // 用户取消
        return { success: true }
      })

      const result = await DataManagementAPI.exportFullBackup()
      expect(result.success).toBe(false)
      expect(result.message).toContain('未选择')
    })

    it('数据库导出失败时不会生成空备份文件', async () => {
      ;(window as any).databaseAPI.exportAllDataForBackup.mockResolvedValueOnce({
        success: false,
        error: 'database unavailable'
      })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      try {
        const result = await DataManagementAPI.exportFullBackup()

        expect(result.success).toBe(false)
        expect(result.message).toContain('database unavailable')
        expect((window as any).electronAPI.invoke).not.toHaveBeenCalledWith(
          'data:write-file',
          expect.anything()
        )
      } finally {
        errorSpy.mockRestore()
      }
    })
  })

  describe('exportSelectedData', () => {
    it('数据库导出失败时不会导出空选择数据文件', async () => {
      ;(window as any).databaseAPI.exportAllDataForBackup = undefined
      ;(window as any).databaseAPI.exportAllData.mockResolvedValueOnce({
        success: false,
        error: 'database unavailable'
      })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      try {
        const result = await DataManagementAPI.exportSelectedData({
          includeCategories: true,
          includePrompts: true,
          includeAIConfigs: true,
          format: 'json'
        })

        expect(result.success).toBe(false)
        expect(result.message).toContain('database unavailable')
        expect((window as any).electronAPI.invoke).not.toHaveBeenCalledWith(
          'data:write-file',
          expect.anything()
        )
      } finally {
        errorSpy.mockRestore()
      }
    })
  })

  describe('importFullBackup', () => {
    it('成功导入完整备份', async () => {
      const result = await DataManagementAPI.importFullBackup()
      expect(result.success).toBe(true)
    })

    it('兼容旧版本裸数据完整备份导入', async () => {
      ;(window as any).electronAPI.invoke = vi.fn().mockImplementation(async (channel: string) => {
        if (channel === 'data:select-import-file') return '/path/legacy.json'
        if (channel === 'data:read-file') return { success: true, content: JSON.stringify(mockExportData) }
        return { success: true }
      })

      const result = await DataManagementAPI.importFullBackup()
      expect(result.success).toBe(true)
      expect((window as any).databaseAPI.replaceAllData).toHaveBeenCalledWith(mockExportData)
    })

    it('checksum 不匹配时拒绝导入且不替换数据库', async () => {
      const data = {
        ...mockExportData,
        categories: [...mockExportData.categories],
        prompts: [...mockExportData.prompts],
        aiConfigs: [...mockExportData.aiConfigs],
        aiHistory: [...mockExportData.aiHistory],
        settings: [...mockExportData.settings]
      }
      const payload = createBackupPayload({
        id: 'bad-backup',
        name: 'bad-backup',
        createdAt: '2026-06-12T00:00:00.000Z',
        data
      })
      payload.data.prompts.push(testDataGenerators.createMockPrompt({ id: 2, title: '损坏数据' }))

      ;(window as any).electronAPI.invoke = vi.fn().mockImplementation(async (channel: string) => {
        if (channel === 'data:select-import-file') return '/path/bad-checksum.json'
        if (channel === 'data:read-file') return { success: true, content: JSON.stringify(payload) }
        return { success: true }
      })

      const result = await DataManagementAPI.importFullBackup()
      expect(result.success).toBe(false)
      expect(result.message).toContain('备份数据校验失败')
      expect((window as any).databaseAPI.replaceAllData).not.toHaveBeenCalled()
    })

    it('用户取消选择文件时返回失败', async () => {
      ;(window as any).electronAPI.invoke = vi.fn().mockImplementation(async (channel: string) => {
        if (channel === 'data:select-import-file') return null
        return { success: true }
      })

      const result = await DataManagementAPI.importFullBackup()
      expect(result.success).toBe(false)
      expect(result.message).toContain('未选择')
    })

    it('文件内容损坏时返回失败', async () => {
      ;(window as any).electronAPI.invoke = vi.fn().mockImplementation(async (channel: string) => {
        if (channel === 'data:select-import-file') return '/path/bad.json'
        if (channel === 'data:read-file') return { success: true, content: 'not valid json{{{' }
        return { success: true }
      })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      try {
        const result = await DataManagementAPI.importFullBackup()
        expect(result.success).toBe(false)
      } finally {
        errorSpy.mockRestore()
      }
    })
  })

  // ---- 场景3：本地备份 → 本地恢复 ----

  describe('场景：本地备份 → 本地恢复', () => {
    it('导出后能重新导入相同数据', async () => {
      // 导出
      let writtenContent = ''
      ;(window as any).electronAPI.invoke = vi.fn().mockImplementation(async (channel: string, args: any) => {
        if (channel === 'data:select-export-path') return '/path/backup.json'
        if (channel === 'data:write-file') {
          writtenContent = args.content
          return { success: true }
        }
        if (channel === 'data:select-import-file') return '/path/backup.json'
        if (channel === 'data:read-file') return { success: true, content: writtenContent }
        return { success: true }
      })

      const exportResult = await DataManagementAPI.exportFullBackup()
      expect(exportResult.success).toBe(true)

      // 导入
      const importResult = await DataManagementAPI.importFullBackup()
      expect(importResult.success).toBe(true)

      // 验证写入的内容是有效 JSON
      const parsed = JSON.parse(writtenContent)
      expect(parsed.data.categories).toBeDefined()
      expect(parsed.data.prompts).toBeDefined()
      expect(parsed.checksum).toMatch(/^fnv1a32:/)
    })
  })
})
