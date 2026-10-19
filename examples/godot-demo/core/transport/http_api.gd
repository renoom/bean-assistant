extends Node
class_name HttpApi
## 助手的请求/响应类 API。用 HTTPRequest 节点（这些都是短请求，不需要流式）。
## 必须挂到场景树里才能工作。
##
## 地址是**每次请求时才解析**的，不能在 _ready 里缓存 —— 自动发现
## 是异步的，构造时 AppConfig.port 还是 0，缓存下来就会请求
## http://127.0.0.1:0/... 然后报 Error parsing URL。

signal message_accepted(turn: int)
signal message_failed(reason: String)
signal status_received(status: Dictionary)
signal health_received(ok: bool)

## 非空则覆盖 AppConfig（测试用）
var _base_override: String = ""
var _msg_req: HTTPRequest
var _status_req: HTTPRequest
var _cancel_req: HTTPRequest

func _init(base_url: String = "") -> void:
	_base_override = base_url

func _ready() -> void:
	_msg_req = _mk()
	_status_req = _mk()
	_cancel_req = _mk()
	_msg_req.request_completed.connect(_on_message_done)
	_status_req.request_completed.connect(_on_status_done)

func _base() -> String:
	if not _base_override.is_empty():
		return _base_override
	return AppConfig.base_url()

func _auth_headers() -> PackedStringArray:
	var headers := PackedStringArray()
	if not AppConfig.api_key.is_empty():
		headers.append("Authorization: Bearer " + AppConfig.api_key)
	return headers

func _mk() -> HTTPRequest:
	var r := HTTPRequest.new()
	r.timeout = 20.0
	add_child(r)
	return r

## POST /api/message  { text }
func send_message(text: String) -> void:
	if text.strip_edges().is_empty():
		message_failed.emit("空消息")
		return
	var body := JSON.stringify({"text": text})
	var headers := _auth_headers()
	headers.append("Content-Type: application/json")
	var err := _msg_req.request(
		_base() + "/api/message",
		headers,
		HTTPClient.METHOD_POST,
		body,
	)
	if err != OK:
		message_failed.emit("请求发起失败: %d" % err)

## GET /api/status
func fetch_status() -> void:
	var err := _status_req.request(_base() + "/api/status", _auth_headers())
	if err != OK:
		health_received.emit(false)

## POST /api/cancel
func cancel() -> void:
	# 结果不关心：取消是尽力而为
	_cancel_req.request(_base() + "/api/cancel", _auth_headers(), HTTPClient.METHOD_POST, "")

func _on_message_done(_r: int, code: int, _h: PackedStringArray, body: PackedByteArray) -> void:
	var d := _json(body)
	if code == 200 and d.get("accepted", false):
		message_accepted.emit(int(d.get("turn", 0)))
	else:
		var reason: String = d.get("error", "HTTP %d" % code)
		message_failed.emit(reason)

func _on_status_done(_r: int, code: int, _h: PackedStringArray, body: PackedByteArray) -> void:
	if code != 200:
		health_received.emit(false)
		return
	health_received.emit(true)
	status_received.emit(_json(body))

func _json(body: PackedByteArray) -> Dictionary:
	var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
	if typeof(parsed) == TYPE_DICTIONARY:
		return parsed
	return {}
