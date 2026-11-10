# 调研：#26 精确触发链——非空实例列表下 omp 默认实例为何没到 composer

- 基线：`fork/main @ 05af23f608`（含 `e04e9b3c5d`，其上仅多 `b971a7550e` seed-pinned-runtime 脚本；所有 文件:行号 以此树为准，票面引用的 e04e9b3c5d 行号在相关文件上无漂移）。
- 方法：静态读码 + 本机 `~/.t3` 取证（迁移安装，与官方共享）。
- 关联票：#26（bug 本体）、#13（D1 验收）、#32（地图）、#35（方向票，本文 §5 供其引用）。

## 0. 结论摘要

1. **#26 的根因陈述不成立**：默认实例合成（`deriveProviderInstanceConfigMap`）是**无条件**的，与实例列表是否为空无关；迁移场景下服务端 registry **确实有** live 的 omp 实例，wire providers 列表里也带着它（`enabled: true`）。
2. **真实门在 client 侧的「未配置实例白名单」**：composer 拿到 wire 快照后，会用 **stored settings**（不含合成实例）重判每个条目的 `enabled`；不在 stored `providerInstances` 里的实例 id 一律走 `isUnconfiguredDefaultInstanceEnabled` 白名单 `{codex, claudeAgent}`——omp 不在名单 → 条目被判 disabled → 不可选、picker 隐藏、（强行选中时）服务端 dispatch 门同样拒绝。
3. **fresh「过」是假象**：fresh 的 stored 列表为空 → codex/claudeAgent 命中白名单成为唯一可选条目 → composer 回退选中 codex，能发送；omp 在 fresh 同样是 client-disabled（picker 里根本选不到 omp）。迁移场景唯一的差别是官方预置把 codex/claudeAgent 也存成了 `enabled: false` → 可选集合为空 → `noProviderAvailable` 阻塞。

## 1. Q1：合成实例在哪一跳「丢失」

结论：**不在 server 侧丢失，而是 client 侧被 `applyProviderInstanceSettings` 翻转成 disabled。** 逐跳：

- **hop 0 合成（server）**：`deriveProviderInstanceConfigMap`（`apps/server/src/provider/ProviderInstanceRegistryHydration.ts:50-79`）：从 stored `settings.providerInstances` 拷贝起步，对每个 built-in driver，只要 `metadata.hasDefaultInstance !== false`（omp 满足，`packages/provider-omp/src/server/driver.ts:44`）且 default id（= driver 同名 id，`packages/contracts/src/providerInstance.ts:107-108`）不在 stored 里，就合成 `{ driver }`（`ProviderInstanceRegistryHydration.ts:56-61`）。**没有任何「列表为空」检查。** omp 在 `BUILT_IN_DRIVERS`（`apps/server/src/provider/builtInDrivers.ts:35-49`）。
- **hop 1 registry**：启动 seed 用 derived map 建 registry（`ProviderInstanceRegistryHydration.ts:164-176`），变更走 watcher reconcile（:125-141）。`buildEntry` 对合成 omp：无 blockedReason、config 解码 `OmpSettings` 默认通过、`resolveEntryEnabled`（`apps/server/src/provider/ProviderInstanceRegistry.ts:126-131`）= `entry.enabled ?? configFlag ?? true` → **true** → `driver.create` 成功 → **live 条目**（`ProviderInstanceRegistry.ts:148-296`）。
- **hop 2 wire providers 列表**：registry 的 live/unavailable 都进 `ProviderRegistry` 的 providers 快照流（`apps/server/src/provider/ProviderRegistry.ts:366-369, 780-782`），omp 的 `ServerProvider` 快照带 `enabled: true`、status ready、16 模型——这正是 #26 观察到的「Providers 列表 Available」。
- **hop 3 client 翻转（丢失点）**：composer 的条目工厂 `providerInstanceEntriesFor`（`apps/web/src/providerInstances.ts:157-166`）= `deriveProviderInstanceEntries(providers)`（:55-76，此时 `enabled = snapshot.enabled = true`）→ `applyProviderInstanceSettings`（**:114-127**）：对每个条目调 `resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)`（`packages/contracts/src/settings.ts:1426-1440`）——omp **不在 stored `providerInstances`**（合成不落盘）→ 落到 `isUnconfiguredDefaultInstanceEnabled(instanceId)`（:1408-1409）→ 白名单 `DEFAULT_ENABLED_DEFAULT_INSTANCES = {codex, claudeAgent}`（**:1404-1406**）不含 omp → **false** → 条目 `enabled` 被翻转 true→false。该契约有测试钉死：「settings 里不存在的实例 = disabled」（`apps/web/src/providerInstances.test.ts:103-121`）。
- **hop 4 选择失败**：`resolveComposerProviderSelection`（`apps/web/src/components/ChatView.logic.ts:485-536`）：候选 id 全空的新 draft 回退到「首个 `enabled && isAvailable`」条目（`isSelectableProviderInstanceEntry`，`providerInstances.ts:211-212`；回退链 :516-526）→ 迁移场景没有任何条目通过 → `selectedProviderEntry === undefined` → `noProviderAvailable`（`apps/web/src/components/chat/ChatComposer.tsx:902-903`）。同时 omp 因 disabled 被 picker 隐藏（`isProviderInstancePickerVisible`，`providerInstances.ts:51-53`）。
- **hop 4.5 composer 死端**：`providerSetupInstanceId`（`ChatComposer.tsx:906-910`）取 `unavailableProviderInstanceId`（本场景为 undefined，omp 并非 unavailable）或首个 `hasProviderSetup` 条目；`hasProviderSetup`（`apps/web/src/components/chat/ProviderStatusBanner.tsx:60-65`）要求 antigravity 或 `setup.canAuthenticate/canInstall`，而 omp 快照三者皆否（本机 `~/.t3/caches/omp.json` 实证 `setup: {canAuthenticate: false, canInstall: false}`）→ undefined → 控制条按钮 disabled，文案「No provider available」（`apps/web/src/components/chat/ComposerControlsBar.tsx:255-268`）。composer 内没有任何可达的出口。
- **hop 5 服务端第二道同源门**：即使绕过 UI 选中 omp，发送前的 `assertProviderInstanceEnabled`（`apps/server/src/orchestration-v2/ThreadManagementService.ts:581-600`）调**同一个** `resolveProjectProviderInstanceEnabled` 对 stored settings 判定 → omp 缺席 stored → 白名单 false → 拒发。即该白名单同时是 client 选择门与 server dispatch 门。

