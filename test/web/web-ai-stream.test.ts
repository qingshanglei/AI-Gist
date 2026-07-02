import { beforeEach, describe, expect, it, vi } from 'vitest'
import { webAIService } from '../../src/renderer/lib/services/web-ai.service'
import type { AIConfig, AIGenerationRequest } from '../../src/shared/types/ai'

const config: AIConfig = {
  configId: 'web-ai-test',
  name: 'Web AI Test',
  type: 'openai',
  baseURL: 'https://example.test/v1',
  apiKey: 'test-key',
  models: ['test-model'],
  defaultModel: 'test-model',
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date()
}

const request: AIGenerationRequest = {
  configId: 'web-ai-test',
  model: 'test-model',
  topic: '写一个测试提示词'
}

function createStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      lines.forEach(line => controller.enqueue(encoder.encode(line)))
      controller.close()
    }
  })
}

describe('WebAIService streaming generation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('emits progress events before returning the final result', async () => {
    const fetchMock = vi.fn(async () => new Response(createStream([
      JSON.stringify({ type: 'progress', charCount: 2, partialContent: '你好' }) + '\n',
      JSON.stringify({
        type: 'done',
        result: {
          id: 'web_gen_test',
          configId: 'web-ai-test',
          topic: request.topic,
          generatedPrompt: '你好',
          model: 'test-model',
          createdAt: new Date().toISOString()
        }
      }) + '\n'
    ]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const progress = vi.fn(() => true)
    const result = await webAIService.generatePromptStream(request, config, progress)

    expect(fetchMock).toHaveBeenCalledWith('/api/ai/generate-stream', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request, config })
    }))
    expect(progress).toHaveBeenCalledWith(2, '你好')
    expect(result.generatedPrompt).toBe('你好')
  })

  it('aborts the current Web request when progress asks to stop', async () => {
    const fetchMock = vi.fn(async () => new Response(createStream([
      JSON.stringify({ type: 'progress', charCount: 2, partialContent: '停止' }) + '\n'
    ]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(webAIService.generatePromptStream(request, config, () => false))
      .rejects
      .toThrow('用户中断生成')

    const fetchOptions = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal)
    expect((fetchOptions.signal as AbortSignal).aborted).toBe(true)
  })
})
