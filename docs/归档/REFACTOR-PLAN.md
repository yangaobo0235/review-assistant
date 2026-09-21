# Review Assistant 改造方案

> **这是一份历史方案，不是现行架构说明。** 现行架构以 [docs/索引.md](../索引.md)
> 下的文档和当前代码为准。
>
> 阅读前请注意三件事：
>
> 1. **本文的状态描述自相矛盾，不要采信。** 下面的状态表写「阶段 1–11 全部完成」，
>    而正文里仍有多处「🔶 进行中」的标记（例如「阶段 4 · 业务扩展包」）。两者
>    无法同时成立，本文不再逐处修正。
> 2. **本文描述的问题多数已经修复。** 例如第一部分断言车源页面在采集阶段会被
>    丢弃图片（两道硬门禁），当前代码已经参数化，该问题不存在。
> 3. **正文引用的文档路径已全部失效。** 本文写于文档重排之前，正文沿用的
>    `docs/architecture.md` 等旧路径都不再存在（开头有一张新旧对照表）。

## 核心目标：新增审核页面时，改动最小

| 项目 | 内容 |
| --- | --- |
| 核心目标 | 未来会有各类审核页面；新增一个页面的改动量必须收敛到"写一份声明" |
| 次要目标 | 降低日常"待处理"数量（独立支线） |
| 代码基线 | `main` 分支，47 次提交 |
| 方案状态 | **阶段 1–11 全部完成，复查收尾完成**（第七部分）；例外是阶段 10 只做了后端目录，前端映射未执行（见阶段 10 补记）；阶段 0.1 的统计脚本需要生产数据，未执行 |
| 编制依据 | `docs/指南/改动与发布准则.md`、`docs/概念/审核流水线.md`、`docs/概念/字段与判定规则.md` |
| 执行方式 | 本地改造，不建分支、不提交 |

> **文档路径说明**：本文写于阶段 11 的文档重排**之前**，正文里的引用沿用当时的
> 文件名。对照关系如下，正文不再逐条改写。
>
> | 当时的路径 | 现在的路径 |
> | --- | --- |
> | `docs/ai-change-policy.md` | `docs/指南/改动与发布准则.md` |
> | `docs/testing-and-release.md` | `docs/指南/改动与发布准则.md`（验收段） |
> | `docs/architecture.md` | `docs/概念/系统定位.md` |
> | `docs/business-rules.md` | `docs/概念/字段与判定规则.md` |
> | `docs/business-rules/*.md` | `docs/业务/*.md` |
> | `docs/review-pipeline.md`、`docs/langgraph.md` | `docs/概念/审核流水线.md`、`docs/概念/一次审核的链路.md` |
> | `docs/registries-and-subgraphs.md` | `docs/概念/规则主图与能力.md` |
> | `docs/extension-guide.md` | `docs/指南/新增业务与页面.md` |
> | `docs/glossary.md` | `docs/参考/术语表.md` |
> | `docs/logging.md` | `docs/参考/日志与排查.md` |
> | `docs/frontend-presentation.md` | `docs/参考/工作台展示.md` |
> | `docs/server-deployment.md` | `docs/指南/部署.md` |

---

# 第一部分 · 现状：新增一个页面要付出什么

## 1.1 一个真实案例：车源审核页面

以"车况承诺书 / 车源"页面为例：

| 维度 | 车源页面 | 现有报废置换 |
| --- | --- | --- |
| 表单字段 | 约 40 个（含规格参数：品牌、车系、驱动形式、最大马力、排放标准、变速箱型号、轮胎规格、总质量…） | 25 个 |
| 材料分组 | 车况承诺书 / 证件照 / 车况照片 | 报废车辆资料 / 新车资料 / 营业执照… |
| 材料类型 | 含**铭牌**（nameplate）、**车况承诺书** | 行驶证 / 登记证 / 回收证明 / 发票 / 营业执照 / 身份证 |
| 业务分区 | 单车（无旧车/新车之分） | 旧车 / 新车 |
| 业务规则 | 车况与价格核对 | 补贴政策窗口 + 主体关系 |

**字段命名空间、材料类型、业务分区三者都与现有业务不同。**

## 1.2 两道硬门禁：今天跑不通

### 门禁 A · 前端在采集阶段丢弃车源的图片

`review-extension/src/browser/image-candidates.ts`：

```javascript
const businessPattern = /回收证明|报废证明|报废车辆资料|旧车资料|登记证书|机动车登记证|新车资料|发票|营业执照|身份证/;

const eligible = (candidate) => {
  if (candidate.businessScope === "other") return false;      // ← 直接丢弃
  ...
  return knownTypes.has(candidate.categoryHint)
      || businessPattern.test(candidate.hint || "")
      || width * height >= 40_000;
};

const score = (candidate) => {
  const scopeScore = ["old_vehicle", "new_vehicle"].includes(candidate.businessScope) ? 10_000_000 : 0;
};
```

| 位置 | 问题 |
| --- | --- |
| `:15` `businessPattern` | 车源的分组标签（车况承诺书、证件照、车况照片、铭牌）一个都不匹配 |
| `:18` `other` 直接丢弃 | 不被识别的标签落入 `other`，**整组图片被扔掉** |
| `:32` `scopeScore` | 仅 `old_vehicle` / `new_vehicle` 得 1000 万分，车源 scope 得 0 |

`review-extension/src/browser/business-scope.ts:12-27` 的分组标签表同样只有报废置换那一套。

**结果：车源页面点击"开始审核"，图片采集结果大概率为空。**

### 门禁 B · 后端有硬编码的业务范围门

`review-agent-service/app/agent/field_routing.py:58`：

```python
if business_scope not in {"old_vehicle", "new_vehicle"}:
    return {}, "图片业务归属无法确定，请人工复核"
```

**任何新业务范围在这一行直接出局**，字段全部路由不出来。

### 结论

车源页面**不是"配置一下就能用"，而是两端都要动结构**。

## 1.3 新增一个业务的完整改动清单

| # | 文件 | 改动内容 | 性质 |
| --- | --- | --- | --- |
| 1 | `review-extension/src/browser/business-scope.ts` | 加分组标签 | 硬编码表 |
| 2 | `review-extension/src/browser/image-candidates.ts` | 加业务关键词、放宽 scope 判断 | 硬编码正则 |
| 3 | `review-extension/src/browser/page-field-collector.ts` | **加 40+ 字段的中文别名** | 硬编码表 |
| 4 | `review-extension/src/components/workbenchRenderers.tsx` | 注册 Renderer key | 注册表 |
| 5 | `app/agent/field_routing.py` | 放开 scope 门、加材料×字段路由 | 硬编码 if-else |
| 6 | `app/agent/document_policies.py` | 加材料策略 + `fields_for_scope` 分支 | 硬编码 if-else |
| 7 | `app/rules/normalize.py` | 加"数字+单位"归一化器（500000公里 / 25吨 / 520马力 / 货箱长度米） | 按字段名分派 |
| 8 | `app/rules/review_fields.py` | 加字段清单 + 中文标签 | 硬编码表 |
| 9 | `app/rules/field_evidence_policies.py` | 加字段证据来源白名单 | 声明式 |
| 10 | `app/businesses/profiles.py` | 把 `VEHICLE_SOURCE_DEFAULT` 换成真实 Profile | 声明式 |
| 11 | `app/businesses/material_policies.py` | 材料策略 | 声明式 |
| 12 | `app/businesses/context_validation.py` | 路由白名单加 `/vehicle-source` | 硬编码 |
| 13 | `app/agent/workflow.py` | 注册新能力 handler | 注册表 |
| 14 | `app/rules/task_presentation.py`、`review_step_routing.py` | 可能需加映射表项 | 硬编码表 |
| 15 | 前端 Renderer | 可能复用通用 `ReviewTaskWorkbench` | 注册表 |

**约 15 个文件，其中 6-7 处是硬编码映射表。**

> `docs/business-rules/changchun-scrap-replacement.md:76` 明确规定「**禁止复制青岛配置再改几个字符串**」。但满足这条规则的机制不存在——所以每新增一个业务都在违反自己的规则。这不是纪律问题，是缺一层抽象。

## 1.4 根因一：同一个矩阵，五份投影

业务知识的本质是一张表：

```
业务 × 材料类型 × 字段 × 业务分区
```

但它被投影到五处，各写一份：

| 投影 | 位置 | 作用 |
| --- | --- | --- |
| 路由 | `app/agent/field_routing.py` | 材料字段 → 领域字段 |
| 提取白名单 | `app/agent/document_policies.py` 的 `fields_for_scope` | 材料 → 可读字段 |
| 证据来源 | `app/rules/field_evidence_policies.py` | 字段 → 可信材料 |
| 字段清单 | `app/rules/review_fields.py` | 字段 → 中文标签 |
| DOM 别名 | `review-extension/src/browser/page-field-collector.ts` | 字段 → 页面文字 |

**五份投影之间没有任何一致性校验。** 新增业务要在五处各改一遍；改漏一处不报错，只会静默降级为"人工复核"。

## 1.5 根因二：目录把"业务"和"引擎"混在一起

