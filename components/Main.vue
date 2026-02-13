<template>
  <div class="settings-container">
    <!-- 刷新提示 -->
    <transition name="el-fade-in">
      <el-alert
        v-if="showRefreshTip"
        title="配置已更改"
        type="warning"
        description="部分配置需要刷新页面才能生效"
        show-icon
        :closable="false"
        class="mb-3"
      >
        <template #default>
          <div class="mt-2">
            <el-button type="primary" size="small" @click="refreshPage">立即刷新</el-button>
            <el-button size="small" @click="showRefreshTip = false">稍后刷新</el-button>
          </div>
        </template>
      </el-alert>
    </transition>

    <!-- 主开关 -->
    <div class="card main-switch-card">
      <div class="setting-item">
        <div class="setting-label">
          <el-icon><SwitchButton /></el-icon>
          <span class="font-bold">启用 Fluent Read</span>
        </div>
        <div class="setting-control">
          <el-switch 
            v-model="config.on" 
            inline-prompt 
            active-text="开" 
            inactive-text="关" 
            @change="handlePluginStateChange" 
            size="large"
          />
        </div>
      </div>
    </div>

    <!-- 禁用状态占位 -->
    <div v-if="!config.on" class="empty-state">
      <el-empty description="插件已暂停工作" :image-size="100" />
    </div>

    <!-- 启用状态下的设置 -->
    <div v-show="config.on">
      
      <!-- 基础设置 -->
      <div class="card">
        <div class="card-header">基础设置</div>
        
        <!-- 翻译模式 -->
        <div class="setting-item">
          <div class="setting-label">翻译模式</div>
          <div class="setting-control">
            <el-select v-model="config.display" placeholder="选择模式" size="default">
              <el-option v-for="item in options.display" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </div>
        </div>

        <!-- 译文样式 (仅双语模式显示) -->
        <div class="setting-item" v-show="config.display === 1">
          <div class="setting-label">
            译文样式
            <el-tooltip content="选择双语模式下译文的显示样式" placement="top">
              <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
            </el-tooltip>
          </div>
          <div class="setting-control">
            <el-select v-model="config.style" placeholder="选择样式">
              <el-option-group v-for="group in styleGroups" :key="group.value" :label="group.label">
                <el-option v-for="item in group.options" :key="item.value" :label="item.label" :value="item.value" />
              </el-option-group>
            </el-select>
          </div>
        </div>

        <!-- 目标语言 -->
        <div class="setting-item">
          <div class="setting-label">目标语言</div>
          <div class="setting-control">
            <el-select v-model="config.to" placeholder="选择语言" filterable>
              <el-option v-for="item in options.to" :key="item.value" :label="item.label" :value="item.value" />
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
            服务商
            <el-tooltip content="机器翻译快速稳定；AI翻译自然流畅" placement="top">
              <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
            </el-tooltip>
          </div>
          <div class="setting-control">
            <el-select v-model="config.service" placeholder="选择服务">
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

        <!-- API Token -->
        <div class="setting-item" v-show="compute.showToken">
          <div class="setting-label">访问令牌</div>
          <div class="setting-control">
            <el-input 
              v-model="config.token[config.service]" 
              type="password" 
              show-password 
              placeholder="API Key / Token" 
            />
          </div>
        </div>

        <!-- 自定义接口 -->
        <div class="setting-item" v-show="compute.showCustom">
          <div class="setting-label">接口地址</div>
          <div class="setting-control">
            <el-input v-model="config.custom" placeholder="http://..." />
          </div>
        </div>

        <!-- 模型选择 -->
        <div class="setting-item" v-show="compute.showModel">
          <div class="setting-label">模型</div>
          <div class="setting-control">
            <el-select v-model="config.model[config.service]" placeholder="选择模型" filterable allow-create default-first-option>
              <el-option v-for="item in compute.model" :key="item" :label="item" :value="item" />
            </el-select>
          </div>
        </div>

        <!-- 自定义模型名称 -->
        <div class="setting-item" v-show="compute.showCustomModel">
          <div class="setting-label">{{ config.service === 'doubao' ? '接入点 ID' : '模型名称' }}</div>
          <div class="setting-control">
            <el-input v-model="config.customModel[config.service]" placeholder="输入模型名称" />
          </div>
        </div>

        <!-- 流式传输开关 (仅自定义接口显示) -->
        <div class="setting-item" v-show="compute.showCustom">
          <div class="setting-label">
            流式传输
            <el-tooltip content="启用 Streamable HTTP (SSE)，适用于支持流式响应的 AI 接口" placement="top">
              <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
            </el-tooltip>
          </div>
          <div class="setting-control">
            <el-switch v-model="config.useStream" inline-prompt active-text="开" inactive-text="关" />
          </div>
        </div>
      </div>

      <!-- 交互快捷键 -->
      <div class="card">
        <div class="card-header">交互与快捷键</div>

        <!-- 鼠标悬浮快捷键 -->
        <div class="setting-item">
          <div class="setting-label">
            悬浮翻译
            <el-tooltip content="按住此键并悬停在文本上进行翻译" placement="top">
              <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
            </el-tooltip>
          </div>
          <div class="setting-control column-control">
            <el-select 
              v-model="config.hotkey" 
              placeholder="选择按键" 
              size="small" 
              @change="handleMouseHotkeyChange"
            >
              <el-option v-for="item in options.keys" :key="item.value" :label="item.label" :value="item.value" :disabled="item.disabled" />
            </el-select>
            
            <div v-if="config.hotkey === 'custom'" class="custom-hotkey-display mt-1">
              <span class="hotkey-text" v-if="config.customHotkey">{{ getCustomMouseHotkeyDisplayName() }}</span>
              <span class="hotkey-text placeholder-text" v-else>未设置</span>
              <el-button size="small" type="text" @click="openCustomMouseHotkeyDialog" class="edit-button">
                <el-icon><Edit /></el-icon>
              </el-button>
            </div>
          </div>
        </div>

        <!-- 全文翻译快捷键 -->
        <div class="setting-item">
          <div class="setting-label">
            全文翻译
            <el-tooltip content="快速切换全文翻译状态的快捷键" placement="top">
              <el-icon class="ml-1 text-gray-400"><InfoFilled /></el-icon>
            </el-tooltip>
          </div>
          <div class="setting-control column-control">
            <el-select 
              v-model="config.floatingBallHotkey" 
              placeholder="选择按键" 
              size="small" 
              @change="handleHotkeyChange"
            >
              <el-option v-for="item in options.floatingBallHotkeys" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>

            <div v-if="config.floatingBallHotkey === 'custom'" class="custom-hotkey-display mt-1">
              <span class="hotkey-text" v-if="config.customFloatingBallHotkey">{{ getCustomHotkeyDisplayName() }}</span>
              <span class="hotkey-text placeholder-text" v-else>未设置</span>
              <el-button size="small" type="text" @click="openCustomHotkeyDialog" class="edit-button">
                <el-icon><Edit /></el-icon>
              </el-button>
            </div>
          </div>
        </div>

        <!-- 划词翻译模式 -->
        <div class="setting-item">
          <div class="setting-label">划词翻译</div>
          <div class="setting-control">
            <el-select v-model="config.selectionTranslatorMode" placeholder="选择模式" size="small">
              <el-option label="关闭" value="disabled" />
              <el-option label="双语显示" value="bilingual" />
              <el-option label="只显示译文" value="translation-only" />
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
                <el-icon><Setting /></el-icon> 高级选项
              </div>
            </template>
            
            <div class="advanced-content">
              <!-- 主题设置 -->
              <div class="setting-item">
                <div class="setting-label">界面主题</div>
                <div class="setting-control">
                  <el-select v-model="config.theme" size="small">
                    <el-option v-for="item in options.theme" :key="item.value" :label="item.label" :value="item.value" />
                  </el-select>
                </div>
              </div>

              <!-- 缓存开关 -->
              <div class="setting-item">
                <div class="setting-label">缓存翻译结果</div>
                <div class="setting-control">
                  <el-switch v-model="config.useCache" inline-prompt active-text="开" inactive-text="关" size="small"/>
                </div>
              </div>

              <!-- 悬浮球 -->
              <div class="setting-item">
                <div class="setting-label">全文翻译悬浮球</div>
                <div class="setting-control">
                  <el-switch v-model="floatingBallEnabled" inline-prompt active-text="开" inactive-text="关" size="small"/>
                </div>
              </div>

              <!-- 进度面板 -->
              <div class="setting-item">
                <div class="setting-label">翻译进度面板</div>
                <div class="setting-control">
                  <el-switch v-model="config.translationStatus" inline-prompt active-text="开" inactive-text="关" size="small"/>
                </div>
              </div>

              <!-- 动画 -->
              <div class="setting-item">
                <div class="setting-label">动画效果</div>
                <div class="setting-control">
                  <el-switch v-model="config.animations" inline-prompt active-text="开" inactive-text="关" size="small"/>
                </div>
              </div>

              <!-- 并发数 -->
              <div class="setting-item">
                <div class="setting-label">最大并发数</div>
                <div class="setting-control">
                  <el-input-number 
                    v-model="config.maxConcurrentTranslations" 
                    :min="1" :max="20" :step="1" 
                    size="small" 
                    @change="handleConcurrentChange" 
                    controls-position="right"
                  />
                </div>
              </div>

              <!-- 代理 -->
              <div class="setting-item" v-show="compute.showProxy">
                <div class="setting-label">代理地址</div>
                <div class="setting-control">
                  <el-input v-model="config.proxy[config.service]" placeholder="无需则留空" size="small" />
                </div>
              </div>

              <el-divider border-style="dashed" content-position="center">Prompt 设置</el-divider>

              <!-- Roles -->
              <div v-show="compute.showModel">
                <div class="role-config">
                  <div class="role-label">System Role</div>
                  <el-input type="textarea" :rows="2" v-model="config.system_role[config.service]" placeholder="System Prompt" />
                </div>
                <div class="role-config mt-2">
                  <div class="role-label">User Role ({{'{to}'}}, {{'{origin}'}})</div>
                  <el-input type="textarea" :rows="2" v-model="config.user_role[config.service]" placeholder="User Prompt Template" />
                </div>
                <div class="text-right mt-2">
                  <el-button link type="primary" size="small" @click="resetTemplate">
                    <el-icon><Refresh /></el-icon> 恢复默认Prompt
                  </el-button>
                </div>
              </div>

              <el-divider border-style="dashed" content-position="center">配置管理</el-divider>

              <div class="config-actions">
                <el-button type="primary" plain size="small" @click="handleExport">
                  <el-icon><Download /></el-icon> 导出
                </el-button>
                <el-button type="success" plain size="small" @click="handleImport">
                  <el-icon><Upload /></el-icon> 导入
                </el-button>
              </div>

              <!-- 导出/导入文本框 -->
              <div v-if="showExportBox" class="mt-2">
                <el-input v-model="exportData" type="textarea" :rows="4" readonly />
                <div class="text-xs text-gray-400 mt-1">请复制上方配置JSON</div>
              </div>
              <div v-if="showImportBox" class="mt-2">
                <el-input v-model="importData" type="textarea" :rows="4" placeholder="粘贴JSON配置" />
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
import { computed, ref, watch, onUnmounted } from 'vue'
import { models, options, servicesType, defaultOption } from "../entrypoints/utils/option";
import { Config } from "@/entrypoints/utils/model";
import { storage } from '@wxt-dev/storage';
import { ChatDotRound, Refresh, Edit, Upload, Download, SwitchButton, InfoFilled, Setting } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, ElInputNumber } from 'element-plus'
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

