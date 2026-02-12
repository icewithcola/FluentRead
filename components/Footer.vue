<template>
  <div class="footer-container">
    <div class="footer-content">
      <div class="left-section">
        <span class="count-label">已翻译</span>
        <span class="count-number">{{ computedCount }}</span>
        <span class="count-label">次</span>
      </div>

      <div class="right-section">
        <el-tooltip content="清除翻译缓存" placement="top">
          <el-button 
            link 
            :type="clearStatusType" 
            @click="clearCache" 
            :disabled="isClearing"
            class="action-btn"
          >
            <el-icon :class="{ 'is-loading': isClearing }">
              <Refresh v-if="!isClearing && !clearResult" />
              <Loading v-else-if="isClearing" />
              <CircleCheckFilled v-else-if="clearResult === 'success'" />
              <Warning v-else-if="clearResult === 'error'" />
            </el-icon>
          </el-button>
        </el-tooltip>

        <el-tooltip content="GitHub 开源" placement="top">
          <el-link 
            href="https://fluent.thinkstu.com/" 
            target="_blank" 
            :underline="false"
            class="action-btn"
          >
            <el-icon><Star /></el-icon>
          </el-link>
        </el-tooltip>

        <el-tooltip content="赞赏作者" placement="top">
          <el-button link @click="showDonate = true" class="action-btn donate-btn">
            <el-icon><Coffee /></el-icon>
          </el-button>
        </el-tooltip>
      </div>
    </div>
    
    <!-- 赞赏码弹窗 -->
    <el-dialog
      v-model="showDonate"
      title="赞赏作者"
      width="300px"
      align-center
      append-to-body
      class="donate-dialog-custom"
    >
      <div class="donate-content">
        <p class="donate-text">
          如果觉得好用，<br>欢迎请作者喝一杯咖啡 ☕️
        </p>
        <div class="qrcode-container">
          <img src="/misc/approve.jpg" alt="赞赏码" class="qrcode-image" />
        </div>
        <p class="donate-thanks">感谢您的支持！❤️</p>
      </div>
    </el-dialog>
  </div>
</template>

<script lang="ts" setup>
import { computed, reactive, ref } from 'vue';
import { Star, Loading, Coffee, Refresh, CircleCheckFilled, Warning } from "@element-plus/icons-vue";
import { Config } from "../entrypoints/utils/model";
import { storage } from '@wxt-dev/storage';
import browser from 'webextension-polyfill';

const isClearing = ref(false);
const clearResult = ref<'' | 'success' | 'error'>('');
const showDonate = ref(false);

const clearStatusType = computed(() => {
  if (clearResult.value === 'success') return 'success';
  if (clearResult.value === 'error') return 'danger';
  return 'default';
});

async function clearCache() {
  if (isClearing.value) return;
  
  try {
    isClearing.value = true;
    clearResult.value = '';

    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]?.id) {
      throw new Error('No active tab found');
    }

    await browser.tabs.sendMessage(tabs[0].id, { message: 'clearCache' });

    clearResult.value = 'success';
  } catch (error) {
    console.error('清除缓存失败:', error);
    clearResult.value = 'error';
  } finally {
    setTimeout(() => {
      isClearing.value = false;
      clearResult.value = '';
    }, 2000);
  }
}

let localConfig = reactive(new Config());

storage.getItem('local:config').then((value) => {
  if (typeof value === 'string' && value) Object.assign(localConfig, JSON.parse(value));
});

storage.watch('local:config', (newValue) => {
  if (typeof newValue === 'string' && newValue) Object.assign(localConfig, JSON.parse(newValue));
});

const computedCount = computed(() => localConfig.count);
</script>

<style scoped>
.footer-container {
  margin-top: 16px;
  padding: 0 4px;
}

.footer-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: var(--fr-card-bg);
  border-radius: var(--fr-border-radius);
  box-shadow: var(--fr-shadow);
}

.left-section {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 13px;
  color: var(--fr-text-secondary);
}

.count-number {
  font-family: monospace;
  font-size: 16px;
  font-weight: 700;
  color: var(--fr-primary-color);
}

.right-section {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-btn {
  font-size: 18px;
  padding: 4px;
  height: auto;
  color: var(--fr-text-secondary);
  transition: all 0.2s;
}

.action-btn:hover {
  color: var(--fr-primary-color);
  transform: translateY(-1px);
}

.donate-btn:hover {
  color: #E6A23C; /* Warning color for coffee */
}

.donate-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.donate-text {
  font-size: 14px;
  color: var(--fr-text-color);
  margin-bottom: 16px;
  line-height: 1.5;
}

.qrcode-container {
  width: 180px;
  height: 180px;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  margin-bottom: 12px;
}

.qrcode-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.donate-thanks {
  font-size: 12px;
  color: #909399;
}
</style>
