# 助手网络搜索

助手复用 dsh 原生 `web_search`，并启用原生 HTTP 网页读取提供方及 `web_fetch`。工具属于助手通用能力，不依赖 Channel、Stage 或 Godot。

控制台的「公共配置」或助手「配置」左侧均有「网络搜索」。公共配置供全部助手继承，私有配置按字段覆盖公共搜索配置；「恢复继承」删除本助手的搜索覆盖。保存后通过现有配置下发链路热生效。

当前搜索提供方是 dsh 的 DeepSeek 原生搜索适配器。它向 Anthropic 兼容的 `/messages` 端点发送独立模型请求，要求返回结构化 `web_search_tool_result`，不会把模型自行生成的回答或链接当成搜索结果。默认基址为 `https://api.deepseek.com/anthropic/v1`，默认模型为 `deepseek-v4-flash`、输出上限为 4096 Token、最多执行 5 次服务端搜索。搜索请求具有独立的模型调用开销，聊天模型可以使用其他供应商。

不填独立搜索 Key 时，搜索复用 `providers.deepseek.apiKeyEnv`（缺省 `DEEPSEEK_API_KEY`）的凭据。填写独立 Key 时，缺省引用为 `DEEPSEEK_SEARCH_API_KEY`；也可以显式指定引用。搜索 Key 经 credentials seam 写入每助手隔离的凭据文件，settings 中只发布引用，不发布密钥。独立搜索 Key 不会覆盖聊天 Key；不同值共用同一引用会报配置冲突。

聊天的 `baseURL` 不会自动用于搜索。使用网关时，在「网络搜索」中填写支持原生搜索的 Anthropic 兼容基址，例如 `https://gateway.example/anthropic/v1`，不要在基址末尾填写 `/messages`。普通聊天兼容接口若不返回原生搜索结果块，会产生明确的工具错误。

配置中心有效配置示例：

```json
{
  "webSearch": {
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "baseURL": "https://api.deepseek.com/anthropic/v1",
    "model": "deepseek-v4-flash",
    "maxTokens": 4096,
    "maxUses": 5
  }
}
```

升级代码后需重启控制台和助手一次，加载新增菜单、配置字段与网页读取插件。之后修改搜索配置无需重启。可向助手发送：「搜索最近的 Godot 更新，附上来源链接」，观察 `web_search` 的工具调用和结果；需要全文时助手可调用 `web_fetch`。

验证使用本机模拟搜索接口，经真实 dsh 工具注册表执行搜索和网页读取，覆盖配置热更新、凭据隔离、结果来源格式、HTTP 失败、公共继承和私有恢复。它不等同于外部 DeepSeek 服务的实测；外部调用仍取决于你的凭据、网络和网关能力。

参考：[dsh 原生搜索提供方](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/web/web-search-deepseek)。
