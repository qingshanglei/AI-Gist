/**
 * 移动端云端备份服务
 * 使用 Capacitor Preferences 存储云端备份配置
 * WebDAV: 使用 HTTP 客户端实现真正的 WebDAV 协议
 * iCloud Drive: iOS 使用 Capacitor Filesystem，Android 禁用
 */

import { Preferences } from '@capacitor/preferences'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Capacitor } from '@capacitor/core'
import { CapacitorHttp } from '@capacitor/core'
import WebDav from '@renderer/capacitor-bridge/webdav-native'
import type {
  CloudStorageConfig,
  CloudBackupInfo,
  CloudBackupResult,
  CloudRestoreResult,
  CloudFileInfo
} from '@shared/types/cloud-backup'
import {
  CLOUD_BACKUP_DIR,
  CLOUD_SYNC_MANIFEST_BACKUP_FILE,
  CLOUD_SYNC_MANIFEST_FILE,
  getCloudBackupDirectoryPath,
  getCloudBackupFilePath,
  getCloudSyncManifestBackupPath,
  getCloudSyncManifestPath,
  isCloudBackupFileName,
  joinCloudPath,
  normalizeCloudPath
} from '@shared/cloud-backup-paths'
import type { CloudSyncManifest } from '@shared/cloud-sync-manifest'
import {
  assertValidCloudSyncManifest,
  normalizeCloudSyncManifest,
  readCloudSyncManifestWithFallback
} from '@shared/cloud-sync-manifest'
import {
  createBackupPayload,
  parseBackupPayload
} from '@shared/backup-integrity'

const STORAGE_KEYS = {
  CONFIGS: 'cloud_backup_configs'
}

export class MobileCloudBackupService {
  private static instance: MobileCloudBackupService

  private constructor() {
    // Singleton service.
  }

  static getInstance(): MobileCloudBackupService {
    if (!MobileCloudBackupService.instance) {
      MobileCloudBackupService.instance = new MobileCloudBackupService()
    }
    return MobileCloudBackupService.instance
  }

  /**
   * 检查 iCloud 是否可用（仅 iOS）
   */
  async isICloudAvailable(): Promise<{ available: boolean; reason?: string }> {
    const platform = Capacitor.getPlatform()

    if (platform === 'android') {
      return {
        available: false,
        reason: 'Android 平台暂不支持 iCloud Drive'
      }
    }

    if (platform === 'ios') {
      // iOS 平台检查 iCloud 容器是否可用
      try {
        // 尝试访问 iCloud 目录
        await Filesystem.readdir({
          path: '',
          directory: Directory.Library
        })
        return { available: true }
      } catch (error) {
        return {
          available: false,
          reason: 'iCloud Drive 未启用或不可访问'
        }
      }
    }

    return {
      available: false,
      reason: '不支持的平台'
    }
  }

