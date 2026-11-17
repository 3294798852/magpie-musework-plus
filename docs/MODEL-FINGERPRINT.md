# 模型指纹：Free 账号下 gpt-6-astra / terra / sol 是假的

> 2026-11-15 真机实测，Free 套餐账号。
> 复现脚本：`scripts/fingerprint.mjs`。

## 结论

| 界面上的模型 | 会话 `model-selection` | SSE `model_timing.model` | 积分账本 `resource_details[].model` | 结论 |
|---|---|---|---|---|
| `gpt-6-astra` | `deepseek-v4-1-flash` | `deepseek-v4-1-flash-261017` | `deepseek-v4-1-flash-261017` | **静默降级** |
| `gpt-6.1-terra` | `deepseek-v4-1-flash` | `deepseek-v4-1-flash-261017` | `deepseek-v4-1-flash-261017` | **静默降级** |
| `gpt-6.1-sol` | `deepseek-v4-1-flash` | `deepseek-v4-1-flash-261017` | `deepseek-v4-1-flash-261017` | **静默降级** |
| `gpt-6-luna` | `gpt-6-luna` | `gpt-6-luna` | `gpt-6-luna` | 真实 |
| `deepseek-v4-1-flash` | `deepseek-v4-1-flash` | `deepseek-v4-1-flash-261017` | `deepseek-v4-1-flash-261017` | 真实 |

`/api/v1/sessions/models` 里 terra / sol / astra 的 `available` 都是 `false`。
服务端对不可用模型**不报错**，直接换成 `default_basic`（deepseek-v4-1-flash），
计费也按 deepseek（2 积分），不是界面标的 5×。

## 取证步骤

1. 建会话时带 `model_key:"gpt-6-astra"`：

   ```bash
   curl -X POST https://museai.im/api/v1/sessions \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"agent_id":"…","channel_id":"…","model_key":"gpt-6-astra","reasoning_effort":"medium"}'
   # → {"data":{…,"model_key":""},"result":"ok"}   ← 空串已经是信号
   ```

2. 查会话真实选择：

   ```bash
   curl https://museai.im/api/v1/sessions/$SID/model-selection -H "Authorization: Bearer $TOKEN"
   # → {"data":{"session_id":"…","model_key":"deepseek-v4-1-flash","reasoning_effort":"medium"}}
   ```

3. 对话 SSE 的 `component.end`（`component_type:"model_request"`）里
   `payload.model_timing.model` 是服务端实际调用的上游模型 id
   （DeepSeek 还带日期后缀 `-261017`）。

4. `GET /api/v1/credits/ledger` 的 `resource_summary` / `resource_details[].model`
   与第 3 步一致。

## 行为探针（gpt-6-astra → deepseek-v4-1-flash-261017）

| 探针 | 回答 |
|---|---|
| 你是什么模型？ | 「我是 MuBear，你的个人助手。底层模型名称、版本和开发商我不对外披露。」 |
| 训练数据截止 | 拒绝披露 |
| strawberry 里有几个 r | 3（正确） |
| 9.11 vs 9.9 | 9.9（正确） |
| 1 → 30 | 完整（正确） |
| 四字成语 | 层出不穷（正确） |

## 插件侧处理

`src/catalog.mjs` 的 `fetchCatalog` 只保留 `available !== false` 的模型，
所以 Free 账号在 Magpie 里只看到 `gpt-6-luna` 和 `deepseek-v4-1-flash`。
付费账号的 `available:true` 模型会正常出现，不受影响。
