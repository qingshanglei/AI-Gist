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
      'gpt-4o',
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
      'gemini-3.1-pro',
      'gemini-3.1-flash',
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash'
    ],
    testModelPriority: ['gemini-3.1-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash']
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
      'gpt-4o'
    ],
    testModelPriority: ['gpt-5.4-mini', 'gpt-4.1-mini', 'gpt-4o-mini']
  },
  deepseek: {
    type: 'deepseek',
    displayName: 'DeepSeek',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    docUrl: 'https://api-docs.deepseek.com/',
    defaultModels: [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-chat',
      'deepseek-reasoner'
    ],
    testModelPriority: ['deepseek-v4-flash', 'deepseek-chat']
  },
  mistral: {
    type: 'mistral',
    displayName: 'Mistral AI',
    defaultBaseURL: 'https://api.mistral.ai/v1',
    apiKeyUrl: 'https://console.mistral.ai/api-keys/',
    docUrl: 'https://docs.mistral.ai/',
    defaultModels: [
      'mistral-large-latest',
      'mistral-medium-latest',
      'mistral-small-latest',
      'magistral-medium-latest',
      'codestral-latest',
      'ministral-8b-latest'
    ],
    testModelPriority: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest']
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
    displayName: '腾讯云',
    defaultBaseURL: 'https://api.hunyuan.cloud.tencent.com/v1',
    apiKeyUrl: 'https://console.cloud.tencent.com/hunyuan',
    docUrl: 'https://cloud.tencent.com/document/product/1729',
    defaultModels: [
      'hunyuan-turbos-latest',
      'hunyuan-turbo-latest',
      'hunyuan-large',
      'hunyuan-standard'
    ],
    testModelPriority: ['hunyuan-turbos-latest', 'hunyuan-turbo-latest']
  },
  aliyun: {
    type: 'aliyun',
    displayName: '阿里云',
    defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyUrl: 'https://bailian.console.aliyun.com/',
    docUrl: 'https://help.aliyun.com/zh/model-studio/',
    defaultModels: [
      'qwen-max-latest',
      'qwen-plus-latest',
      'qwen-turbo-latest',
      'qwen3-max',
      'qwen3-plus',
      'qwen3-coder-plus'
    ],
    testModelPriority: ['qwen-turbo-latest', 'qwen-plus-latest', 'qwen3-plus']
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
      'glm-4.7',
      'glm-4.6',
      'glm-4'
    ],
    testModelPriority: ['glm-5.1', 'glm-5-turbo', 'glm-4.6', 'glm-4']
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
      'google/gemini-3.1-pro',
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