后端 68 个 Python 文件中，`app/rules/` 独占 21 个（30%），里面混装五类东西：

| 类别 | 文件 |
| --- | --- |
| 比对引擎 | `aggregate.py`、`check_results.py`、`evidence_values.py`、`compare.py`（死） |
| **注册表** | `capability_registry.py`、`business_rule_registry.py`、`external_check_registry.py` |
| **能力契约** | `capabilities.py` |
| 业务规则 | `affiliation_subject_checks.py`、`replacement_policy_checks.py`、`material_completeness.py`、`composite_fields.py` |
| 字段定义 | `review_fields.py`、`field_evidence_policies.py`、`normalize.py` |
| 展示装配 | `task_presentation.py`、`review_step_routing.py`、`final_advice.py` |
| 死代码 | `cross_document.py`、`cross_document_common.py` |

同时，**业务知识被埋在技术层目录下**：

| 文件 | 内容 | 性质 |
| --- | --- | --- |
| `app/agent/document_policies.py` | 材料白名单、读取指引（"登记证只能读 VIN 不能读发动机型号"） | **业务知识** |
| `app/agent/field_routing.py` | 材料字段 → 领域字段 | **业务知识** |

**后果：加业务的人不知道要改哪里；改引擎的人可能误改业务规则。**

---

# 第二部分 · 目标架构

## 2.1 数据层：一份声明，五处派生

### 业务扩展包（`BusinessExtensionPack`）

```python
# app/businesses/packs/vehicle_source.py（一个业务一份）

@dataclass(frozen=True)
class FieldDeclaration:                      # 字段声明
    key: str                                 # "vehicle_source.brand"
    label: str                               # "品牌"
    scope: str                               # "vehicle_source"
    section: str                             # "规格参数"
    aliases: tuple[str, ...] = ()            # DOM 别名（下发给前端）
    normalizer: str = "text"                 # 归一化器名
    sources: tuple[str, ...] = ()            # 允许的材料类型
    authority: tuple[AuthorityRule, ...] = ()  # 权威链

@dataclass(frozen=True)
class MaterialDeclaration:                   # 材料声明
    document_type: str                       # "nameplate"
    display_name: str                        # "车辆铭牌"
    fields: tuple[str, ...]                  # 该材料可提取字段
    hints: tuple[str, ...]                   # 页面分组文字（供前端匹配）
    guidance: str = ""                       # 读取指引

@dataclass(frozen=True)
class ScopeDeclaration:                      # 业务分区声明
    key: str                                 # "vehicle_source"
    title: str                               # "车况信息"

@dataclass(frozen=True)
class BusinessExtensionPack:                 # 业务扩展包
    profile: BusinessProfile
    policy: BusinessPolicy
    scopes: tuple[ScopeDeclaration, ...]
    fields: tuple[FieldDeclaration, ...]
    materials: tuple[MaterialDeclaration, ...]
```

### 五份投影如何派生

| 现有位置 | 改为从 pack 派生 |
| --- | --- |
| `field_routing.py` 的 if-else | `pack.fields` 的 `scope` + `sources` 生成查找表 |
| `document_policies.fields_for_scope` | `pack.materials[].fields` |
| `field_evidence_policies` | `pack.fields[].sources` |
| `review_fields.py` | `pack.fields` |
| 前端 `FIELD_DEFINITIONS` / `business-scope` / `businessPattern` | **采集清单接口下发** |

**关键性质**：五份投影同源，**结构上不可能不一致**。并可复用现有启动期校验机制（`app/agent/workflow.py:177-209`）在启动时断言一致性。

### 前端成为消费者

后端下发采集清单：

```
GET /api/review/collect-manifest?business=vehicle_source&region=default

{
  "scopes":    [{"key": "vehicle_source", "title": "车况信息"}],
  "sections":  [{"key": "basic", "title": "基础信息"}, {"key": "spec", "title": "规格参数"}],
  "fields":    [{"key": "vehicle_source.brand", "label": "品牌",
                 "aliases": ["品牌"], "section": "spec", "scope": "vehicle_source"}],
  "materials": [{"document_type": "nameplate", "label": "铭牌", "hints": ["铭牌", "车辆铭牌"]}]
}
```

前端三处硬编码全部消失：

| 现有硬编码 | 改为 |
| --- | --- |
| `page-field-collector.ts` 的 `FIELD_DEFINITIONS` | 消费 `fields[]` |
| `business-scope.ts` 的分组标签表 | 消费 `materials[].hints` |
| `image-candidates.ts` 的 `businessPattern` 正则 | 由 `materials[].hints` 生成 |

## 2.2 目录层：业务与引擎分离

**核心原则：引擎层不知道任何业务；`businesses/` 只有业务。**

```
app/
├── main.py                 入口
├── api/                    路由（从 main.py 拆出）
│
├── models/                 协议模型（保持）
├── fields/                 字段规格 + 归一化 + 差异
│                           ← 吸收 rules/normalize.py、rules/review_fields.py 的规格部分
├── compare/                比对与聚合           ← 从 rules/ 拆出
├── capabilities/           契约 + 注册表 + 子图 + 页面动作
│                           ← 吸收 rules/capabilities.py、rules/capability_registry.py
├── workflow/               主图 + 服务 + 规划 + 重试 + LLM 客户端
│                           ← 原 agent/ 的引擎部分
├── presentation/           任务装配与展示       ← 从 rules/ 拆出
│
├── businesses/             ← 只有业务知识
│   ├── packs/              各业务的声明
│   ├── routing.py          原 agent/field_routing.py（改为读 pack）
│   ├── materials.py        原 agent/document_policies.py（改为读 pack）
│   └── registry.py, profiles.py, ...
│
├── services/               运行时（任务、调度、外部服务）
└── contracts/              协议导出
```

**划界效果**：加业务的人只需看 `businesses/`；改引擎的人不会碰到业务规则。

前端：

```
src/
├── App.tsx, main.tsx
├── browser/
│   ├── gateway/            content.ts + background.ts（消息路由）
│   ├── collect/            page-field-collector + business-* + image-* + page-identity
│   ├── write/              page-field-writer
│   └── focus/              image-focus
├── adapters/               PageAdapter（阶段 6 后真正启用）
├── workbench/              ← 原 components/
│   ├── renderers/          workbenchRenderers.tsx + ScrapReplacementReview.tsx
│   ├── panels/             各任务面板与专项组件
│   └── legacy/             旧界面组件
├── presentation/           ← 6 个 *Presentation.ts 归入
├── clients/                ← 4 个 *Client.ts + reviewJobs.ts 归入
├── session/                会话状态机
├── hooks/
└── types/
```

**`src/` 根目录从 19 个散落文件降到 2 个（`App.tsx`、`main.tsx`）。**

## 2.3 文档层：按读者任务组织

```
docs/
├── README.md                  索引 + 三条阅读路径（新人 / 加业务 / 排障）
│
├── concepts/                  【是什么】
│   ├── overview.md             系统定位、边界、不变量
│   ├── architecture.md         分层与目录职责
│   └── glossary.md             术语表
│
├── how-to/                    【怎么做】← 重写重点
│   ├── add-review-page.md      新增一个审核页面（端到端）
│   ├── add-capability.md       新增一个审核能力
│   ├── add-external-check.md   接一个外部核验
│   ├── change-field.md         改字段的定义/位置/归一化
│   └── debug-review.md         排查一次审核为什么没过（当前缺失）
│
├── internals/                 【怎么运作】
│   ├── pipeline.md             图片流水线、并发、任务生命周期
│   ├── workflow.md             主图、节点、子图（合并原 langgraph + registries）
│   └── presentation.md         工作台展示规范
│
├── policies/                  【必须遵守什么】
│   ├── change-policy.md        改动准则
│   ├── testing-and-release.md  测试与发布
│   └── security.md             安全边界（原根 SECURITY.md 收进来）
│
└── businesses/                【具体业务规则】
    ├── scrap-replacement-qingdao.md
    ├── scrap-replacement-changchun.md
    └── template.md
```

**最重要的改动是把 `how-to/` 独立出来。** 当前 `extension-guide.md` 只讲前端，后端加业务的知识散在 `registries-and-subgraphs.md` 里。重写成端到端的 `add-review-page.md` 后，**文档结构与核心目标对齐**——加页面的人只需读一份。

**现状的四个结构性问题**：

1. 按"代码模块"组织，非按"读者任务"组织（加页面要读 4 份文档还不一定找全）
2. `langgraph.md` 与 `registries-and-subgraphs.md` 高度耦合（主图与子图是同一件事的两面）
3. `architecture.md` 与 `registries-and-subgraphs.md` 边界模糊（都讲分层）
4. `business-rules.md` 文件与 `business-rules/` 目录同名，索引与内容混淆

## 2.4 改造后：新增一个页面的改动清单

| # | 文件 | 改动 | 类型 |
| --- | --- | --- | --- |
| 1 | `app/businesses/packs/<新业务>.py` | 写一份声明 | **新增文件** |
| 2 | `app/businesses/packs/__init__.py` | 注册 pack | 一行 |
| 3 | `app/workflow/` 注册新能力 handler | 仅当有新能力时 | 注册表 |
| 4 | `docs/businesses/<新业务>.md` | 业务文档 | **新增文件**（规则要求） |
| 5 | 前端 | **零改动**（复用通用工作台） | 仅当展示特殊时注册新 Renderer |

