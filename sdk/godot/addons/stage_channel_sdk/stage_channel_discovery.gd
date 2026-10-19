extends Node
class_name StageChannelDiscovery
## Console 发现 + StageChannel 地址构造。
##
## 发现：GET {base}/api/assistants（Authorization: Bearer <platformKey>），
## 过滤 status == "online" 且支持 stage 通道的助手。
## 地址：
##   · 网关模式（公网推荐）：gateway_ws_url(base, gatewayWsPath, api_key)
##       → wss://<console>/a/{sessionId}/ws?api_key=<key>
##   · 直连模式（本地 / 无 Console）：direct_ws_url(host, port, path, use_tls)
##       → ws://<host>:<port>/ws
##
## 发现到的每个条目自带 gatewayBase / gatewayWsPath；网关模式只使用这两个字段，
## 绝不使用 channelEndpoints 里的内部 host/port（见 docs/clients.md）。
##
## 用法：
##   var discovery := StageChannelDiscovery.new()
##   add_child(discovery)                     # HTTPRequest 必须是场景树节点
##   discovery.listed.connect(_on_listed)
##   discovery.failed.connect(_on_failed)
##   discovery.discover("http://127.0.0.1:3000", api_key)
##
##   # 回调里：
##   var url := StageChannelDiscovery.gateway_ws_url(
##       console_base, StageChannelDiscovery.gateway_ws_path(info), api_key)

signal listed(assistants: Array)
signal failed(reason: String)

const DEFAULT_TIMEOUT_SEC := 10.0

## 最近一次 HTTP 状态码（0 = 还没收到响应）。
var last_status := 0

var _request: HTTPRequest = null


func _ready() -> void:
	_ensure_request()


## 发起 GET {base_url}/api/assistants；结果通过 listed / failed 信号返回。
func discover(base_url: String, api_key: String = "") -> void:
	_ensure_request()
	if _request == null:
		failed.emit("StageChannelDiscovery must be added to the scene tree before discover()")
		return
	var base := base_url.strip_edges()
	if base.is_empty():
		failed.emit("console base url is empty")
		return
	_request.cancel_request()
	last_status = 0
	var error := _request.request(assistants_url(base), _auth_headers(api_key))
	if error != OK:
		failed.emit("console request failed to start: %s (%d)" % [error_string(error), error])


## 取消进行中的请求并释放它（节点退出时会自动清理）。
func cancel() -> void:
	if _request != null:
		_request.cancel_request()


func _ensure_request() -> void:
	if _request != null:
		return
	if not is_inside_tree():
		return
	_request = HTTPRequest.new()
	_request.timeout = DEFAULT_TIMEOUT_SEC
	add_child(_request)
	_request.request_completed.connect(_on_request_completed)


func _auth_headers(api_key: String) -> PackedStringArray:
	var headers := PackedStringArray()
	headers.append("Accept: application/json")
	var key := api_key.strip_edges()
	if not key.is_empty():
		headers.append("Authorization: Bearer " + key)
	return headers


func _on_request_completed(
	result: int, code: int, _headers: PackedStringArray, body: PackedByteArray
) -> void:
	last_status = code
	if result != HTTPRequest.RESULT_SUCCESS:
		failed.emit("console request failed: " + _result_name(result))
		return
	if code == 401:
		failed.emit("HTTP 401: invalid or missing platform API key")
		return
	if code != 200:
		failed.emit("console returned HTTP %d" % code)
		return
	var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
	if typeof(parsed) != TYPE_ARRAY:
		failed.emit("console returned a non-array payload")
		return
	listed.emit(online_stage_assistants(parsed))


func _result_name(result: int) -> String:
	match result:
		HTTPRequest.RESULT_CANT_CONNECT:
			return "cannot connect"
		HTTPRequest.RESULT_CANT_RESOLVE:
			return "cannot resolve host"
		HTTPRequest.RESULT_CONNECTION_ERROR:
			return "connection error"
		HTTPRequest.RESULT_TIMEOUT:
			return "timeout"
		HTTPRequest.RESULT_TLS_HANDSHAKE_ERROR:
			return "TLS handshake error"
		_:
			return "result %d" % result


# ============================================================
# 静态工具：地址构造
# ============================================================

## GET {base}/api/assistants 的完整 URL（容忍尾部斜杠）。
static func assistants_url(base_url: String) -> String:
	return base_url.strip_edges().trim_suffix("/") + "/api/assistants"


