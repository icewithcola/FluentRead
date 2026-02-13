# 实施计划

- [ ] 1. 在 Config 模型中添加 `enablePageSummary` 配置字段
   - 在 `entrypoints/utils/model.ts` 的 `Config` 类中添加 `enablePageSummary: boolean` 字段，默认值为 `false`
   - 在构造函数中初始化 `this.enablePageSummary = false`
   - _需求：1.1_

- [ ] 2. 在设置页面（Main.vue）高级选项区域添加"翻译前总结页面"开关
   - 在 `components/Main.vue` 的高级选项卡片中（`<div class="advanced-content">` 内，"翻译进度面板"开关附近），添加一个新的 `setting-item`，包含 `el-switch` 绑定到 `config.enablePageSummary`
   - 通过 `compute` 中已有的 `showModel`（即 `servicesType.isUseModel(config.service)`）来判断当前翻译服务是否支持自定义 Prompt，不支持时禁用开关并显示 tooltip 提示"当前翻译服务不支持页面总结功能"
   - 配置变更已通过现有的 `watch` 机制自动持久化到 `storage`，无需额外代码
   - _需求：1.1、1.2、1.3_

- [ ] 3. 创建总结专用的消息模板函数
   - 在 `entrypoints/utils/template.ts` 中新增 `summaryMsgTemplate(content: string)` 函数
   - 使用固定的 system_role: `"You are a professional content summarizer."`
   - 使用固定的 user_role: `"Please summarize the following webpage content in {{to}} language, in 2-3 concise sentences:\n\n{{content}}"`，其中 `{{to}}` 替换为 `config.to`，`{{content}}` 替换为传入的页面文本
   - 复用 `commonMsgTemplate` 的模型选取逻辑（读取 `config.model[config.service]`、处理自定义模型名称），以及 `config.useStream` 的流式设置
   - _需求：2.3、2.4_

- [ ] 4. 创建页面文本采集工具函数
   - 在 `entrypoints/utils/` 目录下新建 `pageSummary.ts` 文件
   - 实现 `extractPageText(): string` 函数：从 `document.body` 中提取可见文本内容，使用 `TreeWalker` 遍历文本节点，跳过 `<script>`、`<style>`、`<nav>`、`<header>`、`<footer>`、`<noscript>` 等标签，截断到最多 3000 字符
   - 实现内容有效性检查：如果提取的文本去除空白后少于 50 字符则返回空字符串
   - _需求：2.1、2.2、2.5_

- [ ] 5. 实现总结缓存的存取逻辑
   - 在 `entrypoints/utils/pageSummary.ts` 中实现缓存函数：
     - `getSummaryCacheKey(): string`：基于当前页面 URL（`location.href`）生成缓存 key，格式为 `fr_summary_${url}`
     - `getCachedSummary(): string | null`：当 `config.useCache` 为 true 时从 `localStorage` 读取缓存
     - `setCachedSummary(summary: string): void`：当 `config.useCache` 为 true 时写入缓存
   - 在 `entrypoints/utils/cache.ts` 的 `clean()` 方法中，扩展清除逻辑以同时删除以 `fr_summary_` 为前缀的 key
   - _需求：5.1、5.2、5.3、5.4_

- [ ] 6. 实现总结请求发送逻辑（含流式与非流式）
   - 在 `entrypoints/utils/pageSummary.ts` 中实现核心函数 `requestPageSummary(onChunk?: (text: string) => void): Promise<string>`
   - 该函数内部流程：①检查缓存是否命中 → ②调用 `extractPageText()` 采集文本 → ③若文本为空则返回 → ④通过 `browser.runtime.sendMessage` 或 Port 连接发送总结请求到 background 脚本 → ⑤返回总结结果并写入缓存
   - 在 `entrypoints/background.ts` 中，扩展消息监听逻辑，区分翻译请求和总结请求（新增 `type: 'summary'` 消息类型），总结请求使用 `summaryMsgTemplate` 构建请求体并发送到翻译服务
   - 支持 15 秒超时控制（`Promise.race` + `setTimeout`）
   - _需求：2.3、4.3、6.2、6.3_

- [ ] 7. 创建 PageSummaryCard.vue 总结卡片组件
   - 在 `components/` 目录下新建 `PageSummaryCard.vue` 组件，参考 `TranslationStatus.vue` 的结构和样式风格
   - 组件包含：标题区域（"📝 页面总结" + 关闭按钮）、内容区域（总结文本或加载动画）
   - 使用 `position: fixed; top: 20px; right: 20px;` 定位在页面右上角，z-index 设为 9999
   - 组件接收状态：`loading`（显示 spinner）、`content`（显示总结文本）、`error`（不显示卡片）
   - 支持流式更新：当 `content` 被逐步更新时实时渲染
   - 关闭按钮点击时移除卡片
   - 包含暗黑模式样式支持（参考 `TranslationStatus.vue` 的 dark mode CSS）
   - _需求：3.1、3.2、3.3、4.1、4.2、4.3_

- [ ] 8. 在 content.ts 中实现总结卡片的挂载与卸载
   - 在 `entrypoints/content.ts` 中新增 `mountPageSummaryCard()` 和 `unmountPageSummaryCard()` 函数，参考 `mountTranslationStatusComponent()` 的实现模式
   - 挂载时创建容器 `div#fluent-read-page-summary-container` 并通过 `createApp(PageSummaryCard).mount()` 挂载
   - 卸载时移除容器和 Vue 实例
   - 确保防重复创建：如果容器已存在则更新内容而非新建
   - _需求：3.1、3.4、7.4_

- [ ] 9. 将总结流程集成到全文翻译入口
   - 修改 `entrypoints/main/trans.ts` 中的 `autoTranslateEnglishPage()` 函数：在函数开头（`isAutoTranslating = true` 之前），检查 `config.enablePageSummary` 是否开启且当前服务支持自定义 Prompt（`servicesType.isUseModel(config.service)`）
   - 如果满足条件，调用 `requestPageSummary()` 并通过自定义事件（`fluentread-summary-start`、`fluentread-summary-done`、`fluentread-summary-error`）通知 `PageSummaryCard` 组件更新状态
   - 总结请求与翻译流程**串行执行**，总结请求完成后，在每个翻译的内容前添加总结文本，让AI能够基于总结信息更准确地翻译
   - _需求：6.1、6.2、6.3、7.1_

- [ ] 10. 在撤销翻译时清理总结卡片与请求
   - 修改 `entrypoints/main/trans.ts` 中的 `restoreOriginalContent()` 函数：在现有清理步骤之后，添加移除总结卡片的逻辑（触发 `fluentread-summary-dismiss` 自定义事件或直接移除 `#fluent-read-page-summary-container` DOM 元素）
   - 如果总结请求仍在进行中，取消该请求（通过 AbortController 或断开 Port 连接）
   - 确保 `content.ts` 中通过右键菜单触发 `restore` 时、悬浮球点击恢复时、快捷键切换时，总结卡片都能被正确清理
   - _需求：3.4、6.4、7.2、7.3_