  /**
   * 获取所有存储配置
   */
  async getStorageConfigs(): Promise<CloudStorageConfig[]> {
    try {
      const { value } = await Preferences.get({ key: STORAGE_KEYS.CONFIGS })
      if (!value) return []
      return JSON.parse(value)
    } catch (error) {
      console.error('获取存储配置失败:', error)
      throw new Error(`获取存储配置失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  private async getStorageConfigOrThrow(storageId: string): Promise<CloudStorageConfig> {
    const configs = await this.getStorageConfigs()
    const config = configs.find(c => c.id === storageId)
    if (!config) {
      throw new Error('存储配置不存在')
    }
    return config
  }

  /**
   * 添加存储配置
   */
  async addStorageConfig(config: Omit<CloudStorageConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<{
    success: boolean
    config?: CloudStorageConfig
    error?: string
  }> {
    try {
      // 如果是 iCloud 配置，检查平台支持
      if (config.type === 'icloud') {
        const icloudCheck = await this.isICloudAvailable()
        if (!icloudCheck.available) {
          return {
            success: false,
            error: icloudCheck.reason || 'iCloud 不可用'
          }
        }
      }

      const configs = await this.getStorageConfigs()

      const newConfig: CloudStorageConfig = {
        ...config,
        id: this.generateId(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }

      configs.push(newConfig)
      await Preferences.set({
        key: STORAGE_KEYS.CONFIGS,
        value: JSON.stringify(configs)
      })

      return { success: true, config: newConfig }
    } catch (error) {
      console.error('添加存储配置失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '添加失败'
      }
    }
  }

  /**
   * 更新存储配置
   */
  async updateStorageConfig(id: string, updates: Partial<CloudStorageConfig>): Promise<{
    success: boolean
    config?: CloudStorageConfig
    error?: string
  }> {
    try {
      const configs = await this.getStorageConfigs()
      const index = configs.findIndex(c => c.id === id)

      if (index === -1) {
        return { success: false, error: '配置不存在' }
      }

      const updatedConfig = {
        ...configs[index],
        ...updates,
        id,
        updatedAt: new Date().toISOString()
      }

      configs[index] = updatedConfig
      await Preferences.set({
        key: STORAGE_KEYS.CONFIGS,
        value: JSON.stringify(configs)
      })

      return { success: true, config: updatedConfig }
    } catch (error) {
      console.error('更新存储配置失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '更新失败'
      }
    }
  }

  /**
   * 删除存储配置
   */
  async deleteStorageConfig(id: string): Promise<{
    success: boolean
    error?: string
  }> {
    try {
      const configs = await this.getStorageConfigs()
      const filtered = configs.filter(c => c.id !== id)

      await Preferences.set({
        key: STORAGE_KEYS.CONFIGS,
        value: JSON.stringify(filtered)
      })

      return { success: true }
    } catch (error) {
      console.error('删除存储配置失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '删除失败'
      }
    }
  }

  /**
   * 测试存储连接
   */
  async testStorageConnection(config: CloudStorageConfig): Promise<{
    success: boolean
    error?: string
  }> {
    try {
      if (config.type === 'webdav') {
        return await this.testWebDAVConnection(config as any)
      } else if (config.type === 'icloud') {
        return await this.testICloudConnection(config as any)
      }

      return { success: false, error: '不支持的存储类型' }
    } catch (error) {
      console.error('测试连接失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '测试失败'
      }
    }
  }

  /**
   * 测试 WebDAV 连接
   */
  private async testWebDAVConnection(config: any): Promise<{
    success: boolean
    error?: string
  }> {
    try {
      if (!config.url || !config.username || !config.password) {
        return { success: false, error: 'WebDAV 配置不完整' }
      }

      // 使用 OPTIONS 测试连接（Android CapacitorHttp 不支持 PROPFIND）
      const response = await CapacitorHttp.request({
        url: this.normalizeBaseUrl(config.url),
        method: 'OPTIONS',
        headers: {
          'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`)
        }
      })

      // 401/403 → 凭据错误；2xx / 多数 WebDAV 服务会返回 200
      if (response.status === 401 || response.status === 403) {
        return { success: false, error: '认证失败，请检查用户名和密码' }
      }

      if (response.status >= 200 && response.status < 300) {
        return { success: true }
      }

      return {
        success: false,
        error: `连接失败: HTTP ${response.status}`
      }
    } catch (error) {
      console.error('WebDAV 连接测试失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '连接失败'
      }
    }
  }

  /**
   * 测试 iCloud 连接
   */
  private async testICloudConnection(config: any): Promise<{
    success: boolean
    error?: string
  }> {
    const icloudCheck = await this.isICloudAvailable()
    if (!icloudCheck.available) {
      return {
        success: false,
        error: icloudCheck.reason
      }
    }

    if (!config.path) {
      return { success: false, error: 'iCloud 路径不能为空' }
    }

    return { success: true }
  }

  /**
   * 获取云端备份列表
   */
  async getCloudBackupList(storageId: string): Promise<CloudBackupInfo[]> {
    try {
      const configs = await this.getStorageConfigs()
      const config = configs.find(c => c.id === storageId)

      if (!config) {
        throw new Error('存储配置不存在')
      }

      if (config.type === 'webdav') {
        return await this.listWebDAVBackups(config as any)
      } else if (config.type === 'icloud') {
        return await this.listICloudBackups(config as any)
      }

      return []
    } catch (error) {
      console.error('获取备份列表失败:', error)
      throw error
    }
  }

  /**
   * 获取云同步 manifest。文件不存在时返回空 manifest，表示首次同步。
   */
  async getCloudSyncManifest(storageId: string): Promise<CloudSyncManifest> {
    const config = await this.getStorageConfigOrThrow(storageId)

    if (config.type === 'webdav') {
      return this.getWebDAVSyncManifest(config as any)
    }

    if (config.type === 'icloud') {
      return this.getICloudSyncManifest(config as any)
    }

    throw new Error('不支持的存储类型')
  }

  /**
   * 保存云同步 manifest。
   */
  async saveCloudSyncManifest(storageId: string, manifest: CloudSyncManifest): Promise<{
    success: boolean
    error?: string
  }> {
    try {
      const config = await this.getStorageConfigOrThrow(storageId)
      const normalizedManifest = normalizeCloudSyncManifest({
        ...manifest,
        updatedAt: new Date().toISOString()
      })

      if (config.type === 'webdav') {
        await this.saveWebDAVSyncManifest(config as any, normalizedManifest)
        return { success: true }
      }

      if (config.type === 'icloud') {
        await this.saveICloudSyncManifest(config as any, normalizedManifest)
        return { success: true }
      }

      return { success: false, error: '不支持的存储类型' }
    } catch (error) {
      console.error('保存云同步 manifest 失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '保存云同步 manifest 失败'
      }
    }
  }

  /**
   * 列出 WebDAV 备份
   * Android：使用自定义原生插件（OkHttp），绕过 HttpURLConnection 的方法白名单和 CORS 限制
   * iOS/桌面：使用 CapacitorHttp（原生层，支持 PROPFIND）
   */
  private async listWebDAVBackups(config: any): Promise<CloudBackupInfo[]> {
    try {
      const standardBackups = await this.discoverWebDAVBackupsViaPropfind(
        config,
        this.getWebDAVBackupBaseUrl(config),
        'standard'
      )
      const legacyBackups = this.isWebDAVUrlAtBackupDir(config.url)
        ? []
        : await this.discoverWebDAVBackupsViaPropfind(config, this.normalizeBaseUrl(config.url), 'legacy')

      return this.dedupeBackups([...standardBackups, ...legacyBackups])
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    } catch (error) {
      console.error('列出 WebDAV 备份失败:', error)
      throw error
    }
  }

  /**
   * 通过 PROPFIND 发现 WebDAV 目录中的备份文件并读取元数据
   * Android：使用自定义原生插件（OkHttp），支持 PROPFIND 且不受 CORS 限制
   * iOS/桌面：使用 CapacitorHttp（原生层，同样不受 CORS 限制，且 iOS 不在 HttpURLConnection 白名单限制下）
   */
  private async discoverWebDAVBackupsViaPropfind(
    config: any,
    baseUrl: string,
    layout: 'standard' | 'legacy'
  ): Promise<CloudBackupInfo[]> {
    const platform = Capacitor.getPlatform()

    let xmlData: string
    let status: number

    if (platform === 'android') {
      // Android：通过 OkHttp 原生插件执行 PROPFIND
      // CapacitorHttp 底层 HttpURLConnection 白名单不含 PROPFIND，fetch() 受 CORS 限制
      // OkHttp 原生请求支持任意方法且绕过 CORS
      const response = await WebDav.propfind({
        url: baseUrl,
        username: config.username,
        password: config.password,
        depth: 1
      })
      status = response.status
      xmlData = response.body
    } else {
      // iOS / 桌面：CapacitorHttp 原生请求，支持 PROPFIND
      const response = await CapacitorHttp.request({
        url: baseUrl,
        method: 'PROPFIND',
        headers: {
          'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`),
          'Depth': '1',
          'Content-Type': 'application/xml'
        }
      })
      status = response.status
      xmlData = response.data
    }

    if (status === 404) {
      return []
    }

    if (status !== 207) {
      console.warn('WebDAV PROPFIND 失败，状态码:', status)
      return []
    }

    const files = this.parseWebDAVResponse(xmlData, baseUrl)
    const backupFiles = files.filter(file => isCloudBackupFileName(file.name))

    const backups: CloudBackupInfo[] = []
    for (const file of backupFiles) {
      try {
        const fileUrl = this.joinUrlPath(baseUrl, file.path)

        const fileResponse = await CapacitorHttp.request({
          url: fileUrl,
          method: 'GET',
          headers: {
            'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`)
          }
        })

        if (fileResponse.status === 200) {
          let backupData
          let checksum: string | undefined
          let actualSize = 0

          if (typeof fileResponse.data === 'string') {
            actualSize = new Blob([fileResponse.data]).size
            const parsed = parseBackupPayload(JSON.parse(fileResponse.data))
            backupData = parsed.payload
            checksum = parsed.checksum
          } else if (typeof fileResponse.data === 'object') {
            const jsonString = JSON.stringify(fileResponse.data)
            actualSize = new Blob([jsonString]).size
            const parsed = parseBackupPayload(fileResponse.data)
            backupData = parsed.payload
            checksum = parsed.checksum
          } else {
            continue
          }

          backups.push({
            id: backupData.id,
            name: backupData.name,
            description: backupData.description,
            createdAt: backupData.createdAt,
            size: actualSize,
            cloudPath: layout === 'standard'
              ? getCloudBackupFilePath(file.name)
              : joinCloudPath(file.name),
            storageId: config.id,
            checksum
          })
        } else {
          console.warn('读取备份文件失败，状态码:', fileResponse.status, file.name)
        }
      } catch (error) {
        console.warn('解析备份文件失败:', file.name, error)
      }
    }

    return backups
  }

  private async getWebDAVSyncManifest(config: any): Promise<CloudSyncManifest> {
    return readCloudSyncManifestWithFallback({
      readPrimary: () => this.readWebDAVSyncManifestFile(config, getCloudSyncManifestPath()),
      readBackup: () => this.readWebDAVSyncManifestFile(config, getCloudSyncManifestBackupPath()),
      isNotFoundError: error => this.isNotFoundError(error),
      describeError: error => this.formatErrorMessage(error)
    })
  }

  private async readWebDAVSyncManifestFile(config: any, cloudPath: string): Promise<CloudSyncManifest> {
    const response = await CapacitorHttp.request({
      url: this.buildWebDAVUrlFromCloudPath(config, cloudPath),
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`)
      }
    })

    if (response.status === 404) {
      throw new Error(`云同步 manifest 不存在（HTTP ${response.status}）`)
    }

    if (response.status !== 200) {
      throw new Error(`读取云同步 manifest 失败（HTTP ${response.status}）`)
    }

    const data = typeof response.data === 'string'
      ? JSON.parse(response.data)
      : response.data
    return assertValidCloudSyncManifest(data)
  }

  private async saveWebDAVSyncManifest(config: any, manifest: CloudSyncManifest): Promise<void> {
    await this.ensureWebDAVBackupDirectory(config)

    await this.writeWebDAVSyncManifestFile(config, getCloudSyncManifestPath(), manifest)
    await this.writeWebDAVSyncManifestFile(config, getCloudSyncManifestBackupPath(), manifest)
  }

  private async writeWebDAVSyncManifestFile(
    config: any,
    cloudPath: string,
    manifest: CloudSyncManifest
  ): Promise<void> {
    const response = await CapacitorHttp.request({
      url: this.buildWebDAVUrlFromCloudPath(config, cloudPath),
      method: 'PUT',
      headers: {
        'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`),
        'Content-Type': 'application/json'
      },
      data: JSON.stringify(manifest, null, 2)
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`保存云同步 manifest 失败（HTTP ${response.status}）`)
    }
  }

  /**
   * 列出 iCloud 备份
   */
  private async listICloudBackups(config: any): Promise<CloudBackupInfo[]> {
    try {
      const icloudCheck = await this.isICloudAvailable()
      if (!icloudCheck.available) {
        throw new Error(icloudCheck.reason)
      }

      const dirPath = config.path || CLOUD_BACKUP_DIR

      // 检查目录是否存在
      let dirExists = false
      try {
        await Filesystem.stat({
          path: dirPath,
          directory: Directory.Documents
        })
        dirExists = true
        console.log('iCloud 目录已存在:', dirPath)
      } catch (error) {
        console.log('iCloud 目录不存在，需要创建:', dirPath)
      }

      // 只在目录不存在时创建
      if (!dirExists) {
        try {
          await Filesystem.mkdir({
            path: dirPath,
            directory: Directory.Documents,
            recursive: true
          })
          console.log('iCloud 目录创建成功:', dirPath)
        } catch (error: any) {
          console.error('创建 iCloud 目录失败:', error)
          // 如果创建失败，可能是权限问题或其他错误
          throw new Error(`无法创建 iCloud 目录: ${error.message || error}`)
        }
      }

      // 读取 iCloud 目录
      let result
      try {
        result = await Filesystem.readdir({
          path: dirPath,
          directory: Directory.Documents
        })
        console.log('读取 iCloud 目录成功，文件数量:', result.files.length)
      } catch (error: any) {
        console.error('读取 iCloud 目录失败:', error)
        // 如果目录为空或刚创建，返回空数组
        return []
      }

      const backups: CloudBackupInfo[] = []

      for (const file of result.files) {
        if (file.name && isCloudBackupFileName(file.name)) {
          try {
            // 读取备份文件
            const fileResult = await Filesystem.readFile({
              path: `${dirPath}/${file.name}`,
              directory: Directory.Documents,
              encoding: Encoding.UTF8
            })

            const parsedBackup = parseBackupPayload(JSON.parse(fileResult.data as string))
            const backupData = parsedBackup.payload
            backups.push({
              id: backupData.id,
              name: backupData.name,
              description: backupData.description,
              createdAt: backupData.createdAt,
              size: file.size || 0,
              cloudPath: `${dirPath}/${file.name}`,
              storageId: config.id,
              checksum: parsedBackup.checksum
            })
          } catch (error) {
            console.warn('解析 iCloud 备份文件失败:', file.name, error)
          }
        }
      }

      console.log('iCloud 备份列表加载完成，数量:', backups.length)

      return backups.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
    } catch (error) {
      console.error('列出 iCloud 备份失败:', error)
      throw error
    }
  }

  private async getICloudSyncManifest(config: any): Promise<CloudSyncManifest> {
    const icloudCheck = await this.isICloudAvailable()
    if (!icloudCheck.available) {
      throw new Error(icloudCheck.reason || 'iCloud 不可用')
    }

    const dirPath = config.path || CLOUD_BACKUP_DIR
    await this.ensureICloudDirectory(dirPath)

    return readCloudSyncManifestWithFallback({
      readPrimary: () => this.readICloudSyncManifestFile(dirPath, CLOUD_SYNC_MANIFEST_FILE),
      readBackup: () => this.readICloudSyncManifestFile(dirPath, CLOUD_SYNC_MANIFEST_BACKUP_FILE),
      isNotFoundError: error => this.isNotFoundError(error),
      describeError: error => this.formatErrorMessage(error)
    })
  }

  private async readICloudSyncManifestFile(dirPath: string, fileName: string): Promise<CloudSyncManifest> {
    const result = await Filesystem.readFile({
      path: `${dirPath}/${fileName}`,
      directory: Directory.Documents,
      encoding: Encoding.UTF8
    })

    return assertValidCloudSyncManifest(JSON.parse(result.data as string))
  }

  private async saveICloudSyncManifest(config: any, manifest: CloudSyncManifest): Promise<void> {
    const icloudCheck = await this.isICloudAvailable()
    if (!icloudCheck.available) {
      throw new Error(icloudCheck.reason || 'iCloud 不可用')
    }

    const dirPath = config.path || CLOUD_BACKUP_DIR
    await this.ensureICloudDirectory(dirPath)

    await this.writeICloudSyncManifestFile(dirPath, CLOUD_SYNC_MANIFEST_FILE, manifest)
    await this.writeICloudSyncManifestFile(dirPath, CLOUD_SYNC_MANIFEST_BACKUP_FILE, manifest)
  }

  private async writeICloudSyncManifestFile(
    dirPath: string,
    fileName: string,
    manifest: CloudSyncManifest
  ): Promise<void> {
    await Filesystem.writeFile({
      path: `${dirPath}/${fileName}`,
      data: JSON.stringify(manifest, null, 2),
      directory: Directory.Documents,
      encoding: Encoding.UTF8
    })
  }

  private async ensureICloudDirectory(dirPath: string): Promise<void> {
    try {
      await Filesystem.stat({
        path: dirPath,
        directory: Directory.Documents
      })
    } catch {
      await Filesystem.mkdir({
        path: dirPath,
        directory: Directory.Documents,
        recursive: true
      })
    }
  }

  /**
   * 解析 WebDAV PROPFIND 响应
   * @param xmlData XML 响应数据
   * @param baseUrl WebDAV 服务器基础 URL
   */
  private parseWebDAVResponse(xmlData: string, baseUrl: string): CloudFileInfo[] {
    const files: CloudFileInfo[] = []

    try {
      // 从 baseUrl 中提取路径前缀，用于后续路径标准化
      let baseUrlPath = ''
      try {
        const urlObj = new URL(baseUrl)
        baseUrlPath = urlObj.pathname
        // 移除末尾的斜杠
        if (baseUrlPath.endsWith('/')) {
          baseUrlPath = baseUrlPath.slice(0, -1)
        }
      } catch (e) {
        console.warn('解析 baseUrl 失败:', baseUrl)
      }

      console.log('baseUrl:', baseUrl)
      console.log('baseUrl 路径前缀:', baseUrlPath)

      // 简单的 XML 解析
      const parser = new DOMParser()
      const doc = parser.parseFromString(xmlData, 'text/xml')

      // 尝试不同的命名空间
      let responses = doc.getElementsByTagName('d:response')
      if (responses.length === 0) {
        responses = doc.getElementsByTagName('D:response')
      }
      if (responses.length === 0) {
        responses = doc.getElementsByTagName('response')
      }

      console.log('WebDAV 响应数量:', responses.length)

      for (const response of Array.from(responses)) {
        // 获取 href
        const hrefElement = response.getElementsByTagName('d:href')[0] ||
          response.getElementsByTagName('D:href')[0] ||
          response.getElementsByTagName('href')[0]

        if (!hrefElement) continue

        const href = hrefElement.textContent || ''
        console.log('处理文件 href:', href)

        // 获取 propstat
        const propstat = response.getElementsByTagName('d:propstat')[0] ||
          response.getElementsByTagName('D:propstat')[0] ||
          response.getElementsByTagName('propstat')[0]

        if (!propstat) continue

        // 获取 prop
        const prop = propstat.getElementsByTagName('d:prop')[0] ||
          propstat.getElementsByTagName('D:prop')[0] ||
          propstat.getElementsByTagName('prop')[0]

        if (!prop) continue

        // 检查是否是目录
        const resourcetype = prop.getElementsByTagName('d:resourcetype')[0] ||
          prop.getElementsByTagName('D:resourcetype')[0] ||
          prop.getElementsByTagName('resourcetype')[0]

        let isDirectory = false
        if (resourcetype) {
          const collection = resourcetype.getElementsByTagName('d:collection')[0] ||
            resourcetype.getElementsByTagName('D:collection')[0] ||
            resourcetype.getElementsByTagName('collection')[0]
          isDirectory = !!collection
        }

        // 标准化路径：提取相对于 baseUrl 的路径
        let normalizedPath = href

        // 如果是完整 URL，提取路径部分
        if (href.startsWith('http://') || href.startsWith('https://')) {
          try {
            const hrefUrl = new URL(href)
            normalizedPath = hrefUrl.pathname
          } catch (e) {
            console.warn('解析 href URL 失败:', href)
          }
        }

        // 确保路径以 / 开头
        if (!normalizedPath.startsWith('/')) {
          normalizedPath = '/' + normalizedPath
        }

        // URL 解码
        normalizedPath = decodeURIComponent(normalizedPath)

        console.log('解码后的路径:', normalizedPath)
        console.log('baseUrlPath:', baseUrlPath)

        // 移除 baseUrl 的路径前缀，得到相对路径
        if (baseUrlPath && normalizedPath.startsWith(baseUrlPath)) {
          normalizedPath = normalizedPath.substring(baseUrlPath.length)
          console.log('移除前缀后的路径:', normalizedPath)
          // 确保以 / 开头
          if (!normalizedPath.startsWith('/')) {
            normalizedPath = '/' + normalizedPath
          }
        }

        // 提取文件名
        const name = normalizedPath.split('/').filter(Boolean).pop() || ''

        // 获取文件大小
        const contentlength = prop.getElementsByTagName('d:getcontentlength')[0] ||
          prop.getElementsByTagName('D:getcontentlength')[0] ||
          prop.getElementsByTagName('getcontentlength')[0] ||
          prop.getElementsByTagName('lp1:getcontentlength')[0] ||
          prop.getElementsByTagName('lp2:getcontentlength')[0]

        let size = 0
        if (contentlength && contentlength.textContent) {
          size = parseInt(contentlength.textContent, 10)
          console.log('从 XML 解析文件大小:', name, size)
        }

        // 获取修改时间
        const lastmodified = prop.getElementsByTagName('d:getlastmodified')[0] ||
          prop.getElementsByTagName('D:getlastmodified')[0] ||
          prop.getElementsByTagName('getlastmodified')[0]
        const modifiedAt = lastmodified ? (lastmodified.textContent || '') : new Date().toISOString()

        // 跳过目录本身和空文件名
        if (name && !isDirectory && normalizedPath !== '/' && normalizedPath !== '') {
          console.log('添加文件:', name, 'path:', normalizedPath, 'size:', size)
          files.push({
            name,
            path: normalizedPath, // 使用标准化的相对路径
            size,
            isDirectory,
            modifiedAt
          })
        }
      }

      console.log('解析到的文件数量:', files.length)
    } catch (error) {
      console.error('解析 WebDAV 响应失败:', error)
    }

    return files
  }

  /**
   * 创建云端备份
   */
  async createCloudBackup(
    storageId: string,
    data: any,
    description?: string
  ): Promise<CloudBackupResult> {
    try {
      const configs = await this.getStorageConfigs()
      const config = configs.find(c => c.id === storageId)

      if (!config) {
        return {
          success: false,
          message: '存储配置不存在',
          error: '存储配置不存在'
        }
      }

      const backupId = this.generateId()
      const timestamp = new Date().toISOString()
      // 使用与桌面端一致的命名格式：backup-YYYY-MM-DD-xxxxxxxx
      const backupName = `backup-${timestamp.split('T')[0]}-${backupId.substring(0, 8)}`

      const backupData = createBackupPayload({
        id: backupId,
        name: backupName,
        description: description || '移动端云端备份',
        createdAt: timestamp,
        data
      })

      const jsonString = JSON.stringify(backupData, null, 2)
      // 文件名使用完整的 backup-{id}.json 格式
      const fileName = `backup-${backupId}.json`

      if (config.type === 'webdav') {
        return await this.createWebDAVBackup(config as any, fileName, jsonString, backupData)
      } else if (config.type === 'icloud') {
        return await this.createICloudBackup(config as any, fileName, jsonString, backupData)
      }

      return {
        success: false,
        message: '不支持的存储类型',
        error: '不支持的存储类型'
      }
    } catch (error) {
      console.error('创建云端备份失败:', error)
      return {
        success: false,
        message: '创建云端备份失败',
        error: error instanceof Error ? error.message : '未知错误'
      }
    }
  }

  /**
   * 创建 WebDAV 备份
   */
  private async createWebDAVBackup(
    config: any,
    fileName: string,
    jsonString: string,
    backupData: any
  ): Promise<CloudBackupResult> {
    try {
      console.log('创建 WebDAV 备份，文件名:', fileName)

      await this.ensureWebDAVBackupDirectory(config)

      const cloudPath = getCloudBackupFilePath(fileName)
      const fileUrl = this.buildWebDAVUrlFromCloudPath(config, cloudPath)
      console.log('上传到 URL:', fileUrl)
      const response = await CapacitorHttp.request({
        url: fileUrl,
        method: 'PUT',
        headers: {
          'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`),
          'Content-Type': 'application/json'
        },
        data: jsonString
      })

      console.log('上传响应状态:', response.status)
      if (response.status >= 200 && response.status < 300) {
        const backupInfo: CloudBackupInfo = {
          id: backupData.id,
          name: backupData.name,
          description: backupData.description,
          createdAt: backupData.createdAt,
          size: new Blob([jsonString]).size,
          cloudPath,
          storageId: config.id,
          checksum: backupData.checksum
        }

        console.log('备份创建成功:', backupInfo)

        return {
          success: true,
          message: '云端备份创建成功',
          backupInfo
        }
      }

      const uploadErrMsg = response.status === 401 || response.status === 403
        ? '认证失败，请检查用户名和密码'
        : response.status === 404 || response.status === 409
          ? '目标目录不存在，请确认 WebDAV 服务器路径配置正确'
          : `上传备份失败（HTTP ${response.status}）`
      return {
        success: false,
        message: uploadErrMsg,
        error: uploadErrMsg
      }
    } catch (error) {
      console.error('创建 WebDAV 备份失败:', error)
      throw error
    }
  }

  /**
   * 创建 iCloud 备份
   */
  private async createICloudBackup(
    config: any,
    fileName: string,
    jsonString: string,
    backupData: any
  ): Promise<CloudBackupResult> {
    try {
      const icloudCheck = await this.isICloudAvailable()
      if (!icloudCheck.available) {
        return {
          success: false,
          message: icloudCheck.reason || 'iCloud 不可用',
          error: icloudCheck.reason
        }
      }

      const dirPath = config.path || CLOUD_BACKUP_DIR

      // 检查目录是否存在
      let dirExists = false
      try {
        await Filesystem.stat({
          path: dirPath,
          directory: Directory.Documents
        })
        dirExists = true
        console.log('iCloud 目录已存在:', dirPath)
      } catch (error) {
        console.log('iCloud 目录不存在，需要创建:', dirPath)
      }

      // 只在目录不存在时创建
      if (!dirExists) {
        try {
          await Filesystem.mkdir({
            path: dirPath,
            directory: Directory.Documents,
            recursive: true
          })
          console.log('iCloud 目录创建成功:', dirPath)
        } catch (error: any) {
          console.error('创建 iCloud 目录失败:', error)
          return {
            success: false,
            message: '无法创建 iCloud 目录',
            error: error.message || String(error)
          }
        }
      }

      // 写入备份文件
      await Filesystem.writeFile({
        path: `${dirPath}/${fileName}`,
        data: jsonString,
        directory: Directory.Documents,
        encoding: Encoding.UTF8
      })

      const backupInfo: CloudBackupInfo = {
        id: backupData.id,
        name: backupData.name,
        description: backupData.description,
        createdAt: backupData.createdAt,
        size: new Blob([jsonString]).size,
        cloudPath: `${dirPath}/${fileName}`,
        storageId: config.id,
        checksum: backupData.checksum
      }

      return {
        success: true,
        message: '云端备份创建成功',
        backupInfo
      }
    } catch (error) {
      console.error('创建 iCloud 备份失败:', error)
      return {
        success: false,
        message: '创建 iCloud 备份失败',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 恢复云端备份
   */
  async restoreCloudBackup(storageId: string, backupId: string): Promise<CloudRestoreResult> {
    try {
      const configs = await this.getStorageConfigs()
      const config = configs.find(c => c.id === storageId)

      if (!config) {
        return {
          success: false,
          message: '存储配置不存在',
          error: '存储配置不存在'
        }
      }

      if (config.type === 'webdav') {
        return await this.restoreWebDAVBackup(config as any, backupId)
      } else if (config.type === 'icloud') {
        return await this.restoreICloudBackup(config as any, backupId)
      }

      return {
        success: false,
        message: '不支持的存储类型',
        error: '不支持的存储类型'
      }
    } catch (error) {
      console.error('恢复云端备份失败:', error)
      return {
        success: false,
        message: '恢复云端备份失败',
        error: error instanceof Error ? error.message : '未知错误'
      }
    }
  }

  /**
   * 恢复 WebDAV 备份
   */
  private async restoreWebDAVBackup(config: any, backupId: string): Promise<CloudRestoreResult> {
    try {
      // 获取备份列表找到对应的备份
      const backups = await this.listWebDAVBackups(config)
      const backup = backups.find(b => b.id === backupId)

      if (!backup || !backup.cloudPath) {
        return {
          success: false,
          message: '备份不存在',
          error: '备份不存在'
        }
      }

      // 下载备份文件
      const fileUrl = this.buildWebDAVUrlFromCloudPath(config, backup.cloudPath)

      const response = await CapacitorHttp.request({
        url: fileUrl,
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`)
        }
      })

      if (response.status !== 200) {
        const statusMsg = response.status === 401 || response.status === 403
          ? '认证失败，请检查用户名和密码'
          : response.status === 404
            ? '备份文件不存在，请刷新列表后重试'
            : `下载备份失败（HTTP ${response.status}）`
        return {
          success: false,
          message: statusMsg,
          error: statusMsg
        }
      }

      // CapacitorHttp 可能返回字符串或对象
      let backupData
      if (typeof response.data === 'string') {
        backupData = parseBackupPayload(JSON.parse(response.data)).payload
      } else if (typeof response.data === 'object') {
        backupData = parseBackupPayload(response.data).payload
      } else {
        return {
          success: false,
          message: '响应数据格式错误',
          error: '响应数据格式错误'
        }
      }

      return {
        success: true,
        message: '云端备份恢复成功',
        backupInfo: backup,
        data: backupData.data
      }
    } catch (error) {
      console.error('恢复 WebDAV 备份失败:', error)
      throw error
    }
  }

  /**
   * 恢复 iCloud 备份
   */
  private async restoreICloudBackup(config: any, backupId: string): Promise<CloudRestoreResult> {
    try {
      const icloudCheck = await this.isICloudAvailable()
      if (!icloudCheck.available) {
        return {
          success: false,
          message: icloudCheck.reason || 'iCloud 不可用',
          error: icloudCheck.reason
        }
      }

      // 获取备份列表找到对应的备份
      const backups = await this.listICloudBackups(config)
      const backup = backups.find(b => b.id === backupId)

      if (!backup || !backup.cloudPath) {
        return {
          success: false,
          message: '备份不存在',
          error: '备份不存在'
        }
      }

      // 读取备份文件
      const result = await Filesystem.readFile({
        path: backup.cloudPath,
        directory: Directory.Documents,
        encoding: Encoding.UTF8
      })

      const backupData = parseBackupPayload(JSON.parse(result.data as string)).payload

      return {
        success: true,
        message: '云端备份恢复成功',
        backupInfo: backup,
        data: backupData.data
      }
    } catch (error) {
      console.error('恢复 iCloud 备份失败:', error)
      throw error
    }
  }

  /**
   * 删除云端备份
   */
  async deleteCloudBackup(storageId: string, backupId: string): Promise<{
    success: boolean
    message?: string
    error?: string
  }> {
    try {
      const configs = await this.getStorageConfigs()
      const config = configs.find(c => c.id === storageId)

      if (!config) {
        return { success: false, error: '存储配置不存在' }
      }

      if (config.type === 'webdav') {
        return await this.deleteWebDAVBackup(config as any, backupId)
      } else if (config.type === 'icloud') {
        return await this.deleteICloudBackup(config as any, backupId)
      }

      return { success: false, error: '不支持的存储类型' }
    } catch (error) {
      console.error('删除云端备份失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '删除失败'
      }
    }
  }

  /**
   * 删除 WebDAV 备份
   */
  private async deleteWebDAVBackup(config: any, backupId: string): Promise<{
    success: boolean
    message?: string
    error?: string
  }> {
    try {
      // 获取备份列表找到对应的备份
      const backups = await this.listWebDAVBackups(config)
      const backup = backups.find(b => b.id === backupId)

      if (!backup || !backup.cloudPath) {
        return { success: false, error: '备份不存在' }
      }

      // 删除文件
      const fileUrl = this.buildWebDAVUrlFromCloudPath(config, backup.cloudPath)

      const response = await CapacitorHttp.request({
        url: fileUrl,
        method: 'DELETE',
        headers: {
          'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`)
        }
      })

      if (response.status >= 200 && response.status < 300) {
        return {
          success: true,
          message: '云端备份删除成功'
        }
      }

      const deleteErrMsg = response.status === 401 || response.status === 403
        ? '认证失败，请检查用户名和密码'
        : response.status === 404
          ? '备份文件不存在，可能已被删除'
          : `删除失败（HTTP ${response.status}）`
      return {
        success: false,
        error: deleteErrMsg
      }
    } catch (error) {
      console.error('删除 WebDAV 备份失败:', error)
      throw error
    }
  }

  /**
   * 删除 iCloud 备份
   */
  private async deleteICloudBackup(config: any, backupId: string): Promise<{
    success: boolean
    message?: string
    error?: string
  }> {
    try {
      const icloudCheck = await this.isICloudAvailable()
      if (!icloudCheck.available) {
        return {
          success: false,
          error: icloudCheck.reason
        }
      }

      // 获取备份列表找到对应的备份
      const backups = await this.listICloudBackups(config)
      const backup = backups.find(b => b.id === backupId)

      if (!backup || !backup.cloudPath) {
        return { success: false, error: '备份不存在' }
      }

      // 删除文件
      await Filesystem.deleteFile({
        path: backup.cloudPath,
        directory: Directory.Documents
      })

      return {
        success: true,
        message: '云端备份删除成功'
      }
    } catch (error) {
      console.error('删除 iCloud 备份失败:', error)
      throw error
    }
  }

  /**
   * 规范化 WebDAV base URL，去掉末尾斜杠
   */
  private normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, '')
  }

  private getWebDAVBackupBaseUrl(config: any): string {
    const baseUrl = this.normalizeBaseUrl(config.url)
    return this.isWebDAVUrlAtBackupDir(baseUrl)
      ? baseUrl
      : this.joinUrlPath(baseUrl, CLOUD_BACKUP_DIR)
  }

  private isWebDAVUrlAtBackupDir(url: string): boolean {
    try {
      const parsed = new URL(this.normalizeBaseUrl(url))
      const lastSegment = parsed.pathname.split('/').filter(Boolean).pop()
      return lastSegment === CLOUD_BACKUP_DIR
    } catch {
      return false
    }
  }

  private buildWebDAVUrlFromCloudPath(config: any, cloudPath: string): string {
    const normalizedPath = normalizeCloudPath(cloudPath)
    const backupDirPath = getCloudBackupDirectoryPath()

    if (this.isWebDAVUrlAtBackupDir(config.url) && normalizedPath.startsWith(`${backupDirPath}/`)) {
      return this.joinUrlPath(this.normalizeBaseUrl(config.url), normalizedPath.slice(backupDirPath.length))
    }

    return this.joinUrlPath(this.normalizeBaseUrl(config.url), normalizedPath)
  }

  private joinUrlPath(baseUrl: string, ...parts: string[]): string {
    const suffix = parts
      .flatMap(part => part.split('/'))
      .filter(Boolean)
      .map(part => encodeURIComponent(decodeURIComponent(part)))
      .join('/')

    return suffix ? `${this.normalizeBaseUrl(baseUrl)}/${suffix}` : this.normalizeBaseUrl(baseUrl)
  }

  private async ensureWebDAVBackupDirectory(config: any): Promise<void> {
    const response = await this.sendWebDAVRequest(config, this.getWebDAVBackupBaseUrl(config), 'MKCOL')
    if ([200, 201, 204, 405, 409].includes(response.status)) {
      return
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('认证失败，请检查用户名和密码')
    }
    throw new Error(`创建 WebDAV 备份目录失败（HTTP ${response.status}）`)
  }

  private async sendWebDAVRequest(
    config: any,
    url: string,
    method: string,
    data?: string,
    contentType = 'application/json'
  ): Promise<{ status: number; data?: any }> {
    if (Capacitor.getPlatform() === 'android' && method === 'MKCOL') {
      const response = await WebDav.request({
        url,
        method,
        username: config.username,
        password: config.password,
        body: data,
        contentType
      })
      return { status: response.status, data: response.body }
    }

    return CapacitorHttp.request({
      url,
      method,
      headers: {
        'Authorization': 'Basic ' + btoa(`${config.username}:${config.password}`)
      },
      data
    })
  }

  private dedupeBackups(backups: CloudBackupInfo[]): CloudBackupInfo[] {
    const seen = new Set<string>()
    return backups.filter(backup => {
      const key = backup.id || backup.cloudPath || backup.name
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  private isNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /404|not\s*found|no such file|does not exist|不存在|未找到/i.test(message)
  }

  private formatErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }
}

export const mobileCloudBackupService = MobileCloudBackupService.getInstance()