## 2. Q2：#26 陈述的门在哪；真实分叉机制

- 「自动创建仅在实例列表为空时触发」**不成立**：合成循环（`ProviderInstanceRegistryHydration.ts:56-61`）无条件执行。**真实门 = `DEFAULT_ENABLED_DEFAULT_INSTANCES` 白名单**（`packages/contracts/src/settings.ts:1404-1409`），在两处生效：client `applyProviderInstanceSettings`（`apps/web/src/providerInstances.ts:114-127`）与 server dispatch（`ThreadManagementService.ts:581-600`）。设计意图（测试契约，`providerInstances.test.ts:76-121`）：**client 只信任 stored settings + 白名单**；server 的合成只服务 registry 运行态，永不写回 stored——两套真值在「stored 非空且不含该 driver」时分歧。
- 指定线索逐一判定：
  - `DEFAULT_ENABLED_DEFAULT_INSTANCES = {codex, claudeAgent}`（contracts/settings.ts:1404-1406）——**成立，即真实门**。
  - `packages/shared/src/serverSettings.ts:46-55`（`isModelSelectionProviderEnabled` 走 stored）/ :58-68（`TEXT_GENERATION_FALLBACK_DRIVERS` **不含 "omp"**）/ :70+（`fallbackTextGenerationModelSelection`）——**次生问题，非本次阻塞根因**：server 端 textGeneration 回退候选表天生不含 omp，`fallbackTextGenerationProvider`（`apps/server/src/serverSettings.ts:509-537`）的 enabled 回调对合成实例本会返回 true（`settings.providerInstances[instanceId] ?? { driver, config: {} }` → `defaultEnabledForDriver("omp")`=true，contracts/settings.ts:1411-1412、1414-1424），但 omp 根本进不了候选表 → omp 永远不会成为自动 textGeneration 回退（含 rate-limit 回退，`apps/server/src/textGeneration/TextGeneration.ts:106-119` 同表）。
  - `apps/server/src/serverSettings.ts:451-495`（`migrateLegacyProviderSettings` / `HISTORY_RESTORED_DRIVERS`）——**排除**：仅在 legacy providers blob 存在时触发（旧版格式迁移）；本机 `~/.t3/userdata/settings.json` 顶层键无 legacy blob，不触发。
  - `apps/server/src/policy/managedProviders.ts:369-380`（pin 驱动补实例）——**排除**：仅 managed policy `pins` 非空时在 effective 视图补 `{driver}`（注释明言「不落盘，直到用户编辑」）；自托管无 pins 即 no-op。但其形状恰是本 bug 的镜像：**derived 视图补实例 + 不持久化 + client 只认 stored**，只是它对 pinned driver 补的是 config overlay、且 managed 场景另有锁定语义。

