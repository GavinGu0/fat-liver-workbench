# Vercel 自动构建 PARSE_ERROR 分析与解决方案

> 日期：2026-09-11
> 现象级别：构建失败（所有 GitHub 推送触发的自动构建均失败，耗时约 22s）
> 状态：已解决

## 一、错误现象

每次推送代码到 GitHub 后，Vercel 自动构建持续失败，日志尾部出现：

```
2026-09-10T18:58:36.048Z  Error: Build failed with 15 errors:

[PARSE_ERROR] Error: Unexpected JSX expression
╭─[ src/App.vue:1:1 ]
│ Help: JSX syntax is disabled and should be enabled via the parser options

[PARSE_ERROR] Error: Unexpected token
╭─[ src/views/nurse/Templates.vue:1:1 ]
1 │ <template>
  │ ┬
  │ ╰──

[PARSE_ERROR] Error: Unexpected token
╭─[ src/views/Login.vue:1:1 ]
...
（共 15 个，全部是 .vue 文件）
```

受影响对象：Vercel 项目 **`fat-liver-workbench-web`**（连接 GitHub 仓库自动构建的项目）。

## 二、根因分析

### 2.1 关键排查结论

| 排查项 | 结论 |
|---|---|
| `.vue` 文件本身是否有语法错误 | **没有**。文件首字节无 BOM（`60 74 65...` = `<template`）、编码为标准 UTF-8 |
| Vue 3 SFC 模板语法是否合规 | **合规**。同一份代码在另一配置正确的 Vercel 项目（`fat-liver-workbench`）构建成功（2256 模块，13s） |
| 本地构建是否正常 | **正常**。`npm run build`（admin-web + patient-h5 + landing）全部通过 |
| 错误出自哪个工具 | **oxc 解析器**（Rust，Vercel 的 Node 框架后处理链使用），把 `.vue` 源文件当**纯 JavaScript** 解析，因此第一个 `<template>` 标签就报 "Unexpected token"；`Help: JSX syntax is disabled...` 是 oxc 的典型提示 |

### 2.2 根本原因：项目配置错误，而非代码错误

对比两个 Vercel 项目设置：

| 设置 | fat-liver-workbench（构建正常） | fat-liver-workbench-web（持续失败） |
|---|---|---|
| Framework Preset | （空） | **`node`** |
| Root Directory | （空，仓库根目录） | **`apps/admin-web`** |
| Git 集成 | 未连接 | ✓ 已连接（推送自动触发） |

由此产生三个连锁问题：

1. **根目录 `vercel.json` 被完全忽略**——Vercel 只读取 Root Directory 内的 `vercel.json`。原 `vercel.json` 中的 `installCommand` / `buildCommand`（根 workspace 全量构建两个前端 + landing）/ `rewrites` / `headers` / `crons` 全部失效。
2. **Framework Preset = `node` 触发 Node 应用构建管线**——构建命令跑完后，Vercel 的 Node 框架后处理（基于 oxc 的源码解析/文件追踪）扫描源码目录，将 15 个 `.vue` 文件当作普通 JS 解析 → PARSE_ERROR × 15 → 构建失败。这是**解析器用错了语言模式**，不是模板语法问题。
3. **产物目录错位**——admin-web 的 vite 配置输出到 `../../dist/admin`（仓库根的 dist），在 Root Directory = `apps/admin-web` 时该目录在项目根之外，即使解析通过也无法正确部署；且 `/api` 函数、`crons` 位于仓库根目录，Root Directory 设置使其永远无法进入部署产物。

### 2.3 为什么 vite build 日志显示成功却最终失败

失败日志中 `vite v5.4.21 building for production... ✓ built in 12.70s` 是构建命令本身成功（vite/rollup 正确处理了 SFC）。失败发生在**构建命令之后的框架后处理阶段**，与 vite 无关。这也是"文件语法没问题"的直接证据。

## 三、解决方案

**修正 `fat-liver-workbench-web` 项目设置**（通过 Vercel API `PATCH /v9/projects/{id}`）：

```jsonc
{
  "framework": null,      // 原 "node" → 置空（Other），由仓库根 vercel.json 驱动
  "rootDirectory": null   // 原 "apps/admin-web" → 置空（仓库根目录）
}
```

修正后该项目与构建正常的 `fat-liver-workbench` 配置完全一致：

- 从仓库根目录构建，`vercel.json` 生效（根 `npm run build` 会依次构建 admin-web、patient-h5、landing）
- Framework Preset 为空 → 不再触发 Node 管线的 oxc 源码扫描 → PARSE_ERROR 消失
- `/api` 单函数分发、`rewrites`、`crons`（每日随访提醒）随部署正常生效

## 四、验证结果

1. **本地验证**：仓库根 `npm run build` 全量通过（admin-web 2256 模块 + patient-h5 + landing 拷贝）。
2. **同代码交叉验证**：`fat-liver-workbench` 项目（相同仓库内容、正确配置）生产部署 Ready，无任何解析错误。
3. **推送后验证**：提交本文档触发 git 自动构建，`fat-liver-workbench-web` 最新部署 **Ready**，构建日志无 PARSE_ERROR。

## 五、预防措施

1. **monorepo + 仓库根 vercel.json 的项目，Vercel 的 Root Directory 必须保持为空**（仓库根）。除非该子目录自含完整可独立部署的 `vercel.json`、API 函数与 cron，否则不要设置 Root Directory。
2. **Framework Preset 不要手动选 "Node"**：本项目实际是 "静态前端 + 单个 API 函数" 结构，由 `vercel.json` 显式声明 install/build/output。手动选 Node 会引入函数化后处理管线（含 oxc 源码扫描），对含 `.vue/.md` 等非 JS 文件的目录会误报解析错误。
3. **快速判别此类问题**：看到 `.vue` 文件在 1:1 `<template>` 处报 PARSE_ERROR，而 vite/本地构建正常 → 一定是"某个环节把 SFC 当纯 JS 解析"，优先检查构建管线与部署平台配置，而不是改代码。
4. **import 顺序注意**：若未来为 monorepo 子包单独建 Vercel 项目，需在子包内提供自足的 `vercel.json`（含 API 路由或显式指向根构建），并在 UI 中核对 Root Directory / Framework / Build / Output 四项与之一致。
5. **npm ≥11 的 allow-scripts 提示**（esbuild/vue-demi postinstall 被拦截的 warning）与本错误无关，属构建环境安全特性提示；esbuild 二进制经 optional 依赖仍正常加载。如遇 vite 无法启动 esbuild 的报错，再在 Vercel 项目设置中放行对应 install scripts。
