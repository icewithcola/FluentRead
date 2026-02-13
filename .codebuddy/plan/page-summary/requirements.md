# 需求文档

## 引言

FluentRead 是一个浏览器翻译插件，当前支持全文翻译、悬浮翻译、划词翻译等功能。本需求旨在新增**页面总结（Page Summary）**功能：在用户触发全文翻译时，先使用与翻译相同的 AI 模型（但使用固定的总结专用 Prompt）对当前页面内容进行一次概括性总结，总结完成后再执行正常的翻译流程。

该功能的核心价值在于：用户在阅读外文页面时，可以先快速了解页面的主旨和关键信息，再决定是否继续深入阅读翻译内容，从而提高阅读效率。

### 技术背景

- 当前项目使用 `config.service` 选择翻译服务（如自定义 LLM 接口、Chrome 内置翻译、Google 翻译等）
- 翻译请求通过 `translateText` / `translateTextStream` 统一入口发送，经 background 脚本转发给对应的翻译服务
- 消息模板由 `commonMsgTemplate` 构建，包含 `system_role` 和 `user_role`
- 现有翻译缓存机制基于 `localStorage`，通过 `cache.localSet` / `cache.localGet` 操作
- 全文翻译由 `autoTranslateEnglishPage()` 触发，通过 `IntersectionObserver` 逐步翻译可见节点
- 翻译进度面板（`TranslationStatus.vue`）已有参考实现
- 使用 bun 作为构建工具

## 需求

### 需求 1：页面总结功能开关

**用户故事：** 作为一名 FluentRead 用户，我希望可以在插件设置中开启或关闭页面总结功能，以便根据自己的需求选择是否在翻译前查看页面摘要。

#### 验收标准

1. WHEN 用户打开插件设置页面 THEN 系统 SHALL 在高级选项区域显示"翻译前总结页面"开关（`config.enablePageSummary`），默认值为关闭
2. WHEN 用户切换"翻译前总结页面"开关 THEN 系统 SHALL 立即保存该配置，并在后续全文翻译中按照新配置执行
3. IF 当前选择的翻译服务不支持自定义 Prompt（如 Google 翻译、Chrome 内置翻译）THEN 系统 SHALL 禁用该开关并显示提示"当前翻译服务不支持页面总结功能"

### 需求 2：页面内容采集与总结请求

**用户故事：** 作为一名 FluentRead 用户，我希望在触发全文翻译时系统能自动采集页面的关键文本并发送给 AI 进行总结，以便快速获得页面概要。

#### 验收标准

1. WHEN 用户触发全文翻译（通过悬浮球、快捷键或右键菜单）AND 页面总结功能已开启 THEN 系统 SHALL 在开始翻译前，先采集页面的主体文本内容
2. WHEN 系统采集页面文本 THEN 系统 SHALL 提取 `document.body` 中的可见文本内容，去除脚本、样式、导航等无关内容，并截断到合理长度（建议最多 3000 字符），以避免超出模型 token 限制
3. WHEN 系统准备好页面文本 THEN 系统 SHALL 使用当前配置的翻译服务（`config.service`）和对应的 API 地址、Token，但使用**固定的总结专用 Prompt**（而非翻译 Prompt）发送请求
4. WHEN 总结 Prompt 被构建 THEN 系统 SHALL 使用固定的 system_role（如："You are a professional content summarizer."）和固定的 user_role（如："Please summarize the following webpage content in {{to}} language, in 2-3 concise sentences:\n\n{{content}}"），其中 `{{to}}` 替换为用户的目标语言，`{{content}}` 替换为采集到的页面文本
5. IF 页面文本内容过短（少于 50 个有意义字符）THEN 系统 SHALL 跳过总结步骤，直接进入翻译流程

### 需求 3：总结结果展示

**用户故事：** 作为一名 FluentRead 用户，我希望能看到页面总结的结果，并在合适的位置展示，以便在翻译内容加载之前快速了解页面大意。

