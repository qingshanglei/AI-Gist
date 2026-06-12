import { describe, expect, it } from 'vitest'
import { PromptService } from '../../src/renderer/lib/services/prompt.service'

class TestPromptService extends PromptService {
  readonly deleteCalls: { storeName: string; id: number }[] = []

  protected override async delete(storeName: string, id: number): Promise<void> {
    this.deleteCalls.push({ storeName, id })
  }
}

describe('PromptService', () => {
  it('deletes prompt histories through the shared delete path so tombstones are written', async () => {
    const service = new TestPromptService()

    const result = await service.deletePromptHistory(42)

    expect(result).toBe(true)
    expect(service.deleteCalls).toEqual([
      { storeName: 'promptHistories', id: 42 }
    ])
  })
})