**从 15 处改为 4-5 处，其中对现有文件的修改从 15 处降到 2-3 处。**

---

# 第三部分 · 改造路线

## 3.1 两条主线

| 主线 | 服务目标 | 阶段 |
| --- | --- | --- |
| **主线 A** | 降低新增页面成本 | 1 清理 → 2 文档纠偏 → 3 权威显式化 → 4 业务扩展包 → 5 采集清单 → 6 前端适配器 → **10 目录调整** → **11 文档重排** |
| **主线 B** | 降低日常复核量 | 7 定向重读 → 8 重读状态展示 → 9 局部重读 |

**两条主线相互独立，可交错进行。** 主线 A 不减少日常复核量，主线 B 不降低新增页面成本。

## 3.2 依赖关系

```
阶段 0  度量              ← 无依赖
主线 A
  阶段 1  清理死代码       ← 零风险，无依赖
  阶段 2  文档纠偏         ← 零风险，无依赖
  阶段 3  权威层级显式化    ← 阶段 4 的前置（pack.field.authority 需要它）
  阶段 4  业务扩展包        ← 核心，依赖阶段 3
  阶段 5  采集清单接口      ← 是阶段 4 的一个投影
  阶段 6  前端适配器落地    ← 依赖阶段 4、5
  阶段 10 目录结构调整      ← 依赖阶段 4（必须等双轨验证结束）
  阶段 11 文档结构重排      ← 结构可与阶段 1、2 并行；内容依赖阶段 4、10
主线 B
  阶段 7  不确定字段定向重读 ← 依赖阶段 1（过户残留清理）
  阶段 8  重读状态展示      ← 依赖阶段 7
  阶段 9  局部重读          ← 依赖阶段 4
```

## 3.3 建议顺序

```
第 1 步  阶段 0（度量）+ 阶段 1（清理）+ 阶段 2（文档纠偏）   零风险，可立即开始
第 2 步  阶段 7 + 阶段 8（重读链路）                          收益最直接
第 3 步  阶段 3（权威显式化）                                  pack 前置
第 4 步  阶段 4 + 阶段 5（业务扩展包 + 采集清单）               核心目标达成
第 5 步  阶段 6（前端适配器）                                  前端也配置化
第 6 步  阶段 10 + 阶段 11（目录 + 文档定稿）                  收口
第 7 步  阶段 9（局部重读）                                    进阶
```

**若车源是近期交付目标**：第 3、4 步提前到第 1 步之后——否则会用 15 个文件的手工活交付一个本可 1 份声明的业务，且第二、三个业务还要再来一遍。

**为何阶段 10 排在阶段 4 之后**：阶段 4 的核心安全网是**双轨验证**（pack 派生结果 vs 现有硬编码结果，逐请求断言一致）。同时动目录会让 diff 里"哪边是新哪边是旧"无法分辨，安全网失效。

---

# 第四部分 · 逐项明细

## 阶段 0 · 度量

### 0.1 统计历史重试分布

- **数据源**：`ReviewResponse.retry_summary.attempts`，已含 `reason_code` / `strategy` / `result`
- **产出**：基线重读率 `r`；**`invalid_registration_owner` 的计数**（按 1.1 分析应为 0，若非 0 说明分析有误）
- **改动**：无，一次性统计脚本

### 0.2 加不确定字段计数日志

- **落点**：`app/agent/service.py:154` 附近

```python
logger.info(
    "extraction uncertain count=%d fields=%s image=%s document_type=%s",
    len(extraction.uncertain_fields), extraction.uncertain_fields,
    image_name, getattr(policy, "document_type", None),
)
```

- **产出**：改后重读率 `r'` 的估计
- **回滚**：删除日志行

---

## 阶段 1 · 清理死代码（零风险，不改运行时行为）

### 1.1 过户残留清理 ✅ 已批准

**证据**：

| 证据 | 位置 |
| --- | --- |
| `invalid_registration_owner` 分支 | `app/agent/retry.py:20-21` |
| 对应重试指令 | `app/agent/document_policies.py:29-32` |
| 唯一测试**被跳过** | `tests/test_agent_retry.py:97`（实测 SKIPPED） |
| 字段不在任何白名单 | `registration.initial_owner` 在 `document_policies.py` 仅出现于 `RETRY_INSTRUCTIONS` 的指令文本 |
| 白名单过滤先于判定 | `app/agent/qwen_client.py:96-100` |
| 未知材料路径提前返回 | `app/agent/retry.py:15-16` |
| 测试字段名属停用业务 | `transfer.registration.initial_owner`（过户，已停用） |

**改动**：

| 文件 | 改动 |
| --- | --- |
| `app/agent/retry.py` | 删 `invalid_registration_owner` 分支 |
| `app/agent/document_policies.py` | 删 `RETRY_INSTRUCTIONS` 对应条目 |
| `tests/test_agent_retry.py` | 删被跳过的测试 |
| `tests/conftest.py` | 从 `legacy_names` 移除 `contaminated_registration_owner` |

**补测**：新增"过户字段不出现在任何材料白名单"的断言，防止被误加回。

**保留不动**：`app/agent/qwen_client.py:113-135` 的 `_normalize_registration_owner`。净效果为零但**不属于失败分支**，单独确认成本高于收益，列为观察项。

**回滚**：四文件同一改动，整体恢复。

### 1.2 `compare.py` 死代码

- **证据**：`app/rules/compare.py` 生产零调用，仅被 `tests/test_compare_contract.py`、`tests/test_rules.py`、`tests/test_scrap_field_normalization.py` 引用；真实比对在 `app/rules/aggregate.py`
- **方案**：删除，断言迁移到 `aggregate_field`
- **理由**：二元语义已被多源语义取代，保留会误导读者以为有两套比对算法
- **测试**：迁移后覆盖空值三分支、等价归一化、字符差异位置
- **回滚**：单文件恢复

### 1.3 `cross_document.py` 空壳

- **证据**：`app/rules/cross_document.py:19` 函数体仅 `return []`；`tests/test_backend_capability_hardening.py:341-346` 断言恒空
- **方案**：删除函数与测试
- **保留**：`cross_document_common.py` 的 `settled_value` / `raw_settled_value`（`app/agent/workflow.py:562/564/572` 仍在使用）
- **回滚**：单文件恢复

### 1.4 `REJECT_SUGGESTED` 删除 ✅ 已批准

- **证据**：`app/models/review.py:41` 定义枚举，全库仅 `app/agent/service.py:377` 一处标题映射引用，无逻辑产生
- **方案**：删除枚举及其标题映射
- **同步**：删除 `docs/glossary.md:61` 的"建议拒绝"条目
- **回滚**：单文件恢复 + 文档恢复

### 1.5 前端测试专用死代码

| 项 | 位置 |
| --- | --- |
| `PageActionController` | `src/session/pageActionController.ts` |
| `ReviewFieldMatcher` | `src/browser/field-matcher.ts` |
| `AffiliationReview` | `src/components/AffiliationReview.tsx` |
| `pageReviewClient` 的 show/complete | `src/pageReviewClient.ts:82-98` |
| 非流式 `createReviewJob` | `src/reviewClient.ts:50-63` |
| `isFieldFirstProfile` | `src/scrapReplacementProfile.ts:9` |

- **方案**：逐项确认后删除（连同对应测试），分批进行
- **回滚**：逐个恢复

### 1.6 `verify_invoice` 收进能力注册表 ✅ 已批准（方案 B）

**问题位置**：`app/services/review.py:249-258`

```python
if any(item.field == "invoice.invoice_no" and item.status is FieldStatus.MATCH
       for item in response.comparisons):
    response = response.model_copy(update={
        "page_actions": [*response.page_actions,
            PageActionIntent(action_id="verify_invoice",
                             payload={"field": "invoice.invoice_no"})],
    })
```

- **为什么是问题**：触发条件是**字段级字符串 if**，非注册表声明。与 `docs/registries-and-subgraphs.md:88`「不得硬编码能力分支」、`docs/ai-change-policy.md:15`「新增页面必须有 Adapter 和 Action」相悖。它位于 service 层而非路由层，因此未被规则拦住
- **方案 B**：把 `verify_invoice` 做成 `CapabilitySpec`，产出 `page_actions`
  - `CapabilityResult.page_actions`（`app/models/review.py:188-198`）已能承载，无需新造字段
  - 自动满足「新增能力必须注册」，并自动获得超时、重试、失败策略
- **落点**：`app/services` → `app/rules`（阶段 10 后为 `app/capabilities`）
- **测试**：`tests/test_agent_service.py`、`tests/test_api.py` 的注入断言必须继续通过；新增"能力未注册时不注入"的降级测试
- **文档**：两个地区业务文档的实现清单、`docs/registries-and-subgraphs.md`
- **回滚**：保留原 if 分支，flag 切换，确认后删除

### 1.7 `AgentService` 并发语义澄清