#### 验收标准

1. WHEN 总结请求成功返回结果 THEN 系统 SHALL 在页面顶部（或 `body` 首部）插入一个总结卡片（带有明显的样式标识，如背景色、图标等），展示总结内容
2. WHEN 总结卡片被展示 THEN 系统 SHALL 包含以下元素：标题（如"📝 页面总结"）、总结文本内容、关闭按钮
3. WHEN 用户点击总结卡片上的关闭按钮 THEN 系统 SHALL 移除该卡片
4. WHEN 用户执行"撤销翻译"操作 THEN 系统 SHALL 同时移除总结卡片
5. IF 总结请求失败 THEN 系统 SHALL 不阻塞翻译流程，在控制台打印错误信息，并直接进入翻译阶段

### 需求 4：总结进度展示

**用户故事：** 作为一名 FluentRead 用户，我希望能看到页面总结的进度状态，以便了解总结是否正在进行中。

#### 验收标准

1. WHEN 总结请求开始发送 THEN 系统 SHALL 在总结卡片位置显示加载动画（如 spinner 或 "正在总结页面内容..."）
2. WHEN 总结请求完成（无论成功或失败）THEN 系统 SHALL 移除加载动画
3. IF 翻译服务支持流式传输（`config.useStream` 为 true）THEN 系统 SHALL 以流式方式逐步展示总结内容，提供更好的用户体验

### 需求 5：总结结果缓存

**用户故事：** 作为一名 FluentRead 用户，我希望页面总结的结果能够被缓存，以便再次翻译同一页面时不需要重复请求总结。

#### 验收标准

1. WHEN 总结请求成功返回 AND 缓存功能已开启（`config.useCache` 为 true）THEN 系统 SHALL 将总结结果缓存到 `localStorage`，缓存 key 应包含页面 URL 信息（如 `fr_summary_${url}`），以区别于翻译缓存
2. WHEN 用户再次在同一页面触发全文翻译 AND 缓存中存在该页面的总结结果 THEN 系统 SHALL 直接从缓存读取总结结果并展示，跳过总结请求
3. WHEN 用户主动清除缓存（通过插件设置中的清除缓存功能）THEN 系统 SHALL 同时清除所有总结缓存
4. WHEN 缓存的总结结果被读取 THEN 系统 SHALL 不重复计入翻译次数（`config.count`）

### 需求 6：全文翻译流程集成

**用户故事：** 作为一名 FluentRead 用户，我希望页面总结和全文翻译能够无缝衔接，以便获得流畅的使用体验。

#### 验收标准

1. WHEN 总结功能开启时触发全文翻译 THEN 系统 SHALL 按以下顺序执行：①发起总结请求 → ②展示总结结果 → ③开始全文翻译
2. WHEN 总结请求正在进行中 THEN 系统 SHALL 不阻塞翻译流程——总结请求可与翻译流程并行执行，即总结发出后立即开始翻译
3. IF 总结请求超时（建议 15 秒）THEN 系统 SHALL 取消总结请求，正常继续翻译流程
4. WHEN 用户在总结过程中点击"撤销翻译" THEN 系统 SHALL 同时取消总结请求和翻译任务

### 需求 7：边界情况处理

**用户故事：** 作为一名 FluentRead 用户，我希望页面总结功能在各种异常情况下都能正常降级，不影响核心翻译功能的使用。

#### 验收标准

1. IF 页面内容主要是目标语言（与 `config.to` 相同）THEN 系统 SHALL 跳过总结步骤
2. IF 翻译服务的 API 返回错误（如 401、429 等）THEN 系统 SHALL 仅记录错误日志，不影响后续翻译流程
3. IF 用户快速连续触发全文翻译 THEN 系统 SHALL 只执行一次总结请求（防抖处理）
4. IF 页面已经存在总结卡片（如之前未关闭）THEN 系统 SHALL 更新已有卡片的内容，而非创建新卡片
