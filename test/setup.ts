/**
 * Vitest 全局设置文件
 * 在每个测试运行之前和之后执行全局设置和清理
 */

import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { setupTestEnvironment, cleanupTestEnvironment } from './helpers/test-utils'

type RuntimeImportGlobal = typeof globalThis & {
  __AI_GIST_WEB_DAV_IMPORT__?: <T>(specifier: string) => Promise<T>
}

function installRuntimeImport(): void {
  ;(globalThis as RuntimeImportGlobal).__AI_GIST_WEB_DAV_IMPORT__ = <T>(specifier: string) =>
    import(specifier) as Promise<T>
}

// 全局设置 - 在所有测试开始前执行
beforeAll(() => {
  console.log('🚀 开始执行测试套件...')
  installRuntimeImport()
  setupTestEnvironment()
})

// 全局清理 - 在所有测试结束后执行
afterAll(() => {
  cleanupTestEnvironment()
  delete (globalThis as RuntimeImportGlobal).__AI_GIST_WEB_DAV_IMPORT__
  console.log('🎉 测试套件执行完毕')
})

// 每个测试前的设置
beforeEach(() => {
  // 确保每个测试都有干净的环境
  installRuntimeImport()
  setupTestEnvironment()
})

// 每个测试后的清理
afterEach(() => {
  cleanupTestEnvironment()
})