**位置**：`app/agent/service.py:31-33`

```python
MAX_CONCURRENT_IMAGES = 6
IMAGE_TIMEOUT_SECONDS = 50.0
REVIEW_DEADLINE_SECONDS = 55.0
```

- **问题**：流式路径每次只提交一张图（`app/services/jobs.py:194-197`），因此
  - `asyncio.Semaphore(6)` 实际永远只用 1
  - `REVIEW_DEADLINE_SECONDS = 55.0` 退化为"单图截止"
  - 真正生效的是 Fair Scheduler 的 **12 全局 / 6 单任务**
- **实际影响**：55 秒"整单截止"在流式路径下无效果，16 张图的任务总耗时可远超 55 秒
- **方案**：加注释说明"流式路径下仅对单图生效，整单并发由 Fair Scheduler 控制"
- **理由**：当前行为**无 bug，仅语义不清**；改动超时行为需覆盖 `docs/testing-and-release.md:22` 要求的并发测试，为"清晰"不划算
- **回滚**：注释无需回滚

---

## 阶段 2 · 文档纠偏（零风险，不改代码）

依据 `docs/ai-change-policy.md:37`：「文档应明确区分'当前运行时已经使用的实现'和'为未来拆分保留的扩展边界'」。

| # | 文档 | 现状 | 应改为 |
| --- | --- | --- | --- |
| 2.1 | `docs/langgraph.md` | 列 13 个节点 | 改为 14 个，补 `build_error_response`；将 `record_degradation` 从"无条件节点"改为"条件分支目标"（依据 `app/agent/workflow.py:227-240`） |
| 2.2 | `docs/frontend-presentation.md:103` | "当前工作台**不得触发**挂靠自动填写" | ✅ 已确认改为："当前工作台**隐藏**相关任务，写入路径**保留**" |
| 2.3 | `docs/registries-and-subgraphs.md:61-73` | 已标"扩展边界" | 保持，补一句"7 个工厂当前均为单节点透传，无可执行差异" |
| 2.4 | `README.md`、`docs/architecture.md:41`、`docs/extension-guide.md` | 将 `PageAdapter` 列为核心机制 | 改为事实描述（阶段 6 完成后即为事实） |
| 2.5 | `docs/business-rules.md` | 未提及 | 补 `_deduplicate_sources` 的页面值锚定策略说明（依据 `app/rules/aggregate.py:44-59`）。这是全系统唯一一处"以页面值为锚的候选筛选"，属规则语义 |

**2.2 补充**：`docs/ai-change-policy.md:15` 要求"停用业务不能偷偷激活"。挂靠当前处于"UI 隐藏 + 逻辑启用"之间，文档更新后应在 `docs/business-rules/` 明确写明它**当前是活跃的**。

---

## 阶段 3 · 权威层级显式化 ✅ 已完成

### 问题

同一概念（哪个来源说了算）有三套实现：

| 字段 | 机制 | 位置 |
| --- | --- | --- |
| `old_vehicle.vin`（报废车辆车架号） | 手写函数 `aggregate_old_vehicle_vin` | `app/rules/aggregate.py:184-313` |
| `application.terminal_phone`（手机号）、`application.owner_type`（车辆所有人类型） | `field_policy(mode="SYSTEM")` | `app/services/review_response.py:120-135` |
| 发票代码/号码、双 VIN | `composite_fields.py` 页面双值 → 材料 | `app/rules/composite_fields.py:99` |

**新增业务时，每遇到一个需要权威关系的字段，都要判断该用三种中的哪一种。**

### 方案

**不新建顶层模块**，只在已有 `FieldEvidencePolicy`（`app/rules/field_evidence_policies.py`）上加字段。

**实施结果**（与原计划的差异：`label`/`document_types`/`required` 是实施中新增的，`"normalized"` 窗口未采用）：

```python
@dataclass(frozen=True)
class AuthorityRule:                                    # 权威规则
    source: Literal["qr_page", "page", "image"]         # 来源：官网 / 页面 / 图片
    label: str                                          # 仅用于生成面向审核员的理由
    document_types: tuple[str, ...] = ()                # source == "image" 时限定材料类型
    match: Literal["full", "suffix8"] = "full"          # 与基准的比较窗口
    required: bool = False                              # 该来源缺失时直接人工复核

# FieldEvidencePolicy 增加
authority: tuple[AuthorityRule, ...] = ()
```

**语义要点（实施中修正了计划的理解）**：**链首来源是唯一比较基准**，不是"链上第一个有值的来源"。链首缺失时降级人工复核，不把基准让给下一条来源——这才是"最高标准"的含义。

**实施结果**：`aggregate_old_vehicle_vin`（约 130 行）已被删除，替换为 `aggregate.aggregate_by_authority` + `old_vehicle.vin` 的一条权威声明。等价性通过 9 个场景的快照测试锁定（见 `tests/test_aggregate.py::test_declared_vin_authority_behaviour_snapshot`）。

### 业务语义确认

`docs/business-rules.md:50` 规定「不得静默选择一个值」。本方案**不改变判定逻辑**，只将**已有的**权威关系从代码搬到声明。权威来源必须写入 `docs/business-rules/*.md` 才算生效。

**要禁止的是"靠票数猜"，不是"按声明裁决"。** `aggregate_old_vehicle_vin` 已经证明这条路成立——它自动裁决，依据是业务认可的官网权威，且结论写进 `message` 可见。

### 测试

- 现有 `tests/test_aggregate.py:66-104` 的权威/众数断言**必须全部继续通过**（本项的安全网）
- 新增：声明式权威与新实现的一致性测试

### 回滚

`authority` 默认空元组，空时走现有逻辑。可分字段灰度。

---

## 阶段 4 · 业务扩展包（核心）🔶 进行中

**进度**：

| 子阶段 | 内容 | 状态 |
| --- | --- | --- |
| 4a | 建骨架 + 用报废置换做声明 + 等价性验证 | ✅ 完成 |
| 4b | 字段清单、证据策略、材料策略改为从扩展包生成 | ✅ 完成 |
| 4c | 字段路由（`field_routing.py`）纳入扩展包 | ✅ 完成（含材料字段映射表） |
| 4d | 前端 DOM 别名与材料分组提示纳入扩展包 | ✅ 完成（后端侧；前端消费见阶段 6） |
| 4e | Profile、材料策略、地区政策、页面路由白名单纳入扩展包 | ✅ 完成 |

**4e 实施结果**：一个业务的完整配置现在集中在一份声明里。

- `RegionDeclaration(region, version, replacement_policy, admin_paths)` 表达地区差异；地区政策能力 ID 由地区推导，不用单独声明
- `profiles.py` 的青岛/长春 Profile 改为由 `build_scrap_profile(region)` 从声明生成，删除了约 110 行硬编码
- `replacement_policies.py` 只保留 `ReplacementPolicy` 结构，政策数据移入声明
- `material_policies.py` 移除报废置换的材料策略，移入声明
- `context_validation.py` 的页面路由白名单由各地区的 `admin_paths` 生成

**刻意没动的**：前端 Renderer 注册（`workbenchRenderers.tsx`）和能力实现注册（`workflow.py`）——它们是"ID → 实现"的注册表，本来就该与业务数据分开：实现写一次，业务只引用 ID。

**实施结果**：

- 新增 `app/businesses/packs/`：`model.py`（声明结构）、`scrap_replacement.py`（报废置换的完整声明）
- `DocumentPolicy` 改为数据驱动：`scoped_fields` / `scoped_guidance` 取代原来的 if-else 分支
- `review_fields.py`、`field_evidence_policies.py`、`document_policies.py` 三处**不再各写一份数据**，改为从扩展包生成
- `tests/test_pack_equivalence.py` 锁定扩展包的关键内容（必审字段顺序、每字段有标签、策略覆盖完整、旧车 VIN 权威链、每类材料有名称/白名单/指引/分组提示）

**效果**：改字段或加字段现在只需要动 `packs/scrap_replacement.py` 一个文件。切换后 373 项后端测试、278 项前端测试全部通过，无行为变化。

### 方案

见 2.1。落点：

| 内容 | 位置 |
| --- | --- |
| `BusinessExtensionPack` 及三个声明 dataclass | `app/businesses/packs.py` |
| 各业务的 pack | `app/businesses/packs/<业务>.py` |
| 派生函数 | `app/businesses/packs.py` |
| 现有五个投影改为消费派生结果 | `field_routing.py`、`document_policies.py`、`field_evidence_policies.py`、`review_fields.py` |

### 迁移策略（关键：不能一次性切换）

1. **先建骨架**：定义 pack 与派生函数，**不接入**任何现有业务
2. **用长春做一个 pack**，五个投影同时从 pack 派生与从现有硬编码派生，**每次请求断言两者结果一致**
3. 双轨运行验证一周，无差异后**删除硬编码**
4. 青岛重复步骤 2-3
5. 此时新增业务才真正只需写 pack

**步骤 2 的双轨断言是本项的安全网**，必须保留到确认无差异为止。

### 测试要求

