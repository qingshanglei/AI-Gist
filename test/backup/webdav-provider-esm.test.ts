// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { WebDAVProvider } from '../../src/main/cloud/webdav-provider';

type RuntimeImportGlobal = typeof globalThis & {
  __AI_GIST_WEB_DAV_IMPORT__?: <T>(specifier: string) => Promise<T>;
};

const originalRuntimeImport = (globalThis as RuntimeImportGlobal).__AI_GIST_WEB_DAV_IMPORT__;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalRuntimeImport) {
    (globalThis as RuntimeImportGlobal).__AI_GIST_WEB_DAV_IMPORT__ = originalRuntimeImport;
  } else {
    delete (globalThis as RuntimeImportGlobal).__AI_GIST_WEB_DAV_IMPORT__;
  }
});

describe('WebDAVProvider ESM module loading', () => {
  it('keeps webdav loading as runtime import in the CommonJS main-process build', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/main/cloud/webdav-provider.ts'), 'utf-8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2015,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText;

    const executableOutput = output
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    expect(executableOutput).not.toMatch(/require\((['"])webdav\1\)/);
    expect(executableOutput).toMatch(/return import\(specifier\)/);
  });

  it('does not write default console errors when the runtime webdav import fails', async () => {
    (globalThis as RuntimeImportGlobal).__AI_GIST_WEB_DAV_IMPORT__ = async () => {
      throw new Error('webdav module unavailable');
    };

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const provider = new WebDAVProvider({
      id: 'runtime-import-failure',
      name: 'Runtime Import Failure',
      type: 'webdav',
      enabled: true,
      url: 'https://example.com/dav',
      username: 'user',
      password: 'pass',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await expect(provider.testConnection()).rejects.toThrow('WebDAV 客户端初始化失败: webdav module unavailable');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
