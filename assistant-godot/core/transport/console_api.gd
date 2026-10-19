extends Node
class_name ConsoleApi
## console 的注册表 / 创建 API 客户端。
##
## 端口是 console 的 spawner 动态分配的，所以客户端不应该记住端口 ——
## 每次启动都问 console 要在线列表，由用户选。

signal listed(assistants: Array)
signal list_failed(reason: String)
signal spawned(info: Dictionary)
signal spawn_failed(reason: String)

var _list_req: HTTPRequest
var _spawn_req: HTTPRequest
## 最近一次列表请求的 HTTP 状态，0 表示尚未收到响应。
var last_list_status: int = 0

func _ready() -> void:
	_list_req = _mk(8.0)
	_spawn_req = _mk(20.0)
	_list_req.request_completed.connect(_on_list_done)
	_spawn_req.request_completed.connect(_on_spawn_done)

func _mk(t: float) -> HTTPRequest:
	var r := HTTPRequest.new()
	r.timeout = t
	add_child(r)
	return r

func _auth_headers() -> PackedStringArray:
	var headers := PackedStringArray()
	if not AppConfig.api_key.is_empty():
		headers.append("Authorization: Bearer " + AppConfig.api_key)
	return headers

## GET {console}/api/assistants
func list() -> void:
	_list_req.cancel_request()
	last_list_status = 0
	var err := _list_req.request(AppConfig.console_url + "/api/assistants", _auth_headers())
	if err != OK:
		list_failed.emit("请求发起失败：%d" % err)

## POST {console}/api/assistants/spawn
## 只传 name + persona：model / provider 走 console 的公共配置，
## 客户端不该替用户决定用哪个模型。
func spawn(name: String, persona: String = "") -> void:
	var payload := {"name": name}
	if not persona.strip_edges().is_empty():
		payload["persona"] = persona
	var headers := _auth_headers()
	headers.append("Content-Type: application/json")
	var err := _spawn_req.request(
		AppConfig.console_url + "/api/assistants/spawn",
		headers,
		HTTPClient.METHOD_POST,
		JSON.stringify(payload),
	)
	if err != OK:
		spawn_failed.emit("请求发起失败：%d" % err)

func _on_list_done(result: int, code: int, _h: PackedStringArray, body: PackedByteArray) -> void:
	last_list_status = code
	if result != HTTPRequest.RESULT_SUCCESS:
		list_failed.emit("连不上 console（%s）" % AppConfig.console_url)
		return
	if code == 401:
		list_failed.emit("HTTP 401：API Key 未填写或已失效，请在连接设置中填写 Console 的平台 Key。")
		return
	if code != 200:
		list_failed.emit("console 返回 HTTP %d" % code)
		return
	var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
	if typeof(parsed) != TYPE_ARRAY:
		list_failed.emit("console 返回的不是数组")
		return
	var out: Array = []
	for item in parsed:
		if typeof(item) == TYPE_DICTIONARY:
			out.append(item)
	listed.emit(out)

func _on_spawn_done(result: int, code: int, _h: PackedStringArray, body: PackedByteArray) -> void:
	if result != HTTPRequest.RESULT_SUCCESS:
		spawn_failed.emit("连不上 console")
		return
	var d: Dictionary = {}
	var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
	if typeof(parsed) == TYPE_DICTIONARY:
		d = parsed
	if code == 201 or code == 200:
		# 注意：spawn 返回的是 status:"starting"，
		# 助手要等它自己 POST /api/register 之后才会出现在列表里
		spawned.emit(d)
	else:
		spawn_failed.emit(String(d.get("error", "HTTP %d" % code)))


## 只保留在线、且支持 Godot 客户端 Channel 的助手。
## 列表里也会有已经退出的历史条目。
static func online_only(list: Array) -> Array:
	var out: Array = []
	for item in list:
		if typeof(item) != TYPE_DICTIONARY:
			continue
		var d: Dictionary = item
		if String(d.get("status", "")) == "online" and has_ws(d):
			out.append(d)
	return out


## 判断是否支持 StageChannel；优先使用端点元数据，兼容旧助手的注册值。
static func has_ws(d: Dictionary) -> bool:
	if d.has("channelEndpoints"):
		var endpoints: Variant = d.get("channelEndpoints")
		if typeof(endpoints) != TYPE_ARRAY:
			return false
		for item in endpoints:
			if typeof(item) == TYPE_DICTIONARY:
				var endpoint: Dictionary = item
				if String(endpoint.get("id", "")) == "stage" and String(endpoint.get("protocol", "")) == "ws" and int(endpoint.get("port", 0)) > 0:
					return true
		return false
	var channels: Variant = d.get("channels", [])
	if typeof(channels) != TYPE_ARRAY:
		return false
	return "stage" in channels or "ws" in channels or "vn" in channels or "ai-town" in channels


## 返回 StageChannel 的直连地址。明确存在但不含 stage endpoint 时返回空字典。
static func stage_endpoint(d: Dictionary) -> Dictionary:
	if d.has("channelEndpoints"):
		var endpoints: Variant = d.get("channelEndpoints")
		if typeof(endpoints) != TYPE_ARRAY:
			return {}
		for item in endpoints:
			if typeof(item) != TYPE_DICTIONARY:
				continue
			var endpoint: Dictionary = item
			if String(endpoint.get("id", "")) == "stage" and String(endpoint.get("protocol", "")) == "ws":
				return endpoint
		return {}
	return {"host": String(d.get("host", "127.0.0.1")), "port": int(d.get("port", 0)), "path": "/ws"}