- 每个生产 Profile：pack 派生结果与现有硬编码结果的一致性测试
- 启动期校验：pack 内字段引用完整性（`fields[].sources` 中的材料必须存在）
- `docs/testing-and-release.md:40` 要求的六类 fixture：最小成功样本、关键字段缺失、字段冲突、低质量材料、外部服务超时、重复请求

### 文档

- `docs/registries-and-subgraphs.md`：新增 pack 说明
- `docs/extension-guide.md`：**"新增页面"流程整体重写**
- `docs/architecture.md`：补 pack 在分层中的位置

### 回滚

双轨期的硬编码路径保留即回滚路径。确认后删除硬编码，回滚需恢复代码。

---

## 阶段 5 · 采集清单接口 ✅ 已完成

**实施结果**：新增 `GET /api/review/collect-manifest?business_type=...`，返回前端做页面采集所需的全部数据——字段别名、图片分组标题到业务分区的映射、材料分组关键词。尚未声明清单的业务返回 404，前端退回内置表。

接口只按业务类型取数（同一业务的各地区共用），因此没有地区参数。测试见 `tests/test_api.py`。

**本项是阶段 4 的一个投影**，因涉及新增 HTTP 接口（公开协议），单列。

### 问题

```
后端  app/rules/review_fields.py:33              SCRAP_PAGE_FIELD_LABELS（25 条中文标签）
前端  review-extension/src/browser/page-field-collector.ts:18   FIELD_DEFINITIONS（24 条）
```

违反 `docs/architecture.md:37`「禁止跨层复制同一规则」。

### 方案

1. `app/contracts` 新增采集清单 schema
2. 新增端点，按 pack 返回 `{scopes, sections, fields, materials}`
3. 前端改为消费清单，内置表退化为兜底
4. **阶段 6 完成后删除内置表**

### 合规

新增 HTTP 端点属公开协议（`docs/ai-change-policy.md:17`），需影响说明与版本策略。

### 测试

- 后端：端点契约测试；每个 pack 的清单与派生结果一致性测试
- 前端：清单驱动下的字段匹配测试

### 回滚

端点保留但前端回退到内置清单。

---

## 阶段 6 · 前端读采集清单 ✅ 已完成（接线部分）

**实施结果**：前端不再只依赖内置表。

- 新增 `src/browser/collect-manifest.ts`：清单类型、转换函数、应用/读取入口、拉取客户端
- `page-field-collector.ts` 的字段定义表改为"清单优先、内置兜底"
- `business-scope.ts` 的页面分组标题表同样处理
- `content.ts` 在识别业务之后、采集字段之前应用清单（按业务类型选择）
- 侧边栏在采集前拉取各业务的清单并随消息下发；拉取失败下发空数组，退回内置表
- 新增 `tests/collect-manifest.test.mjs`：用后端生成的 fixture 验证清单能复现前端的字段别名解析（含多字段共用别名的歧义判定）和分组标题解析；并验证清单结构不完整时正确退回内置表

**仍待做（原阶段 6 的适配器部分）**：`PageAdapterRegistry` 接管页面识别、`content.ts` 退化为消息网关。这部分与"让新页面可配置"关系较弱，优先级低于车源业务落地。

### 4c 补充：材料字段映射表

`route_fields` 原本用 122 行 if-else 写死了"材料字段 → 领域字段"，是新增业务的最后一道卡点。现已改为声明：

- `RouteDeclaration(document_type, source_field, targets, scope)`：目标里的 `{scope}` 按当前页面分区替换；一条规则可映射到多个领域字段（发票购买方名称同时支撑新车所有人和客户名称）
- `MaterialDeclaration.scoped_vehicle_fields`：该材料上跟随页面分区落位的车辆字段后缀（`vehicle.X` → `{当前分区}.X`）
- `MaterialDeclaration.scope_independent`：营业执照、身份证这类不属于业务分区的材料，字段按材料白名单原样通过

**登记证书刻意不使用通用后缀规则**（只认 `vehicle.` 前缀，不接受 `old_vehicle.` / `new_vehicle.` 兼容写法），改为逐条显式声明——这个差异由 `tests/test_field_routing.py` 锁定。

### 阶段 6 补完：图片筛选也改为清单驱动 ✅ 已完成

原先只有字段别名和页面分组标题接了清单；图片筛选仍写死报废置换：内置类型表、
材料关键词正则、分区打分三处都只认旧车/新车。**新页面的图片会被直接丢弃。**

改动：

- 清单增加 `scopes`（该业务的材料分区）
- 前端 `collect-manifest.ts` 由清单派生「已知图片类型 + 材料关键词正则 + 材料分区」三样
- `image-candidates.ts` 改为清单优先、内置兜底
- 新增 4 项测试：真实页面图片在两种规则下选出同一批、清单补齐了内置类型表漏掉的 `vehicle_license`、
  材料关键词影响排序、面积兜底的边界行为

**过程中发现的既有问题**：`eligible()` 里的 `businessPattern` 判定是**不可达的**——
面积兜底在前一步就把小于 40000 像素的非已知类型图片全部丢弃了，所以材料关键词
实际只影响排序、不影响是否入选。这意味着**小而重要的材料图（例如小尺寸铭牌）会
被无条件丢弃**。这是改动前就存在的行为，本次没有改变它，需要业务确认后单独处理。

## 阶段 6b · 前端适配器落地 ✅ 已完成

**实施结果**：适配器成为全应用的页面识别入口，不再空转。

- `PageAdapter` 接口收窄为「页面特有的部分」：识别、可写控件、受控写回；**去掉 `collect`**——采集已经是通用的、由后端采集清单驱动的，适配器里没有页面特有的采集可写
- 新增 `VehicleSourcePageAdapter`、`ConsistencyPageAdapter`（只做识别，业务尚未配置）
- 新增 `adapters/selection.ts`：共用的路径分段匹配与业务选择构造
- `adapters/index.ts` 的 `buildPageAdapterRegistry()` 注册全部适配器
- `business-detector.ts` 不再自己维护路径表，改为委托注册表；它只保留识别入口和「人工选择与页面不一致」的判定

**取舍说明**：计划原写「`collect()` 走清单端点、`content.ts` 退化为消息网关」。实施时发现采集本身已经没有页面特有的逻辑（字段别名、分区、材料分组、图片筛选依据全部来自清单），把 563 行的采集流程搬进适配器只会增加一层无意义的转发。因此改为由适配器负责它真正特有的那部分。

### 原方案

### 问题

`review-extension/src/adapters/` 共 123 行，`src/` 与 `tests/` 全仓 **0 引用**（实测）。真实适配硬编码在 `src/browser/`（1984 行）。

### 方案

1. `PageAdapterRegistry` 真正接管页面识别，`business-detector.ts` 的路由逻辑迁入 `ScrapReplacementPageAdapter.detect`
2. `collect()` 消费阶段 5 的清单
3. 新增 `VehicleSourcePageAdapter`
4. `content.ts` 退化为消息网关
5. `image-candidates.ts` 的 `businessPattern` 由清单的 `materials[].hints` 生成

### 合规

`docs/ai-change-policy.md:41` 称"页面换了字段位置只修改对应 PageAdapter"——当前实现做不到，本项即让其成立。

### 风险

**高**。`content.ts`（563 行）与 `page-field-collector.ts`（710 行）是生产核心。改造期间青岛、长春功能不得回退。

### 测试

扩展 `review-extension/tests/business-detector.test.mjs` 等，覆盖清单驱动路径。

### 回滚

双轨期——adapter 存在但 `content.ts` 保留原逻辑，flag 切换。

---

## 阶段 7 · 不确定字段定向重读 ✅ 已完成

### 问题

`app/agent/retry.py:15-26`：

```python
if "registration.initial_owner" in extraction.uncertain_fields:
    return "invalid_registration_owner"
if extraction.confidence is not None and extraction.confidence < 0.70:
    return "low_confidence"
```

`uncertain_fields`（不确定字段）是模型自报"看不清"的字段（提示词见 `app/agent/document_policies.py:303`）。但只有 `registration.initial_owner` 一个字段会因此触发重读（且该分支已在阶段 1.1 移除）。

且 `confidence` 是**文档级**的——一张整体 0.85 分、某字段看不清的图不会重读。

结果：`app/rules/aggregate.py:130-132` 的一票否决直接送人工。

### 方案

**① `app/agent/retry.py`**

```python
RETRYABLE_UNCERTAIN_PREFIX = "uncertain_field:"

def retry_reason_for_extraction(extraction, policy):
    if policy is None:
        return "document_type_mismatch"
    if extraction.document_type != getattr(policy, "document_type", None):
        return "document_type_mismatch"
    uncertain = [f for f in extraction.uncertain_fields if f in PRIMARY_REVIEW_FIELDS]
    if uncertain:
        return RETRYABLE_UNCERTAIN_PREFIX + ",".join(sorted(uncertain))
    if extraction.confidence is not None and extraction.confidence < 0.70:
        return "low_confidence"
    if not extraction.fields:
        return "empty_supported_fields"
    return None
```

**② `app/agent/document_policies.py`**：新增 `_uncertain_field_instruction`，在 `_append_retry_instruction`（`:38`）中优先匹配前缀。

