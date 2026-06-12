<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button :text="t('common.back')" default-href="/tabs/settings"></ion-back-button>
        </ion-buttons>
        <ion-title>{{ t('cloudBackup.title') }}</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content :fullscreen="true">
      <ion-list>
        <ion-list-header>
          <ion-label>{{ t('cloudBackup.autoSync') }}</ion-label>
        </ion-list-header>
        <ion-item>
          <ion-label>
            <h3>{{ t('cloudBackup.syncInterval') }}</h3>
            <p>{{ t('cloudBackup.syncIntervalDescription', { minutes: syncIntervalMinutes }) }}</p>
          </ion-label>
          <ion-input
            class="sync-interval-input"
            slot="end"
            type="number"
            inputmode="numeric"
            :min="MIN_CLOUD_SYNC_INTERVAL_MINUTES"
            :max="MAX_CLOUD_SYNC_INTERVAL_MINUTES"
            :value="syncIntervalMinutes"
            @ionInput="handleSyncIntervalInput"
          ></ion-input>
        </ion-item>
        <div class="sync-interval-actions">
          <ion-button
            size="small"
            fill="outline"
            @click="saveSyncInterval"
            :disabled="loading.saveSyncInterval"
          >
            {{ t('cloudBackup.saveSyncInterval') }}
          </ion-button>
        </div>
      </ion-list>

      <ion-list class="conflict-log-list">
        <ion-list-header>
          <ion-label>同步冲突记录</ion-label>
          <ion-button
            v-if="conflictLogEntries.length > 0"
            fill="clear"
            size="small"
            @click="clearConflictLog"
          >
            清理
          </ion-button>
        </ion-list-header>
        <ion-item lines="none">
          <ion-label>
            <p>{{ conflictLogSummary }}</p>
          </ion-label>
        </ion-item>
        <template v-if="visibleConflictLogEntries.length > 0">
          <div
            v-for="entry in visibleConflictLogEntries"
            :key="entry.id"
            class="conflict-entry"
          >
            <details>
              <summary>
                <ion-icon :icon="warningOutline"></ion-icon>
                <span>{{ formatConflictEntryTitle(entry) }}</span>
                <ion-badge color="warning">{{ entry.conflicts.length }}</ion-badge>
              </summary>
              <div class="conflict-entry-meta">
                <span>{{ getStorageName(entry.storageId) }}</span>
                <span>本地 {{ entry.localRevision || '空' }}</span>
                <span>远端 {{ entry.remoteRevision || '空' }}</span>
                <span>结果 {{ entry.resolvedRevision || '空' }}</span>
              </div>
              <div
                v-for="(conflict, index) in entry.conflicts"
                :key="`${entry.id}-${index}`"
                class="conflict-record"
              >
                <div class="conflict-record-heading">
                  <ion-badge color="medium">
                    {{ getConflictCollectionLabel(conflict.collection) }}
                  </ion-badge>
                  <strong>{{ getConflictRecordLabel(conflict) }}</strong>
                </div>
                <p>
                  {{ getConflictReasonLabel(conflict.reason) }} ·
                  {{ getConflictResolutionLabel(conflict.resolution) }}
                </p>
                <details class="conflict-values">
                  <summary>查看数据差异</summary>
                  <div class="conflict-value-grid">
                    <div>
                      <span>本地</span>
                      <pre>{{ formatConflictValue(conflict.local) }}</pre>
                    </div>
                    <div>
                      <span>远端</span>
                      <pre>{{ formatConflictValue(conflict.remote) }}</pre>
                    </div>
                    <div>
                      <span>基线</span>
                      <pre>{{ formatConflictValue(conflict.base) }}</pre>
                    </div>
                  </div>
                </details>
              </div>
            </details>
          </div>
        </template>
      </ion-list>

      <!-- 存储配置列表 -->
      <ion-list v-if="storageConfigs.length > 0">
        <ion-list-header>
          <ion-label>{{ t('cloudBackup.storageConfiguration') }}</ion-label>
        </ion-list-header>

        <ion-item-sliding v-for="config in storageConfigs" :key="config.id">
          <ion-item button @click="selectStorage(config)">
            <ion-icon :icon="cloudOutline" slot="start"></ion-icon>
            <ion-label>
              <h3>{{ config.name }}</h3>
              <p>{{ getConfigDescription(config) }}</p>
            </ion-label>
            <ion-badge :color="config.enabled ? 'success' : 'warning'" slot="end">
              {{ config.enabled ? t('cloudBackup.enabled') : t('cloudBackup.disabled') }}
            </ion-badge>
          </ion-item>

          <ion-item-options side="end">
            <ion-item-option color="primary" @click="editConfig(config)">
              <ion-icon :icon="createOutline"></ion-icon>
              {{ t('common.edit') }}
            </ion-item-option>
            <ion-item-option color="danger" @click="deleteConfig(config)">
              <ion-icon :icon="trashOutline"></ion-icon>
              {{ t('common.delete') }}
            </ion-item-option>
          </ion-item-options>
        </ion-item-sliding>
      </ion-list>

      <!-- 无配置提示 -->
      <div v-else class="empty-state">
        <ion-icon :icon="cloudOfflineOutline" size="large"></ion-icon>
        <p>{{ t('cloudBackup.noStorageConfig') }}</p>
      </div>

      <!-- 添加配置按钮 -->
      <ion-fab vertical="bottom" horizontal="end" slot="fixed">
        <ion-fab-button @click="showAddConfigModal = true">
          <ion-icon :icon="addOutline"></ion-icon>
        </ion-fab-button>
      </ion-fab>

      <!-- 添加/编辑配置模态框 -->
      <ion-modal :is-open="showAddConfigModal" @didDismiss="closeConfigModal">
        <ion-header>
          <ion-toolbar>
            <ion-buttons slot="start">
              <ion-button @click="closeConfigModal">{{ t('common.cancel') }}</ion-button>
            </ion-buttons>
            <ion-title>{{ editingConfig ? t('cloudBackup.editConfig') : t('cloudBackup.addStorageConfig') }}</ion-title>
            <ion-buttons slot="end">
              <ion-button @click="saveConfig" :disabled="!isConfigValid">{{ t('common.save') }}</ion-button>
            </ion-buttons>
          </ion-toolbar>
        </ion-header>
        <ion-content>
          <ion-list>
            <ion-item>
              <ion-label position="stacked">{{ t('cloudBackup.configName') }}</ion-label>
              <ion-input v-model="configForm.name" :placeholder="t('cloudBackup.configNamePlaceholder')"></ion-input>
            </ion-item>

            <ion-item>
              <ion-label position="stacked">{{ t('cloudBackup.storageType') }}</ion-label>
              <ion-select v-model="configForm.type" interface="action-sheet">
                <ion-select-option value="webdav">WebDAV</ion-select-option>
                <ion-select-option value="icloud">iCloud Drive</ion-select-option>
              </ion-select>
            </ion-item>

            <!-- WebDAV 配置 -->
            <template v-if="configForm.type === 'webdav'">
              <ion-item>
                <ion-label position="stacked">{{ t('cloudBackup.serverUrl') }}</ion-label>
                <ion-input v-model="configForm.url" placeholder="https://your-webdav-server.com"></ion-input>
              </ion-item>
              <ion-item>
                <ion-label position="stacked">{{ t('cloudBackup.username') }}</ion-label>
                <ion-input v-model="configForm.username" :placeholder="t('cloudBackup.usernamePlaceholder')"></ion-input>
              </ion-item>
              <ion-item>
                <ion-label position="stacked">{{ t('cloudBackup.password') }}</ion-label>
                <ion-input v-model="configForm.password" type="password" :placeholder="t('cloudBackup.passwordPlaceholder')"></ion-input>
              </ion-item>
            </template>

            <!-- iCloud Drive 配置 -->
            <template v-if="configForm.type === 'icloud'">
              <!-- Android 平台不支持提示 -->
              <ion-item v-if="platform === 'android'" lines="none">
                <ion-note color="warning">
                  {{ t('cloudBackup.androidNotSupported') }}
                </ion-note>
              </ion-item>

              <!-- iOS 平台 iCloud 不可用提示 -->
              <ion-item v-else-if="!iCloudAvailable" lines="none">
                <ion-note color="warning">
                  {{ t('cloudBackup.icloudNotAvailable') }}
                </ion-note>
              </ion-item>

              <!-- iCloud 配置表单 -->
              <template v-else>
                <ion-item>
                  <ion-label position="stacked">{{ t('cloudBackup.icloudPath') }}</ion-label>
                  <ion-input v-model="configForm.path" placeholder="AI-Gist-Backup"></ion-input>
                </ion-item>
                <ion-note class="ion-padding">
                  {{ t('cloudBackup.icloudPathNote') }}
                </ion-note>
              </template>
            </template>

            <ion-item>
              <ion-label>{{ t('cloudBackup.enableConfig') }}</ion-label>
              <ion-toggle v-model="configForm.enabled"></ion-toggle>
            </ion-item>

            <ion-item lines="none">
              <ion-button
                expand="block"
                fill="outline"
                class="connection-test-button"
                @click="testConfigConnection"
                :disabled="!isConfigValid || loading.testConnection"
              >
                <ion-spinner v-if="loading.testConnection" slot="start"></ion-spinner>
                {{ t('aiConfig.connectionTest') }}
              </ion-button>
            </ion-item>
          </ion-list>
        </ion-content>
      </ion-modal>

      <!-- 备份管理模态框 -->
      <ion-modal :is-open="showBackupModal" @didDismiss="showBackupModal = false">
        <ion-header>
          <ion-toolbar>
            <ion-buttons slot="start">
              <ion-button @click="showBackupModal = false">{{ t('common.close') }}</ion-button>
            </ion-buttons>
            <ion-title>{{ selectedConfig?.name }}</ion-title>
            <ion-buttons slot="end">
              <ion-button @click="refreshBackupList">
                <ion-icon :icon="refreshOutline"></ion-icon>
              </ion-button>
            </ion-buttons>
          </ion-toolbar>
        </ion-header>
        <ion-content>
          <!-- 操作按钮 -->
          <div class="action-buttons">
            <ion-button expand="block" @click="createBackup" :disabled="loading.createBackup">
              <ion-icon :icon="cloudUploadOutline" slot="start"></ion-icon>
              {{ t('cloudBackup.createCloudBackup') }}
            </ion-button>
            <ion-button expand="block" fill="outline" @click="syncCloudData" :disabled="loading.syncNow">
              <ion-icon :icon="syncOutline" slot="start"></ion-icon>
              {{ t('cloudBackup.syncNow') }}
            </ion-button>
          </div>

          <!-- 备份列表 -->
          <ion-list v-if="currentBackups.length > 0">
            <ion-list-header>
              <ion-label>{{ t('cloudBackup.cloudBackupList') }}</ion-label>
            </ion-list-header>

            <ion-item-sliding v-for="backup in currentBackups" :key="backup.id">
              <ion-item>
                <ion-icon :icon="documentOutline" slot="start"></ion-icon>
                <ion-label>
                  <h3>{{ backup.name }}</h3>
                  <p>{{ backup.description }}</p>
                  <p>{{ formatDate(backup.createdAt) }} · {{ formatSize(backup.size) }}</p>
                </ion-label>
                <ion-button slot="end" color="primary" @click="restoreBackup(backup)">
                  <ion-icon :icon="downloadOutline" slot="start"></ion-icon>
                  {{ t('cloudBackup.restore') }}
                </ion-button>
              </ion-item>

              <ion-item-options side="end">
                <ion-item-option color="danger" @click="deleteBackup(backup)">
                  <ion-icon :icon="trashOutline"></ion-icon>
                  {{ t('cloudBackup.delete') }}
                </ion-item-option>
              </ion-item-options>
            </ion-item-sliding>
          </ion-list>

          <!-- 无备份提示 -->
          <div v-else class="empty-state">
            <ion-icon :icon="folderOpenOutline" size="large"></ion-icon>
            <p>{{ t('cloudBackup.noCloudBackups') }}</p>
          </div>
        </ion-content>
      </ion-modal>
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { Capacitor } from '@capacitor/core'
import {
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonBackButton,
  IonButton,
  IonList,
  IonListHeader,
  IonItem,
  IonLabel,
  IonIcon,
  IonBadge,
  IonFab,
  IonFabButton,
  IonModal,
  IonInput,
  IonSelect,
  IonSelectOption,
  IonToggle,
  IonNote,
  IonItemSliding,
  IonItemOptions,
  IonItemOption,
  IonSpinner,
  alertController,
  loadingController
} from '@ionic/vue'
import {
  cloudOutline,
  cloudOfflineOutline,
  addOutline,
  cloudUploadOutline,
  downloadOutline,
  trashOutline,
  documentOutline,
  folderOpenOutline,
  refreshOutline,
  createOutline,
  syncOutline,
  warningOutline
} from 'ionicons/icons'
import { useI18n } from '~/composables/useI18n'
import { mobileCloudBackupService } from '~/lib/services/mobile-cloud-backup.service'
import {
  cloudSyncService,
  DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES,
  MAX_CLOUD_SYNC_INTERVAL_MINUTES,
  MIN_CLOUD_SYNC_INTERVAL_MINUTES,
  getCloudSyncResultMessage,
  getFriendlyCloudSyncError
} from '~/lib/services/cloud-sync.service'
import { databaseService } from '~/lib/db'
import { presentMobileToast } from '~/lib/utils/mobile-toast'
import type { CloudStorageConfig, CloudBackupInfo } from '@shared/types/cloud-backup'
import type { CloudSyncConflictLogEntry } from '~/lib/services/cloud-sync.service'