// 从 storage 中获取本地配置
storage.getItem('local:config').then((value: any) => {
  if (typeof value === 'string' && value) {
    const parsedConfig = JSON.parse(value);
    Object.assign(config.value, parsedConfig);
  }
  // 初始应用主题
  updateTheme(config.value.theme || 'auto');
});

// 监听 storage 中 'local:config' 的变化
storage.watch('local:config', (newValue: any, oldValue: any) => {
  if (typeof newValue === 'string' && newValue) {
    Object.assign(config.value, JSON.parse(newValue));
  }
});

// 监听菜单栏配置变化
watch(() => JSON.parse(JSON.stringify(config.value)), (newValue: any, oldValue: any) => {
  storage.setItem('local:config', JSON.stringify(newValue));
  
  if (oldValue && oldValue.on !== undefined) { 
    const needRefreshKeys = ['display', 'style', 'service', 'to', 'maxConcurrentTranslations'];
    const changed = needRefreshKeys.some(key => newValue[key] !== oldValue[key]);
    if (changed) {
      showRefreshTip.value = true;
    }
  }
}, { deep: true });

// 计算属性
let compute = ref({
  showMachine: computed(() => servicesType.isMachine(config.value.service)),
  showProxy: computed(() => servicesType.isUseProxy(config.value.service)),
  showModel: computed(() => servicesType.isUseModel(config.value.service)),
  showToken: computed(() => servicesType.isUseToken(config.value.service)),
  model: computed(() => models.get(config.value.service) || []),
  showCustom: computed(() => servicesType.isCustom(config.value.service)),
  showDeepLX: computed(() => config.value.service === 'deeplx'),
  showCustomModel: computed(() => config.value.model[config.value.service] === "自定义模型"),
  filteredServices: computed(() => options.services.filter((service: any) =>
    !([service.google].includes(service.value) && config.value.display !== 1))
  ),
})

