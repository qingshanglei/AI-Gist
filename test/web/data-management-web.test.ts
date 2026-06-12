import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformDetector } from '@shared/platform'
import { DataManagementAPI } from '../../src/renderer/lib/api/data-management.api'

describe('DataManagementAPI Web file fallback', () => {
  beforeEach(() => {
    ;(PlatformDetector as any)._platform = null
    ;(window as any).electronAPI = undefined
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn()
    })
  })

  it('uses a browser download token when Electron save dialogs are unavailable', async () => {
    const filePath = await DataManagementAPI.selectExportPath('ai-gist-export.json')
    expect(filePath).toBe('web-download:ai-gist-export.json')
  })

  it('downloads JSON content from Web export tokens', async () => {
    const click = vi.fn()
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = originalCreateElement(tagName)
      if (tagName === 'a') {
        Object.defineProperty(element, 'click', { value: click })
      }
      return element
    })

    const result = await DataManagementAPI.exportDataToFile(
      { categories: [], prompts: [], aiConfigs: [] },
      'web-download:ai-gist-export.json',
      'json'
    )

    expect(result).toBe(true)
    expect(click).toHaveBeenCalled()
    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock')
  })
})