const { t } = useI18n()
const router = useRouter()
const platform = Capacitor.getPlatform()

const storageConfigs = ref<CloudStorageConfig[]>([])
const currentBackups = ref<CloudBackupInfo[]>([])
const conflictLogEntries = ref<CloudSyncConflictLogEntry[]>([])
const syncIntervalMinutes = ref(DEFAULT_CLOUD_SYNC_INTERVAL_MINUTES)
const selectedConfig = ref<CloudStorageConfig | null>(null)
const editingConfig = ref<CloudStorageConfig | null>(null)
const iCloudAvailable = ref(false)

const showAddConfigModal = ref(false)
const showBackupModal = ref(false)
let unsubscribeSyncStatus: (() => void) | null = null

const configForm = ref({
  name: '',
  type: 'webdav' as 'webdav' | 'icloud',
  enabled: true,
  url: '',
  username: '',
  password: '',
  path: 'AI-Gist-Backup'
})

const loading = ref({
  createBackup: false,
  restoreBackup: false,
  syncNow: false,
  saveSyncInterval: false,
  testConnection: false
})

const isConfigValid = computed(() => {
  if (!configForm.value.name.trim()) return false

  if (configForm.value.type === 'webdav') {
    return !!(configForm.value.url.trim() && configForm.value.username.trim() && configForm.value.password)
  } else if (configForm.value.type === 'icloud') {
    // Android 不支持 iCloud
    if (platform === 'android') return false
    // iOS 需要 iCloud 可用
    if (!iCloudAvailable.value) return false
    return !!configForm.value.path.trim()
  }

  return false
})