## 3. Q3：fresh 过、迁移挂的最小差异对

**差异对 = stored `providerInstances` 里是否存在至少一个「client 侧判 enabled」的实例（实践上即白名单内的 codex/claudeAgent 是否被存成 disabled）。**

- fresh install：stored `providerInstances` 为空（dev 场景仅 `devReplay`）→ 合成全集进 registry；client 侧重判时 codex/claudeAgent 命中白名单 → 可选 → `resolveComposerProviderSelection` 回退选中 codex → composer 可发送。**omp 在 fresh 同样 client-disabled**（选不到、picker 隐藏），但没人会注意到，因为不阻塞。#13 D1 验收的四个断言（provider 列表出现、默认实例自动创建、status ready、模型目录）**全是 server-side 事实**（registry + providers 快照），所以 D1 通过与 composer 是否可选 omp 无关——「fresh 无此问题」实际是「fresh 不阻塞（由 codex 兜底）」，不是「fresh 能用 omp」。
- 迁移安装：官方 app 预置 codex/claudeAgent 均为 `enabled: false`（本机实证）→ 白名单条目全 disabled、omp 白名单外 → 可选集合为空 → `noProviderAvailable`。
- 本机取证（2026-11-10 读 `~/.t3/userdata/settings.json`，mtime 2026-11-09 22:03）：stored `providerInstances` = `pi`(enabled:false)、`claudeAgent`(enabled:false)、`codex`(enabled:false)、`cursor`(无 enabled 键 → `DEFAULT_DISABLED_PROVIDER_DRIVERS` 含 cursor，contracts/settings.ts:1398-1402 → disabled)、`omp`(displayName "omp", **enabled: true**)。其中 omp 条目即 #26 临时解法（手动 Add）的落盘——Add 前的状态才是 bug 态；Add 后 `Object.hasOwn` 命中 → `resolveProviderInstanceEnabled({driver, enabled:true})`=true → client 门与 dispatch 门同时放开（与 #26「临时解法已验证」完全吻合）。`~/.t3/caches/omp.json`（mtime 22:00）：status ready、v18.18.3、16 模型、`setup.canAuthenticate/canInstall` 均 false。dev 树 `~/.t3/dev/settings.json` 仅 `devReplay`。
- 路径关系：server settings 落 `~/.t3/userdata/settings.json`（dev 为 `~/.t3/dev/`），与官方共享（renamed 构建只改 Electron userData 目录名，不改 T3 home）——任何「写回 stored」的修复都会写进官方 app 的同一文件。

## 4. 为什么合成实例永不落盘

`deriveProviderInstanceConfigMap` 的唯一消费方（`apps/server/src/provider/ProviderInstanceRegistryHydration.ts:136,164-167`、`apps/server/src/provider/providerInstallation.ts:49`、`apps/server/src/terminal/Manager.ts:1444`）都只读 derived 结果，无一处回写 stored；服务端对 client 暴露的 settings（`getSettings` = materialized effective，`apps/server/src/serverSettings.ts:1337`，`toEffective` :681-685 只调 managed locks/limits 与 textGeneration 重解析，不动 `providerInstances`）也保持 stored 原样。合成实例因此只活在 registry 运行态。

## 5. 三个候选修复方向触及面（供 #35 引用）

### 方向 A：自动补建

- **A1（最小，一行级）**：把 `"omp"` 加进 `DEFAULT_ENABLED_DEFAULT_INSTANCES`（`packages/contracts/src/settings.ts:1404-1406`）。一处改动同时治愈 client 选择门（providerInstances.ts:114-127 经 contracts/settings.ts:1426-1440）、server dispatch 门（ThreadManagementService.ts:581-600）与 `isModelSelectionProviderEnabled`（shared/serverSettings.ts:46-55）。性质：白名单扩员，语义 = 「未配置的 omp 默认实例视为可用」。**可选附带**：把 `"omp"` 加入 `TEXT_GENERATION_FALLBACK_DRIVERS`（`packages/shared/src/serverSettings.ts:58-68`）让 omp 可成为自动回退；注意数组顺序即回退优先级，若放首位会改变 fresh 场景的默认 provider，建议排在 codex/claudeAgent 之后。风险面：改的是上游契约文件，rebase 冲突概率高于 app 层文件。
- **A2（补建 + 持久化）**：新增 built-in driver 无实例即 `updateProviderInstance({operation:"upsert", …})` 落盘默认实例，不要求列表为空。样板就在同文件：`seedDevReplayInstance`（`ProviderInstanceRegistryHydration.ts:90-123`，含「保留用户已有配置/开关」的 merge 语义 :115-121）。触及：`ProviderInstanceRegistryHydration.ts:50-79`（derive 或新函数：识别 derived-but-absent 的默认实例）+ layer 启动序列（:157-180，仿 seed 调用点）+ `ServerSettingsService.updateProviderInstance`（现成 API）。**必须决策的副作用**：`~/.t3` 与官方共享，落盘会把 omp 实例写进官方 app 的 settings.json（官方侧多出一个启用实例）；A2 相对 A1 的增益仅是「设置页显示已配置」与「白名单外的其他 driver 通用化」，可做成泛化 helper 但注意不要替 cursor/pi 等默认禁用 driver 翻 enabled。
- A1/A2 与 dispatch 门：A1 直接放开；A2 靠落盘使 `Object.hasOwn` 命中放开。

