import type {
  AIConfig,
  AIConfigTestResult,
  AIGenerationRequest,
  AIGenerationResult
} from '@shared/types/ai';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export class WebAIService {
  private static instance: WebAIService;
  private currentAbortController: AbortController | null = null;

  static getInstance(): WebAIService {
    if (!WebAIService.instance) {
      WebAIService.instance = new WebAIService();
    }
    return WebAIService.instance;
  }

  async testConfig(config: AIConfig): Promise<AIConfigTestResult> {
    return this.request<AIConfigTestResult>('/api/ai/test-config', { config });
  }

  async testModel(config: AIConfig, model: string): Promise<{
    success: boolean;
    error?: string;
    model?: string;
    response?: string;
  }> {
    return this.request('/api/ai/test-model', { config, model });
  }

  async getModels(config: AIConfig): Promise<string[]> {
    const result = await this.request<{ models: string[] }>('/api/ai/models', { config });
    return result.models || [];
  }

  async generatePrompt(request: AIGenerationRequest, config: AIConfig): Promise<AIGenerationResult> {
    return this.request<AIGenerationResult>('/api/ai/generate', { request, config });
  }

  async generatePromptStream(
    request: AIGenerationRequest,
    config: AIConfig,
    onProgress: (charCount: number, partialContent?: string) => boolean
  ): Promise<AIGenerationResult> {
    const abortController = new AbortController();
    this.currentAbortController = abortController;

    try {
      const response = await fetch('/api/ai/generate-stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ request, config }),
        signal: abortController.signal
      });

      if (!response.ok) {
        throw new Error(await this.readErrorMessage(response, `Web AI 流式请求失败（HTTP ${response.status}）`));
      }

      if (!response.body) {
        throw new Error('Web AI 后端没有返回可读取的流');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalResult: AIGenerationResult | null = null;

      const handleLine = (line: string) => {
        if (!line.trim()) {
          return;
        }

        const event = JSON.parse(line);
        if (event.type === 'progress') {
          const partialContent = event.partialContent || '';
          const charCount = Number(event.charCount ?? partialContent.length);
          const shouldContinue = onProgress(charCount, partialContent);
          if (shouldContinue === false) {
            abortController.abort();
            throw new Error('用户中断生成');
          }
          return;
        }

        if (event.type === 'done') {
          finalResult = event.result;
          return;
        }

        if (event.type === 'error') {
          throw new Error(event.error || 'Web AI 流式生成失败');
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        lines.forEach(handleLine);
      }

      buffer += decoder.decode();
      handleLine(buffer);

      if (!finalResult) {
        throw new Error('Web AI 流式响应没有返回生成结果');
      }

      return finalResult;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error('用户中断生成');
      }
      throw error;
    } finally {
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
    }
  }

  async intelligentTest(config: AIConfig): Promise<AIConfigTestResult> {
    return this.request<AIConfigTestResult>('/api/ai/intelligent-test', { config });
  }

  async stopGeneration(): Promise<{ success: boolean; message: string }> {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
      return { success: true, message: '已停止 Web 端生成请求' };
    }
    return { success: true, message: '当前没有正在运行的 Web 端生成请求' };
  }

  async debugPrompt(prompt: string, config: AIConfig): Promise<AIGenerationResult> {
    return this.generatePrompt({ configId: config.configId, topic: prompt }, config);
  }

  private async request<T>(path: string, body: any): Promise<T> {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    let payload: ApiResponse<T> | null = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok || !payload?.success) {
      throw new Error(payload?.error || `Web AI 后端请求失败（HTTP ${response.status}）`);
    }

    return payload.data as T;
  }

  private async readErrorMessage(response: Response, fallback: string): Promise<string> {
    try {
      const payload = await response.json();
      return payload?.error || fallback;
    } catch {
      try {
        const text = await response.text();
        return text || fallback;
      } catch {
        return fallback;
      }
    }
  }
}

export const webAIService = WebAIService.getInstance();