const visibleConflictLogEntries = computed(() => conflictLogEntries.value)

const conflictLogSummary = computed(() => {
  if (visibleConflictLogEntries.value.length === 0) {
    return '自动合并后的冲突会保存在这里'
  }

  const conflictCount = visibleConflictLogEntries.value
    .reduce((total, entry) => total + entry.conflicts.length, 0)
  return `${visibleConflictLogEntries.value.length} 次同步，${conflictCount} 项冲突`
})

const handleSyncIntervalInput = (event: CustomEvent<{ value?: string | number | null }>) => {
  const value = Number(event.detail?.value)
  if (Number.isFinite(value)) {
    syncIntervalMinutes.value = value
  }
}

const loadSyncInterval = async () => {
  syncIntervalMinutes.value = await cloudSyncService.getAutoSyncIntervalMinutes()
}

const saveSyncInterval = async () => {
  loading.value.saveSyncInterval = true
  try {
    syncIntervalMinutes.value = await cloudSyncService.setAutoSyncIntervalMinutes(syncIntervalMinutes.value)
    await showToast(t('cloudBackup.saveSyncIntervalSuccess', { minutes: syncIntervalMinutes.value }))
  } catch (error) {
    console.error('保存自动同步频率失败:', error)
    await showToast(t('cloudBackup.saveSyncIntervalFailed'), 'danger')
  } finally {
    loading.value.saveSyncInterval = false
  }
}

