import type { AIProviderType } from './types/ai';

export interface AIProviderMetadata {
  type: AIProviderType;
  displayName: string;
  defaultBaseURL: string;
  apiKeyUrl: string;
  docUrl: string;
  defaultModels: string[];
  testModelPriority: string[];
}

export const AI_PROVIDER_METADATA: Record<AIProviderType, AIProviderMetadata> = {
  openai: {
    type: 'openai',
    displayName: 'OpenAI',
    defaultBaseURL: 'https://api.openai.com/v1',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    docUrl: 'https://platform.openai.com/docs',
    defaultModels: [
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-4o-mini'
    ],
    testModelPriority: ['gpt-5.5', 'gpt-5.4-mini', 'gpt-4.1-mini', 'gpt-4o-mini']
  },
  ollama: {
    type: 'ollama',
    displayName: 'Ollama',
    defaultBaseURL: 'http://localhost:11434',
    apiKeyUrl: '',
    docUrl: 'https://github.com/ollama/ollama',
    defaultModels: [],
    testModelPriority: []
  },
  lmstudio: {
    type: 'lmstudio',
    displayName: 'LM Studio',
    defaultBaseURL: 'http://localhost:1234/v1',
    apiKeyUrl: '',
    docUrl: 'https://lmstudio.ai/docs/app/basics',
    defaultModels: [],
    testModelPriority: []
  },
  anthropic: {
    type: 'anthropic',
    displayName: 'Anthropic Claude',
    defaultBaseURL: '',
    apiKeyUrl: 'https://console.anthropic.com/',
    docUrl: 'https://docs.anthropic.com/',
    defaultModels: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-3-5-sonnet-20241022'
    ],
    testModelPriority: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-5']
  },
  google: {
    type: 'google',
    displayName: 'Google Gemini AI',
    defaultBaseURL: '',
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
    docUrl: 'https://ai.google.dev/gemini-api/docs',
    defaultModels: [
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite'
    ],
    testModelPriority: ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']
  },
  azure: {
    type: 'azure',
    displayName: 'Azure OpenAI',
    defaultBaseURL: '',
    apiKeyUrl: 'https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesBrowse/~/OpenAI',
    docUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/',
    defaultModels: [
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o'
    ],
    testModelPriority: ['gpt-5.4-mini', 'gpt-4.1-mini', 'gpt-4o-mini']
  },
  deepseek: {
    type: 'deepseek',
    displayName: 'DeepSeek',
    defaultBaseURL: 'https://api.deepseek.com',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    docUrl: 'https://api-docs.deepseek.com/',
    defaultModels: [
      'deepseek-v4-flash',
      'deepseek-v4-pro'
    ],
    testModelPriority: ['deepseek-v4-flash', 'deepseek-v4-pro']
  },
  mistral: {
    type: 'mistral',
    displayName: 'Mistral AI',
    defaultBaseURL: 'https://api.mistral.ai/v1',
    apiKeyUrl: 'https://console.mistral.ai/api-keys/',
    docUrl: 'https://docs.mistral.ai/',
    defaultModels: [
      'mistral-medium-3.5',
      'mistral-large-latest',
      'mistral-small-4',
      'magistral-medium-latest',
      'codestral-latest',
      'ministral-8b-latest'
    ],
    testModelPriority: ['mistral-small-4', 'mistral-medium-3.5', 'mistral-large-latest']
  },
  siliconflow: {
    type: 'siliconflow',
    displayName: '硅基流动',
    defaultBaseURL: 'https://api.siliconflow.cn/v1',
    apiKeyUrl: 'https://cloud.siliconflow.cn/me/account/ak',
    docUrl: 'https://docs.siliconflow.cn/',
    defaultModels: [
      'Qwen/Qwen3-32B',
      'Qwen/Qwen3-14B',
      'Qwen/Qwen3-8B',
      'THUDM/GLM-4.6',
      'deepseek-ai/DeepSeek-V3.1'
    ],
    testModelPriority: ['Qwen/Qwen3-8B', 'Qwen/Qwen3-14B', 'THUDM/GLM-4.6']
  },
  tencent: {
    type: 'tencent',
    displayName: '腾讯云 TokenHub',
    defaultBaseURL: 'https://tokenhub.tencentmaas.com/v1',
    apiKeyUrl: 'https://console.cloud.tencent.com/tokenhub',
    docUrl: 'https://cloud.tencent.com/document/product/1823',
    defaultModels: [
      'hy3-preview',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'glm-5.1',
      'kimi-k2.6',
      'minimax-m2.7',
      'hunyuan-role-latest'
    ],
    testModelPriority: ['hy3-preview', 'deepseek-v4-flash', 'glm-5.1']
  },
  aliyun: {
    type: 'aliyun',
    displayName: '阿里云',
    defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyUrl: 'https://bailian.console.aliyun.com/',
    docUrl: 'https://help.aliyun.com/zh/model-studio/',
    defaultModels: [
      'qwen3.7-max',
      'qwen3.6-plus',
      'qwen3.6-flash',
      'qwen-turbo-latest',
      'qwen3-coder-plus',
      'qwen-long-latest',
      'qwq-plus-latest'
    ],
    testModelPriority: ['qwen3.6-flash', 'qwen-turbo-latest', 'qwen3.6-plus']
  },
  zhipu: {
    type: 'zhipu',
    displayName: '智谱AI',
    defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    docUrl: 'https://docs.bigmodel.cn/cn/guide/start/model-overview',
    defaultModels: [
      'glm-5.1',
      'glm-5',
      'glm-5-turbo',
      'glm-5v-turbo',
      'glm-4.7',
      'glm-4.6',
      'glm-4-flash-250414'
    ],
    testModelPriority: ['glm-5.1', 'glm-5-turbo', 'glm-4-flash-250414']
  },
  openrouter: {
    type: 'openrouter',
    displayName: 'OpenRouter',
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    apiKeyUrl: 'https://openrouter.ai/keys',
    docUrl: 'https://openrouter.ai/docs',
    defaultModels: [
      'openai/gpt-5.5',
      'openai/gpt-5.4-mini',
      'anthropic/claude-sonnet-4.6',
      'google/gemini-3-pro-preview',
      'mistralai/mistral-large-latest',
      'deepseek/deepseek-v4-flash',
      'openai/gpt-4o-mini'
    ],
    testModelPriority: ['openai/gpt-5.4-mini', 'anthropic/claude-sonnet-4.6', 'openai/gpt-4o-mini']
  }
};

export const getProviderMetadata = (type: AIProviderType): AIProviderMetadata => {
  return AI_PROVIDER_METADATA[type];
};

export const getDefaultBaseURL = (type: AIProviderType): string => {
  return getProviderMetadata(type).defaultBaseURL;
};

export const getDefaultModels = (type: AIProviderType): string[] => {
  return [...getProviderMetadata(type).defaultModels];
};

export const getTestModelPriority = (type: AIProviderType): string[] => {
  return [...getProviderMetadata(type).testModelPriority];
};

export const getConfiguredBaseURL = (type: AIProviderType, baseURL?: string): string => {
  const configuredBaseURL = baseURL?.trim() || getDefaultBaseURL(type);
  return configuredBaseURL.replace(/\/+$/, '');
};