**③ `app/agent/service.py` 不用改**——`_retry_kwargs` 走签名自省，字符串原样透传。

### 必须保持的约束

`_append_retry_instruction` 的 docstring 写着「**不回传模型上一次响应**」。新指令只说明"哪些字段不确定"，不得泄露上次输出。

### 设计要点

- **只对必审字段触发**：`uncertain_fields` 已按材料白名单过滤（`app/agent/qwen_client.py:96-100`），但白名单内的展示用字段（如 `application.dealer_name`）不值得重读。非必审字段也不参与比对（`_build_comparisons` 只遍历 `profile.required_fields`），收窄不会漏掉任何会进"待处理"的项
- **重读上限保持 1 次**：`app/agent/service.py:161` 的 `semantic_retry_count` 当前为 1，`attempt_number=2` 硬编码
- **✅ 保留 `semantic_retry_count` 运行时可关闭**：因本项不设上线门槛、由实测决定，必须保证出问题能一键关掉。该开关已存在（`app/agent/service.py:161`），不得移除

### 成本参考

增幅 = `(r' − r) / (1 + r)`，非 `r' − r`。每张图重读上限 1 次，**硬上限 +100%**。

| 现状 `r` | 改后 `r'` | 每张图调用数 | 增幅 |
| --- | --- | --- | --- |
| 5% | 15% | 1.05 → 1.15 | +9.5% |
| 10% | 25% | 1.10 → 1.25 | +13.6% |
| 10% | 40% | 1.10 → 1.40 | +27% |
| 20% | 60% | 1.20 → 1.60 | +33% |

**天然节流阀**：`app/agent/service.py:161-163` 在剩余时间不足时自动跳过重读。系统繁忙时自动降级到当前行为，成本增加自限。

### 测试

不确定字段触发重读；非必审字段不触发；指令内容不含上次响应；必审字段过滤边界。

### 回滚

由 `retry_policy.semantic_retry_count` 控制，或直接恢复代码。

---

## 阶段 8 · 重读状态展示 ✅ 已完成

### 问题

重读失败后提示仍为 `图片识别结果不确定，请核对原图`（`app/rules/aggregate.py:132`），审核员不知机器已重试过。

### 数据已存在

`batch.retry_summary.attempts`。

### 方案

1. `FieldObservation` 增加 `retried: bool = False`
2. `batch_observations`（`app/rules/evidence_values.py:43`）查询该图有无重试记录
3. `app/rules/aggregate.py:130-132` 消息分两档

### 价值

审核员看到"已重读仍不确定"会认真看图，看到"不确定"会以为系统偷懒。这与防锚定是同一件事——让人相信机器已尽力。

### 合规

`FieldObservation` 属协议模型，加字段为架构面变更。

### 测试

两档消息断言；`retried` 默认 `False` 的向后兼容测试。

### 回滚

新字段有默认值，向后兼容。

---

## 阶段 9 · 局部重读（证据区域裁剪）✅ 已完成

**实施结果**：定向重读时先按模型的证据区域裁剪并放大，再让模型只读这一小块。

- 新增 `app/workflow/image_focus.py`：坐标换算、区域合并、裁剪放大
- `AgentService._extract_image` 支持 `focus_boxes`；`run_one` 在定向重读时传入待重读字段的区域
- `_focus_boxes` 只在 `uncertain_field:` 原因下裁剪，其他重试原因照旧整图重读

**保守设计**：`evidence_regions` 的坐标约定是**推断的**（归一化比例 / 像素），因为该字段在项目里原本没有任何消费者、无法从既有代码反推。所以策略是「推断 + 放弃就退回整图」：区域过大（超过整图 70%）或退化时返回 `None`，按整图重读——**错误的裁剪会丢掉真正要看的区域，比不裁剪更糟**。放弃时在 info 级别记录原始坐标，第一次真实运行后据此校正。

**顺带合并**：`app/capabilities/subgraphs/` 下 7 个工厂中有 6 个是完全相同的 14 行透传壳，已合并到
`subgraphs/__init__.py`，导出名字全部保留。原计划把局部重读放进 `evidence_extraction` 子图，
实施时改为放在既有的重试路径里——抽取在主图节点中按图并发执行，把它挪进能力子图会改变整条流水线，
而局部重读本身只影响单图重试这一步。

**过程中修掉的两个既有缺陷**：

1. `QwenExtraction` 的校验器只接受字典形态的证据区域，用 `EvidenceRegion` 对象构造时会**静默丢掉全部坐标**。
2. 前端 `BusinessSelection` 类型缺少 `detectionStatus`——该字段一直被写入、从未被读取，类型里也没有，只是原来返回类型是推断出来的所以没报错。

### 原方案

**这是 LangGraph 唯一能挣回成本的地方。**

### 地基已存在

`evidence_regions`（证据区域）已含每个字段的 `box`（`[x1,y1,x2,y2]`），`app/agent/document_policies.py:175` 正在要求模型输出。

### 形态

```
extract(round=1) → 存在不确定字段
   → 按该字段的 box 裁剪 + 放大
   → extract(round=2, 仅输入该局部)
   → 仍不确定 → 送人工
```

### 落点

`app/capabilities/subgraphs/evidence_extraction.py`——文档已命名为"证据提取的扩展边界"，当前为 14 行透传壳。**这是填接缝，不是新建抽象。**

### 合规

属主图能力内部结构变更（`docs/ai-change-policy.md:17`）。约束：保持同一 `CapabilitySpec` 与 `CapabilityResult`，主图不得依赖子图内部节点名（`docs/registries-and-subgraphs.md:73`）。

### 测试

低质量材料样本；重试轮次上限；超时降级；`RetrySummary` 留痕。

### 回滚

子图工厂回退到 `build_capability_subgraph`。**这正是保留透传壳的价值——回滚是一行。**

---

## 阶段 10 · 目录结构调整 ⚠️ 后端已完成，前端未执行（纯移动，零逻辑改动）

### 问题

见 1.5。三条：

1. `app/rules/` 21 个文件混装五类东西（引擎 / 注册表 / 契约 / 业务规则 / 展示 / 死代码）
2. **"能力"概念散在四处**：`rules/capabilities.py`（契约）+ `rules/capability_registry.py`（注册表）+ `capabilities/`（壳）+ `capabilities/models.py`（再导出）
   - 且 `app/capabilities/models.py` 的 docstring 自称"capability-oriented import boundary"，却 `import` 了 `app.agent.planner`、`app.models.review`、`app.rules.capabilities`——**一个"边界"模块反向依赖三层**
3. **业务知识埋在技术层**：`app/agent/document_policies.py`（材料白名单）、`app/agent/field_routing.py`（字段路由）

### 目标结构

见 2.2。映射表：

| 现在 | 目标 | 说明 |
| --- | --- | --- |
| `app/models/` | `app/models/` | 不变 |
| `app/fields/` | `app/fields/` | **吸收** `rules/normalize.py`、`rules/review_fields.py` 的字段规格部分 |
| `app/rules/aggregate.py`、`check_results.py` | `app/compare/` | 新目录 |
| `app/rules/capabilities.py`、`capability_registry.py`、`business_rule_registry.py`、`external_check_registry.py` | `app/capabilities/` | 合并入 |
| `app/capabilities/models.py` | 删除 | 改为直接从 `app/capabilities/` 导入各契约 |
| `app/rules/task_presentation.py`、`review_step_routing.py`、`final_advice.py` | `app/presentation/` | 新目录 |
| `app/agent/` 的引擎部分 | `app/workflow/` | 改名为语义更准的 `workflow` |
| `app/agent/document_policies.py`、`field_routing.py` | `app/businesses/` | 业务知识归位（阶段 4 后已改为读 pack） |
| `app/rules/` 其余业务规则 | `app/businesses/rules/` | 归位 |
| `app/rules/compare.py`、`cross_document*.py` | 已删 | 阶段 1 |
| `app/api/` | `app/api/` | 从 `main.py` 拆出路由 |

前端映射：

| 现在 | 目标 |
| --- | --- |
| `src/browser/content.ts`、`background.ts` | `src/browser/gateway/` |
| `src/browser/page-field-collector.ts`、`business-*.ts`、`image-*.ts`、`page-identity.ts` | `src/browser/collect/` |
| `src/browser/page-field-writer.ts` | `src/browser/write/` |
| `src/browser/image-focus.ts` | `src/browser/focus/` |
| `src/components/` | `src/workbench/`（含 `renderers/`、`panels/`、`legacy/`） |
| 6 个 `src/*Presentation.ts` | `src/presentation/` |
| 4 个 `src/*Client.ts` + `src/reviewJobs.ts` | `src/clients/` |
| `src/session/`、`hooks/`、`types/`、`adapters/` | 不变（`adapters/` 阶段 6 后启用） |

> **执行结果（复查后补记）**：**后端映射表已全部落地**，上表的前端映射**未执行**。
> `src/` 目前仍是平铺结构：`browser/`（12 个文件平铺）、`components/`、`adapters/`、
> `session/`、`hooks/`、`types/`，以及根目录下的 6 个 `*Presentation.ts`、
> 4 个 `*Client.ts` 和 `reviewJobs.ts`。前端功能不受影响——这一步是纯搬文件，
> 与多页面拆分无关；新增页面按 `src/adapters/` 注册适配器即可
> （见 `docs/概念/系统定位.md`）。
> 若日后要补做，仍按本节的"纯移动 + 改 import、逐批验证"方式执行。