const loadConflictLog = () => {
  conflictLogEntries.value = cloudSyncService.getConflictLog()
}

const clearConflictLog = async () => {
  cloudSyncService.clearConflictLog()
  loadConflictLog()
  await showToast('同步冲突记录已清理')
}

// 检查 iCloud 可用性
const checkICloudAvailability = async () => {
  try {
    const result = await mobileCloudBackupService.isICloudAvailable()
    iCloudAvailable.value = result.available
  } catch (error) {
    console.error('检查 iCloud 可用性失败:', error)
    iCloudAvailable.value = false
  }
}

// 加载存储配置
const loadStorageConfigs = async () => {
  try {
    storageConfigs.value = await mobileCloudBackupService.getStorageConfigs()
  } catch (error) {
    console.error('加载存储配置失败:', error)
    showToast(t('cloudBackup.loadConfigsFailed'), 'danger')
  }
}

// 选择存储
const selectStorage = async (config: CloudStorageConfig) => {
  selectedConfig.value = config
  showBackupModal.value = true
  await loadBackupList(config.id)
}

// 编辑配置
const editConfig = (config: CloudStorageConfig) => {
  editingConfig.value = config
  configForm.value = {
    name: config.name,
    type: config.type,
    enabled: config.enabled,
    url: (config as any).url || '',
    username: (config as any).username || '',
    password: (config as any).password || '',
    path: (config as any).path || 'AI-Gist-Backup'
  }
  showAddConfigModal.value = true
}

