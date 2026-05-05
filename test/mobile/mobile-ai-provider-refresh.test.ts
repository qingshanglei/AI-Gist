import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AIGeneratorService } from '../../src/renderer/lib/services/mobile-ai-generator.service'
import { PlatformDetector } from '@shared/platform'
import type { AIConfig, AIGenerationRequest } from '@shared/types/ai'

function makeConfig(overrides: Partial<AIConfig> = {}): AIConfig {
  return {
    configId: 'cfg-provider-refresh',
    name: 'Provider Refresh',
    type: 'openai',
    baseURL: '',
    apiKey: 'test-key',
    models: [],
    defaultModel: '',
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  }
}

function makeRequest(overrides: Partial<AIGenerationRequest> = {}): AIGenerationRequest {
  return {
    configId: 'cfg-provider-refresh',
    topic: '写一个测试提示词',
    ...overrides
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('mobile AI provider 2026 refresh', () => {
  beforeEach(() => {
    ;(PlatformDetector as any)._platform = null
    vi.stubGlobal('fetch', vi.fn())
  })

  it('uses DashScope compatible-mode endpoint for Aliyun when baseURL is empty', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: 'generated prompt' } }]
    }))

    await AIGeneratorService.generatePrompt(
      makeRequest({ model: 'qwen-plus-latest' }),
      makeConfig({ type: 'aliyun', defaultModel: 'qwen-plus-latest' })
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key'
        })
      })
    )

    const [, options] = fetchMock.mock.calls[0]
    expect(JSON.parse(String((options as RequestInit).body)).model).toBe('qwen-plus-latest')
  })

  it('sends OpenRouter attribution headers on mobile direct calls', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: 'generated prompt' } }]
    }))

    await AIGeneratorService.generatePrompt(
      makeRequest({ model: 'openai/gpt-5.4-mini' }),
      makeConfig({ type: 'openrouter', defaultModel: 'openai/gpt-5.4-mini' })
    )

    const [, options] = fetchMock.mock.calls[0]
    expect((options as RequestInit).headers).toEqual(expect.objectContaining({
      'HTTP-Referer': 'https://getaigist.com',
      'X-OpenRouter-Title': 'AI Gist',
      'X-Title': 'AI Gist'
    }))
  })

  it('uses the refreshed Gemini fallback model and v1beta endpoint', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse({
      candidates: [{ content: { parts: [{ text: 'generated prompt' }] } }]
    }))

    await AIGeneratorService.generatePrompt(
      makeRequest(),
      makeConfig({ type: 'google' })
    )

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent?key=test-key'
    )
  })
})