### 方向 B：composer 一键 Add

- `apps/web/src/components/chat/ChatComposer.tsx:906-910`：`providerSetupInstanceId` 派生扩展——`noProviderAvailable` 时除现有两源外，接受「server live 但 settings-disabled」条目（`entry.isAvailable && !entry.enabled`，如迁移场景的 omp；`providerInstanceEntries` 已含全部快照）。
- `apps/web/src/components/chat/ProviderStatusBanner.tsx:60-65`：`hasProviderSetup` 放宽或并行新增谓词（omp 快照 `setup.canAuthenticate/canInstall` 均 false，现谓词必 false）。
- `apps/web/src/components/chat/ComposerControlsBar.tsx:255-268`：按钮启用 + 文案改「Add <driver>」（现 disabled「No provider available」），点击走现有 `onOpenProviderSetup` → Settings→Providers 的 Add 流程（#26 已验证该流程端到端可用，Add 落盘后两道门同时放开）。
- 占位文案 :3262 / :3428（「Enable a provider in Settings」）可保留或按票内决策改词。
- 性质：纯 web 层、不改契约/server；只修 composer 死端（死端本身是独立可用性问题：即便有其他 provider 兜底，「选不到白名单外 driver 且无入口」仍在）。

### 方向 C：仅文档 workaround

- `docs/spec/omp-provider.md` §8（迁移并存场景）增补固定步骤：首启后 Settings→Providers→Add provider→omp→Next×2→Add instance（#26 已验证）；可在 `docs/fork/` 已知问题清单登记。
- 零代码风险、零 rebase 成本；代价是每个迁移安装必踩一次手动步骤，且 composer 死端（B 所述）不消失。

方向关系：A1 是唯一同时治愈两道门的最小改动；B 治 composer 死端、依赖 Add 流程落盘解 dispatch 门；C 可与任何方向叠加。

## 6. 证据清单

- 合成无条件：`apps/server/src/provider/ProviderInstanceRegistryHydration.ts:50-79`（:56-61 循环体）。
- 白名单及其两处生效点：`packages/contracts/src/settings.ts:1398-1440`；`apps/web/src/providerInstances.ts:114-127, 211-212`；`apps/server/src/orchestration-v2/ThreadManagementService.ts:581-600`。
- 选择回退与阻塞判定：`apps/web/src/components/ChatView.logic.ts:485-536`；`apps/web/src/components/chat/ChatComposer.tsx:874-913`（:902-903 noProviderAvailable）。
- composer 死端：`apps/web/src/components/chat/ComposerControlsBar.tsx:255-268`；`apps/web/src/components/chat/ProviderStatusBanner.tsx:60-65`。
- omp 元数据与注册：`packages/provider-omp/src/server/driver.ts:44`；`apps/server/src/provider/builtInDrivers.ts:35-49`。
- settings 透传不含合成：`apps/server/src/serverSettings.ts:681-685, 1337`。
- textGeneration 回退排除 omp：`packages/shared/src/serverSettings.ts:58-93`；`apps/server/src/serverSettings.ts:509-537`；`apps/server/src/textGeneration/TextGeneration.ts:106-119`。
- 测试契约：`apps/web/src/providerInstances.test.ts:60-121`（snapshot enabled 可被 stored settings 翻转；settings 缺席 = disabled）。
- 本机状态：`~/.t3/userdata/settings.json`（providerInstances 五条，见 §3）、`~/.t3/caches/omp.json`、`~/.t3/dev/settings.json`、`~/.t3/runtime/service-state.json`（activeVersion 0.1.7-omp.1）。