// 删除配置
const deleteConfig = async (config: CloudStorageConfig) => {
  const alert = await alertController.create({
    header: t('common.confirm'),
    message: t('cloudBackup.confirmDeleteConfig'),
    buttons: [
      {
        text: t('common.cancel'),
        role: 'cancel'
      },
      {
        text: t('common.delete'),
        role: 'destructive',
        handler: async () => {
          await performDeleteConfig(config)
        }
      }
    ]
  })

  await alert.present()
}

// 执行删除配置
const performDeleteConfig = async (config: CloudStorageConfig) => {
  try {
    const result = await mobileCloudBackupService.deleteStorageConfig(config.id)

    if (result.success) {
      showToast(t('cloudBackup.deleteConfigSuccess'))
      await loadStorageConfigs()
    } else {
      showToast(result.error || t('cloudBackup.deleteConfigFailed'), 'danger')
    }
  } catch (error) {
    console.error('删除配置失败:', error)
    showToast(t('cloudBackup.deleteConfigFailed'), 'danger')
  }
}

// 重置配置表单
const resetConfigForm = () => {
  editingConfig.value = null
  configForm.value = {
    name: '',
    type: 'webdav',
    enabled: true,
    url: '',
    username: '',
    password: '',
    path: 'AI-Gist-Backup'
  }
}

