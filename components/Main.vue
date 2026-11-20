<template>
  <div class="settings-container">
    <!-- 刷新提示 -->
    <transition name="el-fade-in">
      <el-alert
        v-if="showRefreshTip"
        title="设置已更新"
        type="warning"
        description="刷新当前网页后即可看到最新效果"
        show-icon
        :closable="false"
        class="mb-3"
      >
        <template #default>
          <div class="mt-2">
            <el-button type="primary" size="small" @click="refreshPage">刷新网页</el-button>
            <el-button size="small" @click="showRefreshTip = false">稍后</el-button>
          </div>
        </template>
      </el-alert>
    </transition>

    <!-- 主开关 -->
    <div class="card main-switch-card">
      <div class="setting-item">
        <div class="setting-label">
          <el-icon><SwitchButton /></el-icon>
          <span class="font-bold">启用喵喵阅读</span>
        </div>
        <div class="setting-control">
          <el-switch
            v-model="config.on"
            inline-prompt
            active-text="开"
            inactive-text="关"
            size="large"
          />
        </div>
      </div>
    </div>

    <!-- 禁用状态占位 -->
    <div v-if="!config.on" class="empty-state">
      <el-empty description="已暂停翻译，开启上方开关即可恢复" :image-size="100" />
    </div>

    <!-- 启用状态下的设置 -->
    <div v-show="config.on">
      <!-- 基础设置 -->
      <div class="card">
        <div class="card-header">基础设置</div>

        <!-- 显示方式 -->
        <div class="setting-item">
          <div class="setting-label">显示方式</div>
          <div class="setting-control">
            <el-select v-model="config.display" placeholder="选择显示方式" size="default">
              <el-option
                v-for="item in options.display"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </div>
        </div>

        <!-- 译文样式 (仅双语模式显示) -->
        <div class="setting-item" v-show="config.display === 1">
          <div class="setting-label">
            译文样式
            <el-tooltip content="双语对照时，译文在网页中的展示外观" placement="top">
              <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
            </el-tooltip>
          </div>
          <div class="setting-control">
            <el-select v-model="config.style" placeholder="选择样式">
              <el-option-group v-for="group in styleGroups" :key="group.value" :label="group.label">
                <el-option
                  v-for="item in group.options"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </el-option-group>
            </el-select>
          </div>
        </div>

        <!-- 目标语言 -->
        <div class="setting-item">
          <div class="setting-label">翻译为</div>
          <div class="setting-control">
            <el-select v-model="config.to" placeholder="选择目标语言" filterable>
              <el-option
                v-for="item in options.to"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </div>
        </div>
      </div>

      <!-- 翻译服务 -->
      <div class="card">
        <div class="card-header">翻译服务</div>

        <!-- 服务选择 -->
        <div class="setting-item">
          <div class="setting-label">
            翻译引擎
            <el-tooltip
              content="内置翻译开箱即用；自定义 AI 接口可接入 OpenAI、DeepSeek、本地 Ollama 等服务"
              placement="top"
            >
              <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
            </el-tooltip>
          </div>
          <div class="setting-control">
            <el-select v-model="config.service" placeholder="选择翻译引擎" @change="autoTestCustomEndpoint">
              <el-option
                v-for="item in compute.filteredServices"
                :key="item.value"
                :label="item.label"
                :value="item.value"
                :disabled="item.disabled"
                :class="{ 'select-divider': item.disabled }"
              />
            </el-select>
          </div>
        </div>

        <!-- API Key -->
        <div class="setting-item" v-show="compute.showToken">
          <div class="setting-label">API Key</div>
          <div class="setting-control">
            <el-input
              v-model="config.token[config.service]"
              type="password"
              show-password
              placeholder="填写接口密钥 (sk-...)"
              @change="autoTestCustomEndpoint"
            />
          </div>
        </div>

        <!-- API 地址 -->
        <div class="setting-item" v-show="compute.showCustom">
          <div class="setting-label">
            API 地址
            <el-tooltip
              content="填写服务商的基础地址（如 https://api.openai.com/v1）或完整接口地址，插件会自动识别"
              placement="top"
            >
              <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
            </el-tooltip>
          </div>
          <div class="setting-control">
            <el-input
              v-model="config.custom"
              placeholder="如 https://api.openai.com/v1"
              @change="autoTestCustomEndpoint"
            />
          </div>
        </div>

        <!-- 模型名称 -->
        <div class="setting-item" v-show="compute.showModel">
          <div class="setting-label">
            {{ config.service === 'doubao' ? '接入点 ID' : '模型名称' }}
          </div>
          <div class="setting-control">
            <el-input
              v-model="config.model[config.service]"
              placeholder="填写模型名称，如 gpt-4o-mini、deepseek-chat"
              @change="autoTestCustomEndpoint"
            />
          </div>
        </div>

        <!-- 流式传输开关 (仅自定义接口显示) -->
        <div class="setting-item" v-show="compute.showCustom">
          <div class="setting-label">
            边译边显（流式输出）
            <el-tooltip
              content="翻译长句时逐字实时显示，无需等待整段完成（需接口支持）"
              placement="top"
            >
              <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
            </el-tooltip>
          </div>
          <div class="setting-control">
            <el-switch
              v-model="config.useStream"
              inline-prompt
              active-text="开"
              inactive-text="关"
              @change="autoTestCustomEndpoint"
            />
          </div>
        </div>

        <div v-if="compute.showCustom" class="setting-item endpoint-test-row">
          <el-tooltip content="检查当前 API 地址、Key 和模型是否可用" placement="top">
            <el-button size="small" :loading="currentEndpointTest?.pending" @click="runEndpointTest">
              测试连接
            </el-button>
          </el-tooltip>
          <span
            v-if="currentEndpointTest?.message"
            class="text-xs endpoint-status"
            :class="currentEndpointTest.ok ? 'endpoint-status-ok' : 'endpoint-status-error'"
            role="status"
          >
            {{ currentEndpointTest.message }}
          </span>
        </div>
      </div>

      <!-- 快捷翻译 -->
      <div class="card">
        <div class="card-header">快捷翻译</div>

        <!-- 鼠标悬浮快捷键 -->
        <div class="setting-item">
          <div class="setting-label">
            指哪译哪
            <el-tooltip
              content="鼠标指到哪段就译哪段；可选择按住按键悬停，或用鼠标直接双击段落"
              placement="top"
            >
              <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
            </el-tooltip>
          </div>
          <div class="setting-control column-control">
            <el-select
              v-model="config.hotkey"
              placeholder="选择触发方式"
              size="small"
              @change="handleMouseHotkeyChange"
            >
              <el-option
                v-for="item in options.keys"
                :key="item.value"
                :label="item.label"
                :value="item.value"
                :disabled="item.disabled"
              />
            </el-select>

            <div v-if="config.hotkey === 'custom'" class="custom-hotkey-display mt-1">
              <span class="hotkey-text" v-if="config.customHotkey">{{
                getCustomMouseHotkeyDisplayName()
              }}</span>
              <span class="hotkey-text placeholder-text" v-else>未设置</span>
              <el-button
                size="small"
                type="text"
                @click="openCustomMouseHotkeyDialog"
                class="edit-button"
              >
                <el-icon><Edit /></el-icon>
              </el-button>
            </div>
          </div>
        </div>

        <!-- 全文翻译快捷键 -->
        <div class="setting-item">
          <div class="setting-label">
            整页翻译快捷键
            <el-tooltip content="按下快捷键即可翻译整页，再次按下恢复原文" placement="top">
              <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
            </el-tooltip>
          </div>
          <div class="setting-control column-control">
            <el-select
              v-model="config.floatingBallHotkey"
              placeholder="选择快捷键"
              size="small"
              @change="handleHotkeyChange"
            >
              <el-option
                v-for="item in options.floatingBallHotkeys"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>

            <div v-if="config.floatingBallHotkey === 'custom'" class="custom-hotkey-display mt-1">
              <span class="hotkey-text" v-if="config.customFloatingBallHotkey">{{
                getCustomHotkeyDisplayName()
              }}</span>
              <span class="hotkey-text placeholder-text" v-else>未设置</span>
              <el-button
                size="small"
                type="text"
                @click="openCustomHotkeyDialog"
                class="edit-button"
              >
                <el-icon><Edit /></el-icon>
              </el-button>
            </div>
          </div>
        </div>

        <!-- 划词翻译模式 -->
        <div class="setting-item">
          <div class="setting-label">划词翻译</div>
          <div class="setting-control">
            <el-select v-model="config.selectionTranslatorMode" placeholder="选择显示方式" size="small">
              <el-option label="关闭" value="disabled" />
              <el-option label="原文 + 译文" value="bilingual" />
              <el-option label="仅显示译文" value="translation-only" />
            </el-select>
          </div>
        </div>
      </div>

      <!-- 高级选项 -->
      <div class="card advanced-card">
        <el-collapse>
          <el-collapse-item name="1">
            <template #title>
              <div class="advanced-title">
                <el-icon><Setting /></el-icon> 更多设置
              </div>
            </template>

            <div class="advanced-content">
              <!-- 主题设置 -->
              <div class="setting-item">
                <div class="setting-label">外观主题</div>
                <div class="setting-control">
                  <el-select v-model="config.theme" size="small">
                    <el-option
                      v-for="item in options.theme"
                      :key="item.value"
                      :label="item.label"
                      :value="item.value"
                    />
                  </el-select>
                </div>
              </div>

              <!-- 缓存开关 -->
              <div class="setting-item">
                <div class="setting-label">
                  自动缓存译文
                  <el-tooltip
                    content="相同内容不再重复请求接口，返回或刷新网页时秒出译文"
                    placement="top"
                  >
                    <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
                  </el-tooltip>
                </div>
                <div class="setting-control">
                  <el-switch
                    v-model="config.useCache"
                    inline-prompt
                    active-text="开"
                    inactive-text="关"
                    size="small"
                  />
                </div>
              </div>

              <!-- 悬浮球 -->
              <div class="setting-item">
                <div class="setting-label">
                  侧边悬浮球
                  <el-tooltip
                    content="在网页边缘显示猫咪悬浮球，点击即可翻译整页或恢复原文"
                    placement="top"
                  >
                    <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
                  </el-tooltip>
                </div>
                <div class="setting-control">
                  <el-switch
                    v-model="floatingBallEnabled"
                    inline-prompt
                    active-text="开"
                    inactive-text="关"
                    size="small"
                  />
                </div>
              </div>

              <!-- 进度面板 -->
              <div class="setting-item">
                <div class="setting-label">
                  显示翻译进度
                  <el-tooltip
                    content="整页翻译时在网页右下角显示进度浮窗"
                    placement="top"
                  >
                    <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
                  </el-tooltip>
                </div>
                <div class="setting-control">
                  <el-switch
                    v-model="config.translationStatus"
                    inline-prompt
                    active-text="开"
                    inactive-text="关"
                    size="small"
                  />
                </div>
              </div>

              <!-- 页面总结 -->
              <div class="setting-item">
                <div class="setting-label">
                  AI 全文语境优化
                  <el-tooltip
                    content="整页翻译前先通读页面，提取专有名词和背景，让译文用词更统一准确（仅 AI 模型可用）"
                    placement="top"
                  >
                    <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
                  </el-tooltip>
                </div>
                <div class="setting-control">
                  <el-switch
                    v-model="config.enablePageSummary"
                    inline-prompt
                    active-text="开"
                    inactive-text="关"
                    size="small"
                    :disabled="!compute.showModel"
                  />
                </div>
              </div>

              <!-- AI 全文语境优化 - 专用模型/Key/URL (仅开启时显示) -->
              <div
                v-show="config.enablePageSummary && compute.showModel"
                class="summary-config-section"
              >
                <div class="setting-item">
                  <div class="setting-label">
                    专用 API 地址
                    <el-tooltip content="留空则复用上方翻译服务的 API 地址" placement="top">
                      <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
                    </el-tooltip>
                  </div>
                  <div class="setting-control">
                    <el-input
                      v-model="config.summaryApiUrl"
                      placeholder="默认复用上方地址"
                      size="small"
                    />
                  </div>
                </div>
                <div class="setting-item">
                  <div class="setting-label">
                    专用模型
                    <el-tooltip
                      content="可指定轻量快速的模型专门提取语境，留空则复用上方模型"
                      placement="top"
                    >
                      <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
                    </el-tooltip>
                  </div>
                  <div class="setting-control">
                    <el-input
                      v-model="config.summaryModel"
                      placeholder="默认复用上方模型"
                      size="small"
                    />
                  </div>
                </div>
                <div class="setting-item">
                  <div class="setting-label">
                    专用 API Key
                    <el-tooltip content="留空则复用上方翻译服务的 API Key" placement="top">
                      <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
                    </el-tooltip>
                  </div>
                  <div class="setting-control">
                    <el-input
                      v-model="config.summaryApiKey"
                      type="password"
                      show-password
                      placeholder="默认复用上方 Key"
                      size="small"
                    />
                  </div>
                </div>
              </div>

              <!-- 动画 -->
              <div class="setting-item">
                <div class="setting-label">过渡动画</div>
                <div class="setting-control">
                  <el-switch
                    v-model="config.animations"
                    inline-prompt
                    active-text="开"
                    inactive-text="关"
                    size="small"
                  />
                </div>
              </div>

              <!-- 并发数 -->
              <div class="setting-item">
                <div class="setting-label">
                  同时翻译段落数
                  <el-tooltip
                    content="同时进行的翻译请求数。调高速度更快，但容易触发免费接口限流"
                    placement="top"
                  >
                    <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
                  </el-tooltip>
                </div>
                <div class="setting-control">
                  <el-input-number
                    v-model="config.maxConcurrentTranslations"
                    :min="1"
                    :max="20"
                    :step="1"
                    size="small"
                    @change="handleConcurrentChange"
                    controls-position="right"
                  />
                </div>
              </div>

              <!-- 调试模式 -->
              <div class="setting-item">
                <div class="setting-label">
                  开发者调试日志
                  <el-tooltip
                    content="开启后在浏览器控制台（F12）输出详细请求日志，方便排查接口问题"
                    placement="top"
                  >
                    <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
                  </el-tooltip>
                </div>
                <div class="setting-control">
                  <el-switch
                    v-model="config.debugMode"
                    inline-prompt
                    active-text="开"
                    inactive-text="关"
                    size="small"
                  />
                </div>
              </div>

              <el-divider border-style="dashed" content-position="center">自定义翻译指令</el-divider>

              <!-- Roles -->
              <div v-show="compute.showModel">
                <div class="role-config">
                  <div class="role-label">系统角色指令（System）</div>
                  <el-input
                    type="textarea"
                    :rows="2"
                    v-model="config.system_role[config.service]"
                    placeholder="设定 AI 的翻译身份、语气或领域要求"
                  />
                </div>
                <div class="role-config mt-2">
                  <div class="role-label">
                    <div>翻译内容模板（User）</div>
                    <div class="role-hint">
                      可用变量：<code v-pre>{{to}}</code> 目标语言，<code v-pre>{{origin}}</code> 待译原文
                    </div>
                  </div>
                  <el-input
                    type="textarea"
                    :rows="2"
                    v-model="config.user_role[config.service]"
                    placeholder="填写发送给 AI 的翻译模板，需包含 {{origin}}"
                  />
                  <div v-if="duplicatePromptTags.length" class="prompt-tag-warning mt-1">
                    <el-icon><Warning /></el-icon>
                    <span>{{ duplicatePromptTagWarning }}</span>
                  </div>
                </div>
                <div class="text-right mt-2">
                  <el-button link type="primary" size="small" @click="resetTemplate">
                    <el-icon><Refresh /></el-icon> 恢复默认指令
                  </el-button>
                </div>
              </div>

              <el-divider border-style="dashed" content-position="center">备份与恢复</el-divider>

              <div class="config-actions">
                <el-button type="primary" plain size="small" @click="handleExport">
                  <el-icon><Download /></el-icon> 导出配置
                </el-button>
                <el-button type="success" plain size="small" @click="handleImport">
                  <el-icon><Upload /></el-icon> 导入配置
                </el-button>
              </div>

              <!-- 导出/导入文本框 -->
              <div v-if="showExportBox" class="mt-2">
                <el-input v-model="exportData" type="textarea" :rows="4" readonly />
                <div class="export-actions mt-1">
                  <span class="text-xs text-gray-400">可用于备份或迁移到其他设备</span>
                  <el-button size="small" link type="primary" @click="copyExportData">
                    复制配置
                  </el-button>
                </div>
              </div>
              <div v-if="showImportBox" class="mt-2">
                <el-input
                  v-model="importData"
                  type="textarea"
                  :rows="4"
                  placeholder="粘贴之前导出的 JSON 配置内容"
                />
                <div class="text-right mt-1">
                  <el-button type="primary" size="small" @click="saveImport">确认导入</el-button>
                </div>
              </div>
            </div>
          </el-collapse-item>
        </el-collapse>
      </div>
    </div>

    <!-- Dialogs -->
    <CustomHotkeyInput
      v-model="showCustomHotkeyDialog"
      :current-value="config.customFloatingBallHotkey"
      @confirm="handleCustomHotkeyConfirm"
      @cancel="handleCustomHotkeyCancel"
    />

    <CustomHotkeyInput
      v-model="showCustomMouseHotkeyDialog"
      :current-value="config.customHotkey"
      @confirm="handleCustomMouseHotkeyConfirm"
      @cancel="handleCustomMouseHotkeyCancel"
    />
  </div>
