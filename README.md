# 🫀 脂肪肝专病管理工作台（Fatty Liver Workbench）

连接**患者、医生、护士**的数字化慢病管理平台：患者院外填报（饮食/运动/指标）→ 医生工作台实时可见 → 护士宣教/指导/标准化评估 → MDT 多学科会诊闭环。

**架构**：Vercel Serverless Functions（Node.js 22）+ Vue 3 双前端 + **无数据库**存储（Upstash Redis / Vercel KV + Vercel Blob + Edge Config，未配置时自动降级内存演示模式）。

---

## 📁 项目结构

```
fat-liver-workbench/
├── api/                        # Vercel Serverless Functions（/api/v1 经 rewrite 映射）
│   ├── _lib/                   #   基础设施：存储适配/认证/校验/限流/日志/种子数据
│   ├── auth/                   #   登录(密码+验证码+注册) / 刷新 / 登出 / 短信
│   ├── patients/               #   患者列表/详情/时间轴/趋势/随访/复诊/MDT/检验
│   ├── records/                #   患者填报：饮食/运动/指标/图片上传
│   ├── messages/               #   消息中心（宣教/复诊提醒/已读）
│   ├── nurse/                  #   宣教推送 / 个案指导 / 标准化评估模板
│   ├── mdt/  reports/  cron/   #   MDT列表 / 评估报告 / 定时任务
│   ├── dashboard.js            #   医护工作台聚合
│   ├── config.js               #   全局配置（专家库/素材/模板/医学范围）
│   ├── health.js               #   健康检查
│   └── docs.js  openapi.js     #   Swagger UI + OpenAPI 3.0
├── apps/
│   ├── admin-web/              # 医生端 + 护理端（Vue3 + Vite + Element Plus + ECharts）
│   └── patient-h5/             # 患者端 H5（Vue3 + Vite，移动端）
├── packages/shared/            # 前后端共享：医学数值范围/枚举/校验规则（UMD 双模式）
├── landing/index.html          # 根路径落地页（三端入口）
├── scripts/                    # smoke 冒烟测试 / 落地页拷贝
├── vercel.json                 # rewrites + crons + headers
└── .env.example                # 环境变量说明（全部可选）
```

## 🚀 一键部署到 Vercel

### 方式一：Git 导入（推荐）
1. 将本项目推送到 GitHub/GitLab 仓库
2. Vercel 控制台 → **Add New… → Project** → 导入仓库
3. Framework Preset 选 **Other**（vercel.json 已配置好 build/output/rewrites，无需改动）
4. 点击 **Deploy** ✅

### 方式二：CLI
```bash
npm i -g vercel
vercel          # 首次部署预览环境
vercel --prod   # 生产部署
```

部署完成后访问：
- `/` — 三端入口落地页
- `/admin/` — 医生端/护理端
- `/patient/` — 患者端 H5
- `/api/health` — 健康检查（可查看当前存储模式）

## 🔑 演示账号（开箱即用）

| 端 | 账号 | 密码 | 说明 |
|---|---|---|---|
| 医生 | `GBMZ` | `123456` | 肝病科主任医师，9名模拟患者 |
| 护士 | `HULI01` | `123456` | 宣教推送/个案指导/评估模板 |
| 患者 | `13800000001` | `123456` | 患者端 H5，验证码登录时验证码直接显示在页面 |

> 未配置任何环境变量时即**演示模式**：内存存储 + 自动播种模拟数据（重启后重置）。
> 患者**注册**后自动建立健康档案并归入 GBMZ 医生名下（演示默认分配）。

## 🗄️ 开启持久化（生产建议）

在 Vercel 项目 → **Storage** 标签页：

| 组件 | 操作 | 自动注入的环境变量 |
|---|---|---|
| Upstash Redis（替代已停售的 Vercel KV） | Create Database → Upstash Redis | `KV_REST_API_URL` `KV_REST_API_TOKEN` |
| Vercel Blob | Create Store → Blob | `BLOB_READ_WRITE_TOKEN` |
| Edge Config（可选） | Create Store → Edge Config | `EDGE_CONFIG` |

再手动添加一个环境变量：

| 变量 | 必要性 | 说明 |
|---|---|---|
| `JWT_SECRET` | 生产必填 | JWT 签名密钥（随机 ≥64 位字符串） |
| `CRON_SECRET` | 建议 | Cron 保护，配置后定时任务需 `Authorization: Bearer` |
| `SMS_KEY` | 可选 | 未配置时验证码以演示模式直接返回 |
| `ENABLE_API_DOCS` | 可选 | `true` 在生产环境开放 /api/docs |

重新 **Deploy** 后，`/api/health` 中 `storage: "redis"`、`blob: true` 即为持久化就绪。

## ⏰ 定时任务（Vercel Cron）

`vercel.json` 已配置：`/api/cron/followup-remind`，每天 UTC 01:00（北京时间 09:00）执行：
1. **随访提醒** — 扫描当日应随访患者，推送消息至患者端
2. **数据快照** — 患者档案+记录备份（Blob 优先，KV 兜底 30 天）
3. **过期清理** — 清理已过期的随访集合
4. **审计归档** — 近期埋点/审计数据聚合

## 🔐 安全设计

- **认证**：JWT 15min Access + 7d Refresh（KV 存储可吊销，轮换机制）
- **密码**：前端 `sha256(password + 盐)` 传输，服务端 `bcrypt` 存储
- **授权**：RBAC 三角色；医生数据强隔离（`patient.docId === token.uid`）；患者仅能访问本人数据
- **医学校验**：前后端共享同一份 `MED_RANGES` 范围（硬校验 422）+ 建议阈值（软提醒）
- **并发**：乐观锁（version 冲突 409）+ 分布式锁（SET NX EX）+ 幂等键（`X-Idempotency-Key`）
- **限流**：登录 10次/分/IP，填报 30次/分/用户，默认 120次/分/用户
- **XSS**：宣教富文本 DOMPurify 白名单过滤；CSP/X-Frame-Options 响应头
- **审计**：全部写操作 who/when/what + requestId，Blob 月度归档

## 📊 数据埋点

`patient_register` / `data_submit` / `doctor_view_detail` / `mdt_initiate` 按日写入 KV，Cron 每日聚合。

## 🧪 本地开发与验证

```bash
npm install            # 安装全部依赖（npm workspaces）
npm run smoke          # 后端集成冒烟测试（41 项断言，内存模式直调全部 handler）
npm run build          # 构建双前端 + 落地页 → dist/
vercel dev             # 本地完整运行（含 API），访问 http://localhost:3000
```

## 📌 实现说明（与文档差异点）

1. **Upstash Redis**：Vercel KV 产品线已迁移至 Storage Marketplace（Upstash），本项目的 `@upstash/redis` 使用的 `KV_REST_API_URL/TOKEN` 变量与 Vercel KV 完全兼容，Storage 添加 Upstash 后自动注入。
2. **无 Express**：技术方案允许"原生 Vercel handler"，已采用更轻的原生方案（统一 `defineHandler` 编排：requestId/CORS/鉴权/限流/幂等/日志/错误兜底），冷启动更小。
3. **患者端**：PRD 允许"uni-app/H5"，采用 Vue3 + Vite 轻量 H5（与 admin 同栈，无需额外构建链）。
4. **医生检验录入**：为满足 PRD"趋势分析Tab 含肝功能指标曲线"，新增 `POST /api/patients/:id/labs`（ALT/AST/GGT/甘油三酯），仅主管医生可录入。
5. **演示模式降级**：所有存储依赖均可缺席运行（内存兜底），保证"一键部署即可体验"；接入 Storage 后无需改任何代码。