### 为什么排在阶段 4 之后

阶段 4 的核心安全网是**双轨验证**（pack 派生结果 vs 现有硬编码结果，逐请求断言一致）。同时动目录会让 diff 里"哪边是新哪边是旧"无法分辨，安全网失效。

### 执行方式

- **纯移动 + 改 import**，不改任何逻辑
- 分目录逐批进行，每批一次可独立回滚
- 每批移动后立即运行完整测试（`docs/testing-and-release.md:9-20`），确保零行为变化
- `docs/` 中所有 file:line 引用同步更新（这部分与阶段 11 合并）

### 测试

无新测试。**验收标准是完整测试套件结果与移动前逐项一致。**

### 回滚

逐批恢复。

---

## 阶段 11 · 文档内容重写 ✅ 已完成（不搬文件）

### 问题

见 2.3。四个结构性问题：

1. 按"代码模块"组织，非按"读者任务"组织——加页面要读 4 份文档还不一定找全
2. `langgraph.md` 与 `registries-and-subgraphs.md` 高度耦合
3. `architecture.md` 与 `registries-and-subgraphs.md` 边界模糊
4. `business-rules.md` 文件与 `business-rules/` 目录同名

### 目标结构

见 2.3。

**实施结果**：按**读者意图**四组重排（Diátaxis 分法），文件名改为中文——想理解、想动手、想查事实各去一处，不再按系统模块分。

```
docs/
├── 索引.md
├── 概念/          想理解：一次审核的链路（新建）、系统定位、审核流水线、
│                  规则主图与能力（合并）、字段与判定规则
├── 指南/          想动手：新增业务与页面、改动与发布准则（合并）、部署
├── 参考/          想查事实：术语表、工作台展示、日志与排查
└── 业务/          各地区具体规则（报废置换-青岛、报废置换-长春、业务文档模板）
```

- `langgraph.md` + `registries-and-subgraphs.md` 合并为「规则主图与能力」（同一件事的两面）
- `ai-change-policy.md` + `testing-and-release.md` 合并为「改动与发布准则」
- 新建「一次审核的链路」：一次请求从点击到出结果的全过程，带 ★ 标注刻意的取舍
- 引用全部改为相对新路径；19 个文档校验无断链
- **代码文件名保持英文**：`docs/概览/术语表.md` 的命名原则写明「代码标识符、协议字段和注册表 ID 使用英文稳定名称」，中文文件名只用于文档

**以下是原计划的说明**：

把 13 个文档搬进新目录、改约 50 处链接，是纯整理动作，不产生功能价值，而且每搬一次
就要全量改一次链接。本轮改为：

- 重写 `docs/extension-guide.md`：从"改 15 个文件"的旧流程，改为"一份声明 + 登记"的实际做法，含声明各部分的写法和三种需要写代码的例外
- 重写 `docs/README.md`：从"按模块列文件"改为"按目的找文档"＋三条阅读路径
- 一致性校验：19 个文档全部链接可解析

### 原计划的分段（未采用）

| 段 | 时机 | 内容 |
| --- | --- | --- |
| **11a 结构** | **现在，与阶段 1、2 并行** | 目录重排 + `how-to/` 骨架 + `README.md` 三条阅读路径 + 更新所有失效链接 |
| **11b 内容** | 阶段 4、10 之后 | 按新内容填写 `how-to/add-review-page.md` 等，确保描述的是改造后的真实结构 |

**理由**：文档是其他所有阶段的参照系，先把结构理顺，后面每改一处都知道往哪写；但内容必须等阶段 4、10 定稿，否则要写两遍。

### 重写优先级

| 顺序 | 文档 | 理由 |
| --- | --- | --- |
| 1 | `how-to/add-review-page.md` | **直接服务核心目标**，当前完全缺失（`extension-guide.md` 只讲前端） |
| 2 | `how-to/debug-review.md` | 当前完全缺失；审核员报"这单为什么没过"，开发要翻五个文件 |
| 3 | `concepts/overview.md` | 系统定位与边界，新人入口 |
| 4 | `internals/workflow.md` | 合并 `langgraph.md` + `registries-and-subgraphs.md` |
| 5 | 其余 | 按需 |

### 验收

- 所有 `docs/` 内部链接可解析（`docs/testing-and-release.md:48` 发布闸门要求"文档链接不得指向已删除的旧计划"）
- 根 `README.md` 的文档索引同步更新
- `docs/ai-change-policy.md` 中引用的文档路径同步更新

### 回滚

文档改动独立于代码，可单独恢复。

---

# 第五部分 · 边界与不做

| 不做 | 依据 |
| --- | --- |
| 加多数表决改判定 | `docs/business-rules.md:50`「不得静默选择一个值」 |
| 将 `plan_capabilities` 换成 LLM 规划 | Profile 已静态声明执行内容，LLM 只引入不确定性 |
| 为"用了 LangGraph"而做 agent | 让工具决定目标 |
| 改 `aggregate_field` 的判定阶梯 | 那是判定原则的落点 |
| 改 `_mark_conflicting_evidence` 的标红逻辑 | 除阶段 3 的权威声明化外不动 |
| 推倒重写主图 | 主干设计成立 |
| 为目录调整单独开一次大重构 | 排在阶段 4 之后，与其同源 |

## 必须保持的架构不变量

1. 后端规则不下沉前端；DOM 细节不上移后端（`docs/ai-change-policy.md:15`）
2. 冲突不得静默选值（`docs/business-rules.md:50`）
3. 页面写回必须身份校验、白名单、唯一性检查、回读和回滚
4. 主图不按业务复制
5. 新增能力必须注册；注册表 ID 稳定

---

# 第六部分 · 决策与验收

## 6.1 决策状态

| # | 决策 | 状态 |
| --- | --- | --- |
| 1 | 过户残留清理 | ✅ 清理 |
| 2 | 挂靠自动写入的文档表述 | ✅ 改为"当前工作台隐藏相关任务，写入路径保留" |
| 3 | 新增采集清单端点 | ✅ 含于阶段 5 |
| 4 | `FieldEvidencePolicy` 加 `AuthorityRule` | ✅ 批准 |
| 5 | `PageAdapter` 落地 | ✅ 批准 |
| 6 | `REJECT_SUGGESTED` | ✅ 删除 |
| 7 | 阶段 7 上线门槛 | ✅ **取消门槛，直接改动**；保留 `semantic_retry_count` 开关供实测后调整 |
| 8 | `verify_invoice` 方案 | ✅ **B（做成能力）** |
| 9 | 业务扩展包（阶段 4） | ✅ 批准 |
| 10 | 目录结构调整（阶段 10）排在阶段 4 之后 | ✅ 已执行 |
| 11 | 文档重排分两段（11a 结构现在 / 11b 内容后填） | ✅ 已执行（改为只重写内容，不搬文件） |

## 6.2 统一验收要求

**标准验证**（`docs/testing-and-release.md:9-20`）：

```powershell
cd review-agent-service
uv run ruff check app tests
uv run python -m compileall -q app
uv run pytest tests -q
cd ..
npm --prefix review-extension test
npm --prefix review-extension run lint
npm --prefix review-extension run build
npm --prefix review-extension run build:public
git diff --check
```

**每个阶段必须齐备**：

- [ ] 实现
- [ ] 测试（成功 / 缺失 / 冲突 / 超时 / 权限拒绝）
- [ ] lint 与 build
- [ ] 文档更新
- [ ] 回滚路径
- [ ] 发布闸门自查（`docs/testing-and-release.md:48`）

**发布闸门相关**：本方案不含任何"只有自动通过而没有人工复核降级"的改动。阶段 7、8、9 均为**提高证据质量**，不改变人工复核出口。

**业务规则文档同步**（`docs/ai-change-policy.md:35`）：涉及审核业务的改动，必须同步更新 `docs/business-rules/` 下对应地区文档。

---

# 附录 A · 问题证据索引

