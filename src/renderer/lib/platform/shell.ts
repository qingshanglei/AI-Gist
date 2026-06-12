import { PlatformDetector } from '@shared/platform';

export async function openExternalUrl(url: string): Promise<{ success: boolean; error?: string }> {
  try {
    if (PlatformDetector.isElectron() && window.electronAPI?.shell?.openExternal) {
      return await window.electronAPI.shell.openExternal(url);
    }

    if (PlatformDetector.isElectron() && window.electronAPI?.app?.openDownloadPage) {
      return await window.electronAPI.app.openDownloadPage(url);
    }

    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
      return { success: true };
    }

    return { success: false, error: '当前环境无法打开外部链接' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