// 加载备份列表
const loadBackupList = async (storageId: string) => {
  try {
    currentBackups.value = await mobileCloudBackupService.getCloudBackupList(storageId)
  } catch (error) {
    console.error('加载备份列表失败:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)

    // 如果是 iCloud 目录不存在的错误，显示友好提示
    if (errorMessage.includes('does not exist')) {
      showToast(t('cloudBackup.backupDirectoryCreated'), 'warning')
    } else {
      showToast(t('cloudBackup.loadBackupsFailed') + ': ' + errorMessage, 'danger')
    }

    // 即使失败也设置为空数组，避免界面显示错误
    currentBackups.value = []
  }
}

// 刷新备份列表
const refreshBackupList = async () => {
  if (selectedConfig.value) {
    await loadBackupList(selectedConfig.value.id)
    showToast(t('cloudBackup.refreshSuccess'))
  }
}

// 保存配置
const saveConfig = async () => {
  const loadingEl = await loadingController.create({
    message: t('common.loading')
  })

  try {
    await loadingEl.present()

    const configData = {
      name: configForm.value.name.trim(),
      type: configForm.value.type,
      enabled: configForm.value.enabled,
      ...(configForm.value.type === 'webdav' ? {
        url: configForm.value.url.trim(),
        username: configForm.value.username.trim(),
        password: configForm.value.password
      } : {
        path: configForm.value.path.trim()
      })
    }

    let result
    if (editingConfig.value) {
      result = await mobileCloudBackupService.updateStorageConfig(editingConfig.value.id, configData)
    } else {
      result = await mobileCloudBackupService.addStorageConfig(configData)
    }

    if (result.success) {
      showToast(editingConfig.value ? t('cloudBackup.updateSuccess') : t('cloudBackup.addSuccess'))
      closeConfigModal()
      await loadStorageConfigs()
      if (result.config?.enabled) {
        cloudSyncService.scheduleSync('config-change', {
          storageId: result.config.id,
          delayMs: 0
        })
      }
    } else {
      showToast(result.error || t('cloudBackup.saveFailed'), 'danger')
    }
  } catch (error) {
    console.error('保存配置失败:', error)
    showToast(t('cloudBackup.saveFailed'), 'danger')
  } finally {
    await loadingEl.dismiss()
  }
}

const testConfigConnection = async () => {
  if (!isConfigValid.value) return

  loading.value.testConnection = true
  try {
    const result = await mobileCloudBackupService.testStorageConnection({
      id: editingConfig.value?.id || 'draft',
      createdAt: editingConfig.value?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      name: configForm.value.name.trim(),
      type: configForm.value.type,
      enabled: configForm.value.enabled,
      ...(configForm.value.type === 'webdav' ? {
        url: configForm.value.url.trim(),
        username: configForm.value.username.trim(),
        password: configForm.value.password
      } : {
        path: configForm.value.path.trim()
      })
    } as CloudStorageConfig)

    if (result.success) {
      await showToast(t('aiConfig.connectionTestSuccess'))
    } else {
      await showToast(result.error || t('aiConfig.connectionTestFailed'), 'danger')
    }
  } catch (error) {
    console.error('测试存储连接失败:', error)
    await showToast(t('aiConfig.connectionTestFailed'), 'danger')
  } finally {
    loading.value.testConnection = false
  }
}

// 关闭配置模态框
const closeConfigModal = () => {
  showAddConfigModal.value = false
  resetConfigForm()
}

// 创建备份
const createBackup = async () => {
  if (!selectedConfig.value) return

  const loadingEl = await loadingController.create({
    message: t('cloudBackup.creatingBackup')
  })

  loading.value.createBackup = true

  try {
    await loadingEl.present()

    // 导出数据（备份专用，含图片序列化）
    const exportResult = await databaseService.exportAllDataForBackup()
    if (!exportResult.success) {
      throw new Error(exportResult.error || t('cloudBackup.exportFailed'))
    }

    // 创建云端备份
    const timestamp = new Date().toLocaleString()
    const result = await mobileCloudBackupService.createCloudBackup(
      selectedConfig.value.id,
      exportResult.data,
      `${t('cloudBackup.mobileBackup')} - ${timestamp}`
    )

    if (result.success) {
      showToast(t('cloudBackup.createSuccess'))
      await loadBackupList(selectedConfig.value.id)
    } else {
      const friendlyError = getFriendlyBackupError(result.error)
      showToast(friendlyError, 'danger')
    }
  } catch (error) {
    console.error('创建备份失败:', error)
    const friendlyError = getFriendlyBackupError(error instanceof Error ? error.message : String(error))
    showToast(friendlyError, 'danger')
  } finally {
    await loadingEl.dismiss()
    loading.value.createBackup = false
  }
}

// 立即同步
const syncCloudData = async () => {
  if (!selectedConfig.value) return

  const loadingEl = await loadingController.create({
    message: t('cloudBackup.syncing')
  })

  loading.value.syncNow = true

  try {
    await loadingEl.present()

    const result = await cloudSyncService.syncNow(selectedConfig.value.id, {
      platform,
      deviceName: getDeviceLabel()
    })

    if (result.success) {
      loadConflictLog()
      showToast(getCloudSyncResultMessage(result.action, result.conflicts.length))
    } else {
      showToast(getFriendlyCloudSyncError(result.error), 'danger')
    }
  } catch (error) {
    console.error('云同步失败:', error)
    showToast(getFriendlyCloudSyncError(error instanceof Error ? error.message : String(error)), 'danger')
  } finally {
    await loadingEl.dismiss()
    loading.value.syncNow = false
  }
}

// 恢复备份
const restoreBackup = async (backup: CloudBackupInfo) => {
  const alert = await alertController.create({
    header: t('common.confirm'),
    message: t('cloudBackup.restoreWarning'),
    buttons: [
      {
        text: t('common.cancel'),
        role: 'cancel'
      },
      {
        text: t('common.confirm'),
        handler: async () => {
          await performRestore(backup)
        }
      }
    ]
  })

  await alert.present()
}

// 执行恢复
const performRestore = async (backup: CloudBackupInfo) => {
  const loadingEl = await loadingController.create({
    message: t('cloudBackup.restoringBackup')
  })

  loading.value.restoreBackup = true

  try {
    await loadingEl.present()

    if (!selectedConfig.value) {
      throw new Error(t('cloudBackup.noStorageSelected'))
    }

    // 从云端获取备份数据
    const result = await mobileCloudBackupService.restoreCloudBackup(
      selectedConfig.value.id,
      backup.id
    )

    if (!result.success || !result.data) {
      throw new Error(result.error || t('cloudBackup.restoreFailed'))
    }

    // 恢复到数据库
    const restoreResult = await databaseService.replaceAllData(result.data)

    if (!restoreResult.success) {
      throw new Error(restoreResult.error || t('cloudBackup.restoreFailed'))
    }

    await loadingEl.dismiss()
    showToast(t('cloudBackup.restoreSuccess'))

    // 延迟刷新页面
    setTimeout(() => {
      window.location.reload()
    }, 1000)
  } catch (error) {
    await loadingEl.dismiss()
    console.error('恢复备份失败:', error)
    const friendlyError = getFriendlyRestoreError(error instanceof Error ? error.message : String(error))
    showToast(friendlyError, 'danger')
  } finally {
    loading.value.restoreBackup = false
  }
}

// 删除备份
const deleteBackup = async (backup: CloudBackupInfo) => {
  const alert = await alertController.create({
    header: t('common.confirm'),
    message: t('cloudBackup.confirmDeleteBackup'),
    buttons: [
      {
        text: t('common.cancel'),
        role: 'cancel'
      },
      {
        text: t('common.confirm'),
        handler: async () => {
          await performDelete(backup)
        }
      }
    ]
  })

  await alert.present()
}

// 执行删除
const performDelete = async (backup: CloudBackupInfo) => {
  try {
    if (!selectedConfig.value) return

    const result = await mobileCloudBackupService.deleteCloudBackup(
      selectedConfig.value.id,
      backup.id
    )

    if (result.success) {
      showToast(t('cloudBackup.deleteSuccess'))
      await loadBackupList(selectedConfig.value.id)
    } else {
      showToast(result.error || t('cloudBackup.deleteFailed'), 'danger')
    }
  } catch (error) {
    console.error('删除备份失败:', error)
    showToast(t('cloudBackup.deleteFailed'), 'danger')
  }
}

// 获取配置描述
const getConfigDescription = (config: CloudStorageConfig) => {
  if (config.type === 'webdav') {
    return (config as any).url
  } else {
    return `iCloud Drive - ${(config as any).path || 'AI-Gist-Backup'}`
  }
}

// 格式化日期
const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleString()
}