watch(() => config.value.theme, (newTheme) => {
  updateTheme(newTheme || 'auto');
});

darkModeMediaQuery.onchange = (e) => {
  if (config.value.theme === 'auto') {
    updateTheme('auto');
  }
};

onUnmounted(() => {
  darkModeMediaQuery.onchange = null;
});

const styleGroups = computed(() => {
  const groups = options.styles.filter(item => item.disabled);
  return groups.map(group => ({
    ...group,
    options: options.styles.filter(item => !item.disabled && item.group === group.value)
  }));
});

const resetTemplate = () => {
  ElMessageBox.confirm(
    '确定要恢复默认的 system 和 user 模板吗？此操作将覆盖当前的自定义模板。',
    '恢复默认模板',
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    }
  ).then(() => {
    config.value.system_role[config.value.service] = defaultOption.system_role;
    config.value.user_role[config.value.service] = defaultOption.user_role;
    ElMessage({
      message: '已成功恢复默认翻译模板',
      type: 'success',
      duration: 2000
    });
  }).catch(() => {});
};

const floatingBallEnabled = computed({
  get: () => !config.value.disableFloatingBall && config.value.on,
  set: (value) => {
    config.value.disableFloatingBall = !value;
    browser.tabs.query({}).then(tabs => {
      tabs.forEach(tab => {
        if (tab.id) {
          browser.tabs.sendMessage(tab.id, { 
            type: 'toggleFloatingBall',
            isEnabled: value 
          }).catch(() => {});
        }
      });
    });
  }
});