| 问题 | 文件:行 |
| --- | --- |
| 前端丢弃 other 分区图片 | `review-extension/src/browser/image-candidates.ts:18` |
| 前端业务关键词正则 | `review-extension/src/browser/image-candidates.ts:15` |
| 前端 scope 打分只认旧车/新车 | `review-extension/src/browser/image-candidates.ts:32` |
| 前端分组标签表 | `review-extension/src/browser/business-scope.ts:12-27` |
| 前端字段定义表 | `review-extension/src/browser/page-field-collector.ts:18-124` |
| 后端业务范围硬门 | `app/agent/field_routing.py:58` |
| 材料×字段路由 if-else | `app/agent/field_routing.py:33-122` |
| 材料字段白名单 if-else | `app/agent/document_policies.py:57-138` |
| 过户残留分支 | `app/agent/retry.py:20-21` |
| 过户残留指令 | `app/agent/document_policies.py:29-32` |
| 白名单过滤 | `app/agent/qwen_client.py:96-100` |
| 重试执行（单次） | `app/agent/service.py:161-189` |
| 并发常量语义重叠 | `app/agent/service.py:31-33` |
| 主图节点数 | `app/agent/workflow.py:211-224`（14 个） |
| 主图条件分支 | `app/agent/workflow.py:227-240` |
| 启动期校验 | `app/agent/workflow.py:177-209` |
| 页面值锚定未文档化 | `app/rules/aggregate.py:44-59` |
| 一票否决 | `app/rules/aggregate.py:130-132` |
| 集合相等判定（不选胜者） | `app/rules/aggregate.py:145-152` |
| 单字段权威算法 | `app/rules/aggregate.py:184-313` |
| 众数只用于标红 | `app/rules/aggregate.py:63-90` |
| `compare.py` 死代码 | `app/rules/compare.py` |
| `cross_document.py` 空壳 | `app/rules/cross_document.py:19` |
| 字段标签（后端） | `app/rules/review_fields.py:33-59` |
| 权威三套实现 | `app/rules/field_evidence_policies.py:15-23`、`app/services/review_response.py:120-135`、`app/rules/composite_fields.py:99` |
| `REJECT_SUGGESTED` 不可达 | `app/models/review.py:41` |
| `verify_invoice` 硬编码 | `app/services/review.py:249-258` |
| 流式单图提交 | `app/services/jobs.py:194-197` |
| 能力子图透传壳 | `app/capabilities/subgraphs/*.py`（7 个，每个 14 行） |
| 能力概念散在四处 | `app/rules/capabilities.py`、`app/rules/capability_registry.py`、`app/capabilities/`、`app/capabilities/models.py` |
| 挂靠自动写入 | `review-extension/src/hooks/useScrapReplacementReview.ts:185, 402` |
| 挂靠任务隐藏 | `review-extension/src/reviewSteps.ts:27-35` |
| 文档：节点数 | `docs/langgraph.md` |
| 文档：挂靠不得触发 | `docs/frontend-presentation.md:103` |
| 文档：不得静默选值 | `docs/business-rules.md:50` |
| 准则：不得删失败分支 | `docs/ai-change-policy.md:53` |

---

# 附录 B · 已发现但未列入的问题

| 问题 | 位置 | 未列入原因 |
| --- | --- | --- |
| 无 CORS 中间件 | `app/main.py`（全库无 `add_middleware`） | 当前由扩展侧发起请求，非故障。新增 Web 客户端时需重新评估 |
| `input_facts` / `output_facts` 未通电 | `app/rules/capabilities.py:40`、`app/agent/planner.py:56` | 生产 Profile 均为空元组。机制已实现，属"预留未用" |
| `CapabilityBinding.parameters` 未被消费 | `app/rules/capabilities.py:68-69` | 同上 |
| `CapabilityBinding.enabled=False` 路径不生效 | `app/agent/workflow.py:441-449` 只看 `required` | 当前 5 个 Profile 的 `enabled` 全为 `True`，路径未覆盖。建议阶段 4 之后单独评估 |
| `AgentService` 6 并发与 Fair Scheduler 双层控制 | `app/agent/service.py:31`、`app/services/fair_scheduler.py` | 见阶段 1.7，仅澄清语义 |

---

# 附录 C · 方案形成依据

本方案结论来自实际阅读，非推断：

- **后端**：`app/` 全部 68 个 Python 文件
- **测试**：`tests/` 全部 38 个文件清单 + 重点文件逐行阅读
- **前端**：`review-extension/src/` 约 5800 行
- **文档**：`docs/` 全部
- **实测**：`pytest tests/test_agent_retry.py` 的跳过状态；`grep` 确认 `src/adapters/` 零引用

**已知的自我更正**（本方案已吸收）：

1. 初审时误判"系统没有多源聚合/投票"——实际 `app/rules/aggregate.py` 已有多源聚合，且众数仅用于标红
2. 初审时建议"加多数表决、加校验位自动裁决"——与 `docs/business-rules.md:50` 冲突，已撤回
3. 方案初稿遗漏 `verify_invoice` 与 `AgentService` 两项——已补为 1.6、1.7
4. 方案二稿以"改造项目"组织——改为以"降低新增页面成本"组织
5. 方案二稿未含目录与文档结构调整——已补为阶段 10、11

---

# 附录 D · 推进检查表

```
阶段 0   度量：统计 retry_summary 分布、加 uncertain 计数日志
阶段 1   清理：1.1 过户残留 / 1.2 compare.py / 1.3 cross_document
                / 1.4 REJECT_SUGGESTED / 1.5 前端死代码
                / 1.6 verify_invoice 转能力(B) / 1.7 并发语义注释
阶段 2   文档纠偏：2.1 节点数 / 2.2 挂靠 / 2.3 子图边界
                  / 2.4 PageAdapter / 2.5 去重锚定
阶段 3   权威层级显式化（AuthorityRule）
阶段 4   业务扩展包（pack + 五投影派生 + 双轨验证）
阶段 5   采集清单接口
阶段 6   前端 PageAdapter 落地
阶段 7   不确定字段定向重读（保留 semantic_retry_count 开关）
阶段 8   重读状态展示
阶段 9   局部重读子图
阶段 10  目录结构调整（纯移动，逐批验证）
阶段 11a 文档结构重排（现在）
阶段 11b 文档内容填实（阶段 4、10 之后）
```

---

# 第七部分 · 全量复查与收尾

阶段 1–11 完成后，对后端、前端、文档做了一次从头到尾的复查。复查发现的问题
分两类：**改造过程中引入的**（自纠）和**改造前就存在的**（遗留）。全部已修复，
只有一项经确认不改。

## 7.1 改造过程中引入的问题（已修）

| # | 问题 | 修法 |
| --- | --- | --- |
| 1 | 扩展包里有 4 个只写不读的装饰字段（`normalizer`、`preferred_sources`、`missing_behavior`、`writable`） | `normalizer` 接进 `app/fields/normalize.py` 成为唯一来源；其余三个删除 |
| 2 | `conftest.py` 用子串名单静默跳过测试 | 整个机制删除。改成显式删除失效用例或 `pytest.mark.skip` |
| 3 | 一个守卫测试因为名字里含 "transfer" 被跳过机制吃掉，从未真正执行 | 随 2 一起恢复执行 |
| 4 | 迁移文档时只改了 markdown 链接，正文里用反引号提到 6 处旧路径 | 逐条改正 |
| 5 | 用 `Path("app.agent").mkdir()` 误建了两个空目录 | 删除 |
| 6 | 删 CSS 时正则匹配到了 `@media` 里的行，连带删掉 118 行（含 `.qr-fields`） | 回滚重做，改为只匹配行首 |

## 7.2 改造前就存在、复查时才发现的缺陷（已修）

| # | 问题 | 影响 | 修法 |
| --- | --- | --- | --- |
| 1 | **小尺寸材料图被无条件丢弃** —— `image-candidates.ts` 的面积兜底（`宽×高 < 40000`）跑在材料关键词判断**之前**，关键词分支对小图永远不可达 | 类型未知但标题写着材料名的小图（例如车辆铭牌）连重读的机会都没有 | 三个条件改为彼此独立：类型已知 **或** 命中材料关键词 **或** 面积够大。面积兜底不再否决前两条 |
| 2 | **每张图的不确定字段数不打日志** | 结论是人工复核时，控制台看不出是哪张图、哪个字段触发了不确定 | `Agent image completed` 加 `uncertain_field_count=`、`uncertain_fields=`、`retry_attempts=`、`retry_result=`。最后两个区分"第一次就不确定"、"重读后仍不确定"和"时间不够没重读"三种情况 |
| 3 | **每项能力的执行结果不打日志** | 能力降级只能翻响应的 `capability_results` | `app/capabilities/registry.py` 出口加 `review capability completed capability=… status=… attempts=… checks=… trace_id=…`，成功/跳过/失败都会留下 |
| 4 | **采集清单里的中文名没有消费者** —— `fields[].label` / `materials[].label` 每次下发但前端从不读取，前端另有三张手写的中文名表 | 新增业务时后端声明了标签，前端仍要再改一份；改漏就静默显示英文键名 | 侧边栏自己应用同一份清单（它与 Content Script 是两个独立运行时），`fieldLabel()` 和材料名优先取清单，内置表退为兜底 |

## 7.3 经确认不改

| 项 | 结论 |
| --- | --- |
| 扩展 `manifest.json` 的 `content_scripts.matches`（`*://*/*`） | 保持现状。实测为被动注入（只读取、不主动请求），风险低；上架前再收窄 |

## 7.4 复查后的验证状态

| 项 | 结果 |
| --- | --- |
| 后端 `ruff` / `compileall` | 通过 |
| 后端 `pytest` | **413 passed, 0 skipped**（改造前 391 passed / 61 skipped） |
| 前端 `npm test` | **245 passed, 0 skipped** |
| 前端 `eslint` / `tsc --noEmit` | 通过 |
| 前端 `build` / `build:public` | 通过 |
| 文档链接 | 19 个文件，无断链 |
| `git diff --check` | 通过 |