const getDeviceLabel = () => {
  const language = navigator.language || 'unknown-locale'
  return `${platform}-${language}`
}

const getStorageName = (storageId: string) => {
  return storageConfigs.value.find(config => config.id === storageId)?.name || storageId
}

const formatConflictEntryTitle = (entry: CloudSyncConflictLogEntry) => {
  return `${formatDate(entry.detectedAt)} · ${entry.conflicts.length} 项冲突`
}

const getConflictCollectionLabel = (collection: string) => {
  const labels: Record<string, string> = {
    categories: '分类',
    prompts: '提示词',
    promptVariables: '变量',
    promptHistories: '提示词历史',
    aiConfigs: 'AI 配置',
    quickOptimizationConfigs: '快速优化',
    aiHistory: 'AI 历史',
    settings: '设置',
    syncTombstones: '删除标记'
  }
  return labels[collection] || collection
}

const getConflictReasonLabel = (reason: string) => {
  const labels: Record<string, string> = {
    both_modified: '双方修改',
    create_collision: '同时创建',
    delete_vs_update: '删除与更新'
  }
  return labels[reason] || reason
}

const getConflictResolutionLabel = (resolution: string) => {
  const labels: Record<string, string> = {
    'keep-local': '保留本地',
    'take-remote': '采用远端',
    'take-newer': '采用较新'
  }
  return labels[resolution] || resolution
}

const getConflictRecordLabel = (conflict: any) => {
  const record = conflict.local || conflict.remote || conflict.base || {}
  return record.title || record.name || record.key || conflict.key
}

const formatConflictValue = (value: any) => {
  if (value === undefined) return '无'

  try {
    const text = JSON.stringify(value, null, 2)
    if (!text) return String(value)
    return text.length > 700 ? `${text.slice(0, 700)}...` : text
  } catch (error) {
    return String(value)
  }
}

