import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDER_METADATA,
  getDefaultBaseURL,
  getDefaultModels,
  getTestModelPriority
} from '@shared/ai-provider-metadata'
import type { AIProviderType } from '@shared/types/ai'

const providerTypes: AIProviderType[] = [
  'openai',
  'ollama',
  'anthropic',
  'google',
  'azure',
  'lmstudio',
  'deepseek',
  'mistral',
  'siliconflow',
  'tencent',
  'aliyun',
  'zhipu',
  'openrouter'
]

describe('AI provider metadata', () => {
  it('covers every supported provider type', () => {
    expect(Object.keys(AI_PROVIDER_METADATA).sort()).toEqual([...providerTypes].sort())
  })

  it('uses the current DashScope OpenAI-compatible endpoint', () => {
    expect(getDefaultBaseURL('aliyun')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
  })

  it('uses Tencent TokenHub as the default Tencent endpoint', () => {
    expect(getDefaultBaseURL('tencent')).toBe('https://tokenhub.tencentmaas.com/v1')
  })

  it('keeps OpenAI defaults on current GPT-5 generation models', () => {
    expect(getDefaultModels('openai').slice(0, 4)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano'
    ])
    expect(getDefaultModels('openai')).not.toContain('gpt-3.5-turbo')
  })

  it('keeps Gemini defaults away from legacy gemini-pro', () => {
    expect(getDefaultModels('google')[0]).toBe('gemini-3-pro-preview')
    expect(getDefaultModels('google')).not.toContain('gemini-3.1-pro')
    expect(getDefaultModels('google')).not.toContain('gemini-pro')
  })

  it('provides test model priorities for remote providers', () => {
    expect(getTestModelPriority('anthropic')[0]).toBe('claude-sonnet-4-6')
    expect(getTestModelPriority('aliyun')[0]).toBe('qwen3.6-flash')
    expect(getTestModelPriority('openrouter')[0]).toBe('openai/gpt-5.4-mini')
  })
})