</template>

<script lang="ts" setup>
// Main 处理配置信息
import { computed, ref, shallowRef, watch, onUnmounted, nextTick } from 'vue';
import {
  options,
  services,
  servicesType,
  defaultOption,
  migrateCustomModels,
  supportedServiceForBrowser,
} from '../entrypoints/utils/option';
import { Config } from '@/entrypoints/utils/model';
import { openAiEndpointType, openAiModel } from '@/entrypoints/utils/openai';
import { TRANSLATION_COUNT_KEY, normalizeTranslationCount } from '@/entrypoints/utils/constant';
import { storage } from '@wxt-dev/storage';
import {
  ChatDotRound,
  Refresh,
  Edit,
  Upload,
  Download,
  SwitchButton,
  InfoFilled,
  Setting,
  Warning,
} from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox, ElInputNumber } from 'element-plus';
import browser from 'webextension-polyfill';
import { defineAsyncComponent } from 'vue';
const CustomHotkeyInput = defineAsyncComponent(() => import('@/components/CustomHotkeyInput.vue'));
import { parseHotkey } from '@/entrypoints/utils/hotkey';

// 初始化深色模式媒体查询
const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

// 更新主题函数
function updateTheme(theme: string) {
  if (theme === 'auto') {
    // 自动模式下，直接使用系统主题
    const isDark = darkModeMediaQuery.matches;
    document.documentElement.classList.toggle('dark', isDark);
  } else {
    // 手动模式下，使用选择的主题
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }
}