// 格式化大小
const formatSize = (size: number) => {
  if (!size || isNaN(size) || size <= 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

// 将技术错误转换为用户友好的备份错误提示
const getFriendlyBackupError = (error?: string): string => {
  if (!error) return '备份创建失败，请稍后重试'
  if (error.includes('401') || error.includes('Unauthorized') || error.includes('403')) {
    return '存储服务认证失败，请检查用户名和密码是否正确'
  }
  if (error.includes('404') || error.includes('Not Found')) {
    return '备份目录不存在，请确认 WebDAV 服务器上的路径配置正确'
  }
  if (error.includes('ECONNREFUSED') || error.includes('Network') || error.includes('network') || error.includes('fetch')) {
    return '无法连接到存储服务器，请检查网络连接和服务器地址'
  }
  if (error.includes('timeout') || error.includes('Timeout')) {
    return '连接超时，请检查网络状态或稍后重试'
  }
  if (error.includes('数据库') || error.includes('database')) {
    return '读取本地数据失败，请尝试重启应用后再备份'
  }
  return `备份失败：${error}`
}

// 将技术错误转换为用户友好的恢复错误提示
const getFriendlyRestoreError = (error?: string): string => {
  if (!error) return '恢复失败，请稍后重试'
  if (error.includes('401') || error.includes('Unauthorized') || error.includes('403')) {
    return '存储服务认证失败，请检查用户名和密码是否正确'
  }
  if (error.includes('404') || error.includes('Not Found') || error.includes('备份不存在')) {
    return '备份文件不存在，可能已被删除。请刷新列表后重试'
  }
  if (error.includes('ECONNREFUSED') || error.includes('Network') || error.includes('network') || error.includes('fetch')) {
    return '无法连接到存储服务器，请检查网络连接和服务器地址'
  }
  if (error.includes('timeout') || error.includes('Timeout')) {
    return '下载超时，请检查网络状态或稍后重试'
  }
  if (error.includes('JSON') || error.includes('parse') || error.includes('格式')) {
    return '备份文件格式损坏，无法恢复。请尝试其他备份'
  }
  if (error.includes('数据库') || error.includes('database')) {
    return '写入本地数据库失败，请尝试重启应用后再恢复'
  }
  return `恢复失败：${error}`
}

// 显示提示
const showToast = async (message: string, color: string = 'success') => {
  await presentMobileToast(message, color)
}

onMounted(() => {
  loadSyncInterval()
  loadStorageConfigs()
  checkICloudAvailability()
  loadConflictLog()
  unsubscribeSyncStatus = cloudSyncService.onStatusChange(() => {
    loadConflictLog()
  })
})

onUnmounted(() => {
  unsubscribeSyncStatus?.()
})
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
  color: var(--ion-color-medium);
}

.empty-state ion-icon {
  margin-bottom: 16px;
  font-size: 64px;
}

.action-buttons {
  padding: 16px;
}

.sync-interval-input {
  width: 88px;
  text-align: right;
}

.sync-interval-actions {
  padding: 0 16px 12px;
}

.connection-test-button {
  width: 100%;
  margin: 8px 0;
}

.conflict-log-list {
  margin-top: 8px;
}

.conflict-entry {
  padding: 0 16px 12px;
}

.conflict-entry details {
  border: 1px solid var(--ion-color-step-200, #d7d8da);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--ion-item-background, #fff);
}

.conflict-entry summary {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  gap: 8px;
  align-items: center;
  list-style: none;
  cursor: pointer;
}

.conflict-entry summary::-webkit-details-marker {
  display: none;
}

.conflict-entry-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  margin-top: 10px;
  color: var(--ion-color-medium);
  font-size: 12px;
}

.conflict-record {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--ion-color-step-150, #e6e6e6);
}

.conflict-record-heading {
  display: flex;
  gap: 8px;
  align-items: center;
}

.conflict-record p {
  margin: 6px 0 0;
  color: var(--ion-color-medium);
  font-size: 12px;
}

.conflict-values {
  margin-top: 8px;
  color: var(--ion-color-medium);
  font-size: 12px;
}

.conflict-values summary {
  display: block;
  cursor: pointer;
}

.conflict-value-grid {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}

.conflict-value-grid span {
  display: block;
  margin-bottom: 4px;
}

.conflict-value-grid pre {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  padding: 8px;
  border-radius: 6px;
  background: var(--ion-color-step-100, #f3f4f5);
  color: var(--ion-text-color);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