## 网关模式 WebSocket URL。
##   base_url: Console 基地址，如 "https://console.example.com" 或含反向代理前缀
##             "https://console.example.com/console"。
##   ws_path:  发现结果里的 gatewayWsPath，如 "/a/{sessionId}/ws"。
##   api_key:  平台 API Key（放进 ?api_key=；空串则省略）。
static func gateway_ws_url(base_url: String, ws_path: String, api_key: String = "") -> String:
	var base := base_url.strip_edges().trim_suffix("/")
	var scheme := "ws"
	var rest := base
	if base.begins_with("https://"):
		scheme = "wss"
		rest = base.substr(8)
	elif base.begins_with("http://"):
		rest = base.substr(7)
	elif base.begins_with("wss://"):
		scheme = "wss"
		rest = base.substr(6)
	elif base.begins_with("ws://"):
		rest = base.substr(5)

	var authority := rest
	var prefix := ""
	var slash := rest.find("/")
	if slash >= 0:
		authority = rest.left(slash)
		prefix = rest.substr(slash).trim_suffix("/")

	var path := normalize_ws_path(ws_path)
	var url := "%s://%s%s%s" % [scheme, authority, prefix, path]
	return append_api_key(url, api_key)


## 直连模式 WebSocket URL（host 可传 IPv6，自动加方括号）。
static func direct_ws_url(
	host: String, port: int, path: String = "/ws", use_tls: bool = false, api_key: String = ""
) -> String:
	var scheme := "wss" if use_tls else "ws"
	var authority := host.strip_edges()
	if authority.is_empty():
		authority = "127.0.0.1"
	if authority.contains(":") and not authority.begins_with("["):
		authority = "[" + authority + "]"
	if port > 0:
		authority = "%s:%d" % [authority, port]
	var url := "%s://%s%s" % [scheme, authority, normalize_ws_path(path)]
	return append_api_key(url, api_key)


static func normalize_ws_path(path: String) -> String:
	var normalized := path.strip_edges()
	if normalized.is_empty():
		return "/ws"
	if not normalized.begins_with("/"):
		normalized = "/" + normalized
	return normalized


static func append_api_key(url: String, api_key: String) -> String:
	var key := api_key.strip_edges()
	if key.is_empty():
		return url
	return url + "?api_key=" + key.uri_encode()


## 发现条目里的网关 WS 路径；没有 gatewayWsPath 时尝试 gatewayBase + "/ws"。
static func gateway_ws_path(info: Dictionary) -> String:
	var path := String(info.get("gatewayWsPath", "")).strip_edges()
	if not path.is_empty():
		return normalize_ws_path(path)
	var base := String(info.get("gatewayBase", "")).strip_edges()
	if not base.is_empty():
		return normalize_ws_path(base.trim_suffix("/") + "/ws")
	return ""


# ============================================================
# 静态工具：过滤与直连端点
# ============================================================

## 只保留 status == "online" 且支持 stage 通道的助手。
static func online_stage_assistants(assistants: Array) -> Array:
	var result: Array = []
	for item: Variant in assistants:
		if typeof(item) != TYPE_DICTIONARY:
			continue
		var info: Dictionary = item
		if String(info.get("status", "")) != "online":
			continue
		if not supports_stage(info):
			continue
		result.append(info)
	return result


## 是否支持 StageChannel。
## 存在 channelEndpoints 元数据时以元数据为准（与 demo ConsoleApi.has_ws 一致）；
## 否则要求 channels 包含 "stage"（协议 §2 的选择规则）。
static func supports_stage(info: Dictionary) -> bool:
	if info.has("channelEndpoints"):
		var endpoints: Variant = info.get("channelEndpoints")
		if typeof(endpoints) != TYPE_ARRAY:
			return false
		for item: Variant in endpoints:
			if typeof(item) != TYPE_DICTIONARY:
				continue
			var endpoint: Dictionary = item
			if (
				String(endpoint.get("id", "")) == "stage"
				and String(endpoint.get("protocol", "")) == "ws"
				and int(endpoint.get("port", 0)) > 0
			):
				return true
		return false
	var channels: Variant = info.get("channels", [])
	if typeof(channels) != TYPE_ARRAY:
		return false
	return "stage" in channels


## StageChannel 直连端点（仅本地开发 / 无 Console 时使用）。
## 元数据存在但没有 stage ws 端点时返回 {}；无元数据时回退 host/port 字段。
static func stage_endpoint(info: Dictionary) -> Dictionary:
	if info.has("channelEndpoints"):
		var endpoints: Variant = info.get("channelEndpoints")
		if typeof(endpoints) != TYPE_ARRAY:
			return {}
		for item: Variant in endpoints:
			if typeof(item) != TYPE_DICTIONARY:
				continue
			var endpoint: Dictionary = item
			if (
				String(endpoint.get("id", "")) == "stage"
				and String(endpoint.get("protocol", "")) == "ws"
			):
				return endpoint
		return {}
	return {
		"host": String(info.get("host", "127.0.0.1")),
		"port": int(info.get("port", 0)),
		"path": "/ws",
	}
