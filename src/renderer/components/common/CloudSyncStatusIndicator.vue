<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { AlertTriangle, Clock, Cloud, CloudOff, GitMerge, Refresh } from '@vicons/tabler';
import {
  cloudSyncService,
  getCloudSyncResultMessage,
  getFriendlyCloudSyncError
} from '~/lib/services/cloud-sync.service';
import type { CloudSyncStatus } from '~/lib/services/cloud-sync.service';

const status = ref<CloudSyncStatus>(cloudSyncService.getStatus());
const tooltipVisible = ref(false);
let unsubscribe: (() => void) | null = null;

const emit = defineEmits<{
  activate: [];
}>();

const conflictLogCount = computed(() => status.value.conflictLogCount ?? 0);
const hasConflictLog = computed(() => conflictLogCount.value > 0);

const visualState = computed(() => {
  if (status.value.status === 'syncing') return 'syncing';
  if (status.value.status === 'error') return 'error';
  if (hasConflictLog.value) return 'attention';
  if (status.value.status === 'scheduled') return 'scheduled';
  if (status.value.lastResult?.success || status.value.lastSyncAt) return 'success';
  return 'idle';
});

const statusIcon = computed(() => {
  if (visualState.value === 'syncing') return Refresh;
  if (visualState.value === 'scheduled') return Clock;
  if (visualState.value === 'error') return AlertTriangle;
  if (visualState.value === 'attention') return GitMerge;
  if (visualState.value === 'success') return Cloud;
  return CloudOff;
});

const primaryText = computed(() => {
  if (status.value.status === 'syncing') return '正在同步';
  if (status.value.status === 'error') return '同步遇到问题';
  if (hasConflictLog.value) return '有同步冲突记录';
  if (status.value.status === 'scheduled') return '等待下次同步';
  if (status.value.lastResult?.success) return '云同步正常';
  return '云同步待机';
});

const detailText = computed(() => {
  if (status.value.status === 'error') {
    return getFriendlyCloudSyncError(status.value.error);
  }

  if (hasConflictLog.value) {
    return `已自动合并并保留 ${conflictLogCount.value} 条冲突审计记录`;
  }

  if (status.value.lastResult?.success) {
    return getCloudSyncResultMessage(
      status.value.lastResult.action,
      status.value.lastResult.conflicts.length
    );
  }

  if (status.value.status === 'scheduled') {
    return '应用会在同步周期到达后检查云端变化';
  }

  if (status.value.status === 'syncing') {
    return '正在检查并合并本机与云端数据';
  }

  return '启用云存储后会自动显示同步状态';
});

const nextSyncText = computed(() => {
  if (!status.value.nextSyncAt) return '';
  return `下次检查 ${formatDateTime(status.value.nextSyncAt)}`;
});

const lastSyncText = computed(() => {
  if (!status.value.lastSyncAt) return '';
  return `最近同步 ${formatDateTime(status.value.lastSyncAt)}`;
});

const ariaLabel = computed(() => `${primaryText.value}，${detailText.value}。点击打开云备份设置`);

const showTooltip = () => {
  tooltipVisible.value = true;
};

const hideTooltip = () => {
  tooltipVisible.value = false;
};

const handleActivate = () => {
  emit('activate');
};

const formatDateTime = (dateString: string): string => {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return dateString;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
};

onMounted(() => {
  unsubscribe = cloudSyncService.onStatusChange(nextStatus => {
    status.value = nextStatus;
  });
});

onUnmounted(() => {
  unsubscribe?.();
});
</script>

<template>
  <div
    class="cloud-sync-indicator"
    @mouseenter="showTooltip"
    @mouseleave="hideTooltip"
  >
    <button
      class="cloud-sync-button"
      :class="`is-${visualState}`"
      type="button"
      :aria-label="ariaLabel"
      @click="handleActivate"
      @focus="showTooltip"
      @blur="hideTooltip"
    >
      <component
        :is="statusIcon"
        class="cloud-sync-icon"
        :class="{ 'is-spinning': visualState === 'syncing' }"
      />
    </button>

    <div
      v-show="tooltipVisible"
      class="cloud-sync-tooltip"
      role="status"
    >
      <strong>{{ primaryText }}</strong>
      <span>{{ detailText }}</span>
      <span v-if="nextSyncText">{{ nextSyncText }}</span>
      <span v-else-if="lastSyncText">{{ lastSyncText }}</span>
    </div>
  </div>
</template>

<style scoped>
.cloud-sync-indicator {
  position: relative;
  z-index: 20;
  display: inline-flex;
  height: 100%;
  align-items: center;
}

.cloud-sync-button {
  display: grid;
  width: 24px;
  height: 22px;
  place-items: center;
  color: #5f6368;
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  transition: color 160ms ease, background-color 160ms ease;
}

.cloud-sync-button:hover,
.cloud-sync-button:focus-visible {
  background: rgb(15 23 42 / 8%);
  outline: none;
}

.cloud-sync-button.is-success {
  color: #12845f;
}

.cloud-sync-button.is-scheduled {
  color: #3267b1;
}

.cloud-sync-button.is-syncing {
  color: #7b5c00;
}

.cloud-sync-button.is-error {
  color: #c23934;
}

.cloud-sync-button.is-attention {
  color: #9a6700;
}

.cloud-sync-icon {
  width: 15px;
  height: 15px;
}

.cloud-sync-icon.is-spinning {
  animation: cloud-sync-spin 900ms linear infinite;
}

.cloud-sync-tooltip {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  display: flex;
  width: max-content;
  max-width: min(320px, calc(100vw - 32px));
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  color: #f8fafc;
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  background: rgb(17 24 39 / 94%);
  border-radius: 6px;
  box-shadow: 0 12px 30px rgb(15 23 42 / 22%);
  pointer-events: none;
}

.cloud-sync-tooltip strong {
  font-size: 13px;
  font-weight: 600;
}

@keyframes cloud-sync-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

@media (prefers-color-scheme: dark) {
  .cloud-sync-button {
    color: #c5c8d0;
  }

  .cloud-sync-button:hover,
  .cloud-sync-button:focus-visible {
    background: rgb(255 255 255 / 12%);
  }
}
</style>