watch(() => config.value.selectionTranslatorMode, (newMode) => {
  browser.tabs.query({}).then(tabs => {
    tabs.forEach(tab => {
      if (tab.id) {
        browser.tabs.sendMessage(tab.id, { 
          type: 'updateSelectionTranslatorMode',
          mode: newMode 
        }).catch(() => {});
      }
    });
  });
});

const handleSwitchChange = () => {
  showRefreshTip.value = true;
};

const handlePluginStateChange = (val: boolean) => {
  if (!val) {
    if (!config.value.disableFloatingBall) {
      config.value.disableFloatingBall = true;
      browser.tabs.query({}).then(tabs => {
        tabs.forEach(tab => {
          if (tab.id) {
            browser.tabs.sendMessage(tab.id, { 
              type: 'toggleFloatingBall',
              isEnabled: false
            }).catch(() => {});
          }
        });
      });
    }
    
    if (config.value.selectionTranslatorMode !== 'disabled') {
      config.value.selectionTranslatorMode = 'disabled';
      browser.tabs.query({}).then(tabs => {
        tabs.forEach(tab => {
          if (tab.id) {
            browser.tabs.sendMessage(tab.id, { 
              type: 'updateSelectionTranslatorMode',
              mode: 'disabled'
            }).catch(() => {});
          }
        });
      });
    }
  }
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
    message: hotkey === 'none' ? '已禁用快捷键' : `快捷键已设置为: ${getCustomHotkeyDisplayName()}`,
    type: 'success',
    duration: 2000
  });
};

const handleCustomHotkeyCancel = () => {
  if (!config.value.customFloatingBallHotkey) {
    config.value.floatingBallHotkey = 'Alt+T';
  }
};

const getCustomHotkeyDisplayName = () => {
  if (!config.value.customFloatingBallHotkey) return '';
  if (config.value.customFloatingBallHotkey === 'none') return '已禁用';
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
    message: hotkey === 'none' ? '已禁用快捷键' : `快捷键已设置为: ${getCustomMouseHotkeyDisplayName()}`,
    type: 'success',
    duration: 2000
  });
};

const handleCustomMouseHotkeyCancel = () => {
  if (!config.value.customHotkey) {
    config.value.hotkey = 'Control';
  }
};

const getCustomMouseHotkeyDisplayName = () => {
  if (!config.value.customHotkey) return '';
  if (config.value.customHotkey === 'none') return '已禁用';
  const parsed = parseHotkey(config.value.customHotkey);
  return parsed.isValid ? parsed.displayName : config.value.customHotkey;
};

const handleConcurrentChange = (currentValue: number | undefined, oldValue: number | undefined) => {
  if (currentValue === undefined || currentValue < 1 || currentValue > 100) {
    ElMessage({
      message: '并发数量必须在 1-100 之间',
      type: 'warning',
      duration: 2000
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
      if (cleanedConfig.system_role[service] === defaultOption.system_role) delete cleanedConfig.system_role[service];
    }
    if (Object.keys(cleanedConfig.system_role).length === 0) delete cleanedConfig.system_role;
  }
  if (cleanedConfig.user_role) {
    for (const service in cleanedConfig.user_role) {
      if (cleanedConfig.user_role[service] === defaultOption.user_role) delete cleanedConfig.user_role[service];
    }
    if (Object.keys(cleanedConfig.user_role).length === 0) delete cleanedConfig.user_role;
  }
  exportData.value = JSON.stringify(cleanedConfig, null, 2);
  showExportBox.value = !showExportBox.value;
  showImportBox.value = false;
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
    ElMessage({ message: '配置导入成功!', type: 'success' });
    showImportBox.value = false;
    importData.value = '';
  } catch (e) {
    ElMessage({ message: '配置格式错误', type: 'error' });
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
</style>
