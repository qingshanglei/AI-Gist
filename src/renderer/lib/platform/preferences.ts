import { PlatformDetector } from '@shared/platform';
import type { UserPreferences } from '@shared/types/preferences';

const WEB_PREFERENCES_KEY = 'ai-gist:web:user-preferences';

export const defaultPreferences: UserPreferences = {
  theme: 'system',
  language: 'zh-CN',
  autoStartup: false,
  minimizeToTray: false,
  showNotifications: true,
  checkUpdates: true,
  windowSize: {
    width: 1200,
    height: 800
  },
  windowPosition: {
    x: 0,
    y: 0
  },
  closeBehaviorMode: 'ask',
  closeAction: 'quit',
  startMinimized: false,
  autoLaunch: false,
  themeSource: 'system',
  dataSync: {
    lastSyncTime: null,
    autoBackup: true,
    backupInterval: 24
  },
  shortcuts: {
    showInterface: {
      key: 'Ctrl+Shift+G',
      description: '显示界面',
      enabled: true,
      type: 'show-interface'
    },
    copyPrompt: {
      key: 'Ctrl+Shift+Alt+C',
      description: '复制提示词',
      enabled: true,
      type: 'copy-prompt'
    },
    promptTriggers: []
  },
  networkProxy: {
    mode: 'system',
    manualConfig: {
      httpProxy: '',
      httpsProxy: '',
      noProxy: ''
    }
  }
};

function clonePreferences(preferences: UserPreferences): UserPreferences {
  return JSON.parse(JSON.stringify(preferences));
}

function mergePreferences(input?: Partial<UserPreferences> | null): UserPreferences {
  const base = clonePreferences(defaultPreferences);
  if (!input) {
    return base;
  }

  return {
    ...base,
    ...input,
    windowSize: {
      ...base.windowSize,
      ...(input.windowSize || {})
    },
    windowPosition: {
      ...base.windowPosition,
      ...(input.windowPosition || {})
    },
    dataSync: {
      ...base.dataSync!,
      ...(input.dataSync || {})
    },
    shortcuts: {
      ...base.shortcuts!,
      ...(input.shortcuts || {}),
      showInterface: {
        ...base.shortcuts!.showInterface,
        ...(input.shortcuts?.showInterface || {})
      },
      copyPrompt: {
        ...base.shortcuts!.copyPrompt,
        ...(input.shortcuts?.copyPrompt || {})
      },
      promptTriggers: input.shortcuts?.promptTriggers || base.shortcuts!.promptTriggers
    },
    networkProxy: {
      ...base.networkProxy!,
      ...(input.networkProxy || {}),
      manualConfig: {
        ...base.networkProxy!.manualConfig,
        ...(input.networkProxy?.manualConfig || {})
      }
    }
  };
}

function getWebStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

async function getWebPreferences(): Promise<UserPreferences> {
  const storage = getWebStorage();
  if (!storage) {
    return clonePreferences(defaultPreferences);
  }

  const raw = storage.getItem(WEB_PREFERENCES_KEY);
  if (!raw) {
    const initial = clonePreferences(defaultPreferences);
    storage.setItem(WEB_PREFERENCES_KEY, JSON.stringify(initial));
    return initial;
  }

  try {
    return mergePreferences(JSON.parse(raw));
  } catch {
    const recovered = clonePreferences(defaultPreferences);
    storage.setItem(WEB_PREFERENCES_KEY, JSON.stringify(recovered));
    return recovered;
  }
}

async function setWebPreferences(patch: Partial<UserPreferences>): Promise<UserPreferences> {
  const storage = getWebStorage();
  const current = await getWebPreferences();
  const next = mergePreferences({
    ...current,
    ...patch
  });

  storage?.setItem(WEB_PREFERENCES_KEY, JSON.stringify(next));
  return next;
}

async function resetWebPreferences(): Promise<UserPreferences> {
  const next = clonePreferences(defaultPreferences);
  getWebStorage()?.setItem(WEB_PREFERENCES_KEY, JSON.stringify(next));
  return next;
}

export const preferencesClient = {
  async get(): Promise<UserPreferences> {
    if (PlatformDetector.isElectron() && window.electronAPI?.preferences) {
      return mergePreferences(await window.electronAPI.preferences.get());
    }

    return getWebPreferences();
  },

  async set(prefs: Partial<UserPreferences>): Promise<UserPreferences> {
    if (PlatformDetector.isElectron() && window.electronAPI?.preferences) {
      return mergePreferences(await window.electronAPI.preferences.set(prefs));
    }

    return setWebPreferences(prefs);
  },

  async reset(): Promise<UserPreferences> {
    if (PlatformDetector.isElectron() && window.electronAPI?.preferences) {
      return mergePreferences(await window.electronAPI.preferences.reset());
    }

    return resetWebPreferences();
  }
};