// 配置信息
let config = ref(new Config());
const endpointSettings = computed(() => ({
  url: config.value.custom?.trim() || '',
  token: config.value.token[services.custom]?.trim() || '',
  model: openAiModel(config.value),
  stream: config.value.useStream,
}));
const endpointFingerprint = computed(() => JSON.stringify(endpointSettings.value));
const endpointTest = shallowRef<{
  fingerprint: string;
  pending: boolean;
  ok?: boolean;
  message?: string;
}>();
const currentEndpointTest = computed(() =>
  endpointTest.value?.fingerprint === endpointFingerprint.value ? endpointTest.value : undefined,
);

function autoTestCustomEndpoint() {
  const { url, token, model } = endpointSettings.value;
  if (config.value.service === services.custom && url && token && model && !openAiEndpointType(url)) {
    if (!currentEndpointTest.value) void runEndpointTest();
  }
}

async function runEndpointTest() {
  if (currentEndpointTest.value?.pending) return;
  const test = { fingerprint: endpointFingerprint.value, pending: true };
  endpointTest.value = test;
  try {
    const result: { url: string } | { error: string } = await browser.runtime.sendMessage({
      type: 'test-custom-endpoint',
      settings: endpointSettings.value,
    });
    if ('error' in result) throw new Error(result.error);
    if (currentEndpointTest.value !== test || config.value.service !== services.custom) return;
    config.value.custom = result.url;
    endpointTest.value = {
      fingerprint: endpointFingerprint.value,
      pending: false,
      ok: true,
      message: '连接成功，接口可用',
    };
  } catch (error) {
    if (currentEndpointTest.value !== test) return;
    endpointTest.value = {
      ...test,
      pending: false,
      ok: false,
      message: `连接失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (endpointTest.value === test) endpointTest.value = undefined;
  }
}

// 忽略从 storage 加载配置时的变更，避免打开面板就误报“配置已更改”
const configReady = ref(false);
const needRefreshKeys = ['display', 'style', 'service', 'to', 'maxConcurrentTranslations'];
let loadedRefreshFingerprint = '';

function configRefreshFingerprint(cfg: any) {
  return JSON.stringify(needRefreshKeys.map((key) => cfg?.[key]));
}

// 从 storage 中获取本地配置
storage
  .getItem('local:config')
  .then((value: any) => {
    if (typeof value === 'string' && value) {
      try {
        const parsedConfig = JSON.parse(value);
        Object.assign(config.value, parsedConfig);
        config.value.service = supportedServiceForBrowser(config.value.service);
        migrateCustomModels(config.value);
      } catch (error) {
        console.error('Failed to parse config:', error);
      }
    }
    // 初始应用主题
    updateTheme(config.value.theme || 'auto');
  })
  .finally(() => {
    nextTick(() => {
      loadedRefreshFingerprint = configRefreshFingerprint(config.value);
      configReady.value = true;
    });
  });

// 监听 storage 中 'local:config' 的变化
storage.watch('local:config', (newValue: any, oldValue: any) => {
  if (typeof newValue === 'string' && newValue) {
    Object.assign(config.value, JSON.parse(newValue));
    config.value.service = supportedServiceForBrowser(config.value.service);
    migrateCustomModels(config.value);
  }
});

// 监听菜单栏配置变化
watch(
  () => JSON.parse(JSON.stringify(config.value)),
  (newValue: any) => {
    if (!configReady.value) return;

    storage.setItem('local:config', JSON.stringify(newValue));

    if (configRefreshFingerprint(newValue) !== loadedRefreshFingerprint) {
      showRefreshTip.value = true;
    }
  },
  { deep: true },
);

// 计算属性
let compute = ref({
  showMachine: computed(() => servicesType.isMachine(config.value.service)),
  showModel: computed(() => servicesType.isUseModel(config.value.service)),
  showToken: computed(() => servicesType.isUseToken(config.value.service)),
  showCustom: computed(() => servicesType.isCustom(config.value.service)),
  filteredServices: computed(() =>
    options.services.filter(
      (service: any) =>
        !(service.value === services.google && config.value.display === 0) &&
        !(import.meta.env.FIREFOX && service.value === services.chromeTranslator),
    ),
  ),
});

watch(
  () => config.value.theme,
  (newTheme) => {
    updateTheme(newTheme || 'auto');
  },
);

darkModeMediaQuery.onchange = (e) => {
  if (config.value.theme === 'auto') {
    updateTheme('auto');
  }
};

onUnmounted(() => {
  darkModeMediaQuery.onchange = null;
});

const styleGroups = computed(() => {
  const groups = options.styles.filter((item) => item.disabled);
  return groups.map((group) => ({
    ...group,
    options: options.styles.filter((item) => !item.disabled && item.group === group.value),
  }));
});

const PROMPT_REPLACE_TAGS = ['{{to}}', '{{origin}}'] as const;

function countPromptReplaceTag(template: string, tag: string): number {
  if (!template) return 0;
  return template.split(tag).length - 1;
}

const duplicatePromptTags = computed(() => {
  const template = config.value.user_role[config.value.service] || '';
  return PROMPT_REPLACE_TAGS.filter((tag) => countPromptReplaceTag(template, tag) > 1);
});

const duplicatePromptTagWarning = computed(() => {
  const tags = duplicatePromptTags.value.join('、');
  return `${tags} 在翻译模板中出现了多次，只有第一个会生效`;
});

const resetTemplate = () => {
  ElMessageBox.confirm(
    '确定要恢复默认的翻译指令吗？当前修改将被覆盖。',
    '恢复默认指令',
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    },
  )
    .then(() => {
      config.value.system_role[config.value.service] = defaultOption.system_role;
      config.value.user_role[config.value.service] = defaultOption.user_role;
      ElMessage({
        message: '已恢复默认翻译指令',
        type: 'success',
        duration: 2000,
      });
    })
    .catch(() => {});
};

const floatingBallEnabled = computed({
  get: () => !config.value.disableFloatingBall && config.value.on,
  set: (value) => {
    config.value.disableFloatingBall = !value;
    browser.tabs.query({}).then((tabs) => {
      tabs.forEach((tab) => {
        if (tab.id) {
          browser.tabs
            .sendMessage(tab.id, {
              type: 'toggleFloatingBall',
              isEnabled: value,
            })
            .catch(() => {});
        }
      });
    });
  },
});

watch(
  () => config.value.selectionTranslatorMode,
  (newMode) => {
    browser.tabs.query({}).then((tabs) => {
      tabs.forEach((tab) => {
        if (tab.id) {
          browser.tabs
            .sendMessage(tab.id, {
              type: 'updateSelectionTranslatorMode',
              mode: newMode,
            })
            .catch(() => {});
        }
      });
    });
  },
);

const handleSwitchChange = () => {
  showRefreshTip.value = true;
};

const showCustomHotkeyDialog = ref(false);
const showCustomMouseHotkeyDialog = ref(false);
const showExportConfig = ref(false);
const showImportConfig = ref(false);
const exportedConfig = ref('');
const importConfigText = ref('');
const importLoading = ref(false);

const handleHotkeyChange = (value: string) => {
  if (value === 'custom') {
    if (!config.value.customFloatingBallHotkey) {
      setTimeout(() => {
        openCustomHotkeyDialog();
      }, 100);
    }
  }
};

const openCustomHotkeyDialog = () => {
  showCustomHotkeyDialog.value = true;
};

const handleCustomHotkeyConfirm = (hotkey: string) => {
  config.value.customFloatingBallHotkey = hotkey;
  config.value.floatingBallHotkey = 'custom';

  ElMessage({
    message: hotkey === 'none' ? '已关闭快捷键' : `快捷键已设为：${getCustomHotkeyDisplayName()}`,
    type: 'success',
    duration: 2000,
  });
};

const handleCustomHotkeyCancel = () => {
  if (!config.value.customFloatingBallHotkey) {
    config.value.floatingBallHotkey = 'Alt+T';
  }
};

const getCustomHotkeyDisplayName = () => {
  if (!config.value.customFloatingBallHotkey) return '';
  if (config.value.customFloatingBallHotkey === 'none') return '已关闭';
  const parsed = parseHotkey(config.value.customFloatingBallHotkey);
  return parsed.isValid ? parsed.displayName : config.value.customFloatingBallHotkey;
};

const handleMouseHotkeyChange = (value: string) => {
  if (value === 'custom') {
    if (!config.value.customHotkey) {
      setTimeout(() => {
        openCustomMouseHotkeyDialog();
      }, 100);
    }
  }
};

const openCustomMouseHotkeyDialog = () => {
  showCustomMouseHotkeyDialog.value = true;
};

const handleCustomMouseHotkeyConfirm = (hotkey: string) => {
  config.value.customHotkey = hotkey;
  config.value.hotkey = 'custom';

  ElMessage({
    message:
      hotkey === 'none' ? '已关闭快捷键' : `快捷键已设为：${getCustomMouseHotkeyDisplayName()}`,
    type: 'success',
    duration: 2000,
  });
};

const handleCustomMouseHotkeyCancel = () => {
  if (!config.value.customHotkey) {
    config.value.hotkey = 'Control';
  }
};

const getCustomMouseHotkeyDisplayName = () => {
  if (!config.value.customHotkey) return '';
  if (config.value.customHotkey === 'none') return '已关闭';
  const parsed = parseHotkey(config.value.customHotkey);
  return parsed.isValid ? parsed.displayName : config.value.customHotkey;
};

const handleConcurrentChange = (currentValue: number | undefined, oldValue: number | undefined) => {
  if (!configReady.value) return;
  if (currentValue === undefined || currentValue < 1 || currentValue > 20) {
    ElMessage({
      message: '同时翻译段落数需在 1 到 20 之间',
      type: 'warning',
      duration: 2000,
    });
    config.value.maxConcurrentTranslations = 6;
    return;
  }
  showRefreshTip.value = true;
};

const showRefreshTip = ref(false);

const refreshPage = async () => {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) {
    browser.tabs.reload(tabs[0].id);
    showRefreshTip.value = false;
  }
};

const showExportBox = ref(false);
const exportData = ref('');
const showImportBox = ref(false);
const importData = ref('');

const handleExport = async () => {
  const configStr = await storage.getItem('local:config');
  if (!configStr) {
    ElMessage({ message: '没有找到配置信息', type: 'warning' });
    return;
  }
  const configToExport = JSON.parse(configStr as string);
  const cleanedConfig = JSON.parse(JSON.stringify(configToExport));
  if (cleanedConfig.system_role) {
    for (const service in cleanedConfig.system_role) {
      if (cleanedConfig.system_role[service] === defaultOption.system_role)
        delete cleanedConfig.system_role[service];
    }
    if (Object.keys(cleanedConfig.system_role).length === 0) delete cleanedConfig.system_role;
  }
  if (cleanedConfig.user_role) {
    for (const service in cleanedConfig.user_role) {
      if (cleanedConfig.user_role[service] === defaultOption.user_role)
        delete cleanedConfig.user_role[service];
    }
    if (Object.keys(cleanedConfig.user_role).length === 0) delete cleanedConfig.user_role;
  }
  const dedicatedCount = await storage.getItem(TRANSLATION_COUNT_KEY);
  cleanedConfig.count = Math.max(
    normalizeTranslationCount(cleanedConfig.count),
    dedicatedCount === null || dedicatedCount === undefined ? 0 : normalizeTranslationCount(dedicatedCount),
  );
  exportData.value = JSON.stringify(cleanedConfig, null, 2);
  showExportBox.value = !showExportBox.value;
  showImportBox.value = false;
  if (showExportBox.value) {
    try {
      await navigator.clipboard.writeText(exportData.value);
      ElMessage({ message: '配置已复制到剪贴板', type: 'success', duration: 2000 });
    } catch {
      // 用户可从下方文本框手动复制
    }
  }
};

const copyExportData = async () => {
  if (!exportData.value) return;
  try {
    await navigator.clipboard.writeText(exportData.value);
    ElMessage({ message: '配置已复制到剪贴板', type: 'success', duration: 2000 });
  } catch {
    ElMessage({ message: '无法自动复制，请手动全选上方内容复制', type: 'warning', duration: 2000 });
  }
};

const handleImport = () => {
  showImportBox.value = !showImportBox.value;
  showExportBox.value = false;
};

const saveImport = async () => {
  try {
    const parsedConfig = JSON.parse(importData.value);
    if (!validateConfig(parsedConfig)) {
      ElMessage({ message: '配置无效或格式不正确', type: 'error' });
      return;
    }
    await storage.setItem('local:config', JSON.stringify(parsedConfig));
    if ('count' in parsedConfig) {
      await storage.setItem(TRANSLATION_COUNT_KEY, normalizeTranslationCount(parsedConfig.count));
    }
    ElMessage({ message: '配置已导入并生效', type: 'success' });
    showImportBox.value = false;
    importData.value = '';
  } catch (e) {
    ElMessage({ message: '请检查粘贴的内容是否为正确的 JSON 格式', type: 'error' });
  }
};

const validateConfig = (configData: any): boolean => {
  try {
    if (typeof configData !== 'object' || configData === null) return false;
    const requiredFields = ['on', 'service', 'display', 'from', 'to'];
    for (const field of requiredFields) {
      if (!(field in configData)) return false;
    }
    if (typeof configData.service !== 'string') return false;
    return true;
  } catch (error) {
    return false;
  }
};
</script>

<style scoped>
.settings-container {
  padding-bottom: 20px;
}

.card-header {
  font-size: 13px;
  font-weight: 600;
  color: var(--fr-text-secondary);
  margin-bottom: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.main-switch-card {
  border: 1px solid var(--fr-border-color);
  background: var(--fr-card-bg);
}

.font-bold {
  font-weight: 600;
}

.ml-1 {
  margin-left: 4px;
}

.mt-1 {
  margin-top: 4px;
}

.mt-2 {
  margin-top: 8px;
}

.mb-3 {
  margin-bottom: 12px;
}

.text-gray-400 {
  color: #909399;
}

.text-xs {
  font-size: 12px;
}

.text-right {
  text-align: right;
}

.column-control {
  flex-direction: column;
  align-items: flex-end;
}

.role-config {
  background: var(--fr-bg-color);
  padding: 8px;
  border-radius: 6px;
  border: 1px solid var(--fr-border-color);
}

.role-label {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--fr-text-secondary);
}

.role-label code {
  font-size: 11px;
  font-weight: 600;
  padding: 0 3px;
  border-radius: 3px;
  background: var(--fr-card-bg);
}

.prompt-tag-warning {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
  border: 1px solid var(--el-color-warning-light-7);
  border-radius: 4px;
  padding: 6px 8px;
}

.prompt-tag-warning .el-icon {
  margin-top: 1px;
  flex-shrink: 0;
}

.config-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 10px;
}

.advanced-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}

:deep(.el-collapse) {
  border: none;
}
:deep(.el-collapse-item__header) {
  border: none;
  background: transparent;
  height: 40px;
}
:deep(.el-collapse-item__wrap) {
  border: none;
  background: transparent;
}
:deep(.el-collapse-item__content) {
  padding-bottom: 0;
}

.custom-hotkey-display {
  display: flex;
  align-items: center;
  padding: 2px 6px 2px 10px;
  background: var(--el-color-primary-light-9);
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 4px;
  font-size: 12px;
  width: 100%;
  box-sizing: border-box;
}

.hotkey-text {
  flex: 1;
  font-family: monospace;
  font-weight: 600;
  color: var(--el-color-primary);
}

.edit-button {
  padding: 2px;
}

.summary-config-section {
  margin-left: 8px;
  padding-left: 10px;
  border-left: 2px solid var(--el-color-primary-light-7);
  margin-bottom: 8px;
}

.endpoint-test-row {
  align-items: center;
  gap: 10px;
}

.endpoint-status {
  text-align: right;
  line-height: 1.4;
  word-break: break-word;
}

.endpoint-status-ok {
  color: var(--el-color-success);
}

.endpoint-status-error {
  color: var(--el-color-danger);
}

.role-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--fr-text-secondary);
  margin-top: 2px;
}

.export-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
</style>
