extends RefCounted
class_name SseClient
## GET /api/stream 的 SSE 客户端。
##
## Godot 没有内置 SSE，HTTPRequest 又会把整个响应缓冲住（对流式无用），
## 所以这里用底层 HTTPClient + 轮询 read_response_body_chunk()。
##
## **关键点：按字节缓冲，不按 chunk 解码。**
## SSE 分片边界和 UTF-8 字符边界无关，一个中文字（3 字节）完全可能
## 被切在两个 chunk 里。逐 chunk 调 get_string_from_utf8() 会产生乱码。
## 所以先把字节攒起来，只在找到 "\n\n"（纯 ASCII，字节里搜索安全）时
## 才把完整的一段解码成字符串。

signal frame_received(frame: Dictionary)
signal state_changed(state: int, detail: String)

enum State { IDLE, CONNECTING, REQUESTING, STREAMING, CLOSED, ERROR }

const _LF := 10
const _CR := 13

var state: int = State.IDLE

var _http := HTTPClient.new()
var _bytes := PackedByteArray()
var _host: String = ""
var _port: int = 0
var _path: String = "/api/stream"
var _requested := false

func open(host: String, port: int, path: String = "/api/stream") -> void:
	_host = host
	_port = port
	_path = path
	_bytes.clear()
	_requested = false
	var err := _http.connect_to_host(host, port)
	if err != OK:
		_set_state(State.ERROR, "connect_to_host 失败: %d" % err)
		return
	_set_state(State.CONNECTING, "")

func close() -> void:
	_http.close()
	_bytes.clear()
	_requested = false
	_set_state(State.CLOSED, "")

## 每帧调用
func poll() -> void:
	if state == State.IDLE or state == State.CLOSED or state == State.ERROR:
		return

	_http.poll()
	var s := _http.get_status()

	match s:
		HTTPClient.STATUS_CONNECTING, HTTPClient.STATUS_RESOLVING:
			return

		HTTPClient.STATUS_CONNECTED:
			if not _requested:
				var headers := [
					"Accept: text/event-stream",
					"Cache-Control: no-cache",
				]
				var err := _http.request(HTTPClient.METHOD_GET, _path, headers)
				if err != OK:
					_set_state(State.ERROR, "request 失败: %d" % err)
					return
				_requested = true
				_set_state(State.REQUESTING, "")
			return

		HTTPClient.STATUS_REQUESTING:
			return

		HTTPClient.STATUS_BODY:
			if state != State.STREAMING:
				var code := _http.get_response_code()
				if code != 200:
					_set_state(State.ERROR, "HTTP %d" % code)
					return
				_set_state(State.STREAMING, "")
			var chunk := _http.read_response_body_chunk()
			if chunk.size() > 0:
				_bytes.append_array(chunk)
				_drain()
			return

		HTTPClient.STATUS_CONNECTION_ERROR:
			_set_state(State.ERROR, "连接错误")
			return

		HTTPClient.STATUS_CANT_CONNECT:
			_set_state(State.ERROR, "无法连接")
			return

		HTTPClient.STATUS_CANT_RESOLVE:
			_set_state(State.ERROR, "无法解析主机")
			return

		HTTPClient.STATUS_DISCONNECTED:
			# 服务端关掉了流（助手退出 / 重启）
			_set_state(State.CLOSED, "流已关闭")
			return

		_:
			return

## 从字节缓冲里切出所有完整的 SSE 事件块
func _drain() -> void:
	while true:
		var idx := _find_blank_line()
		if idx < 0:
			break
		var block := _bytes.slice(0, idx)
		# 跳过分隔符本身：\n\n 是 2 字节，\r\n\r\n 是 4 字节
		var skip := 2
		if idx + 3 < _bytes.size() and _bytes[idx] == _CR:
			skip = 4
		_bytes = _bytes.slice(idx + skip)
		_handle_block(block.get_string_from_utf8())

## 找到空行的起始下标（\n\n 或 \r\n\r\n），找不到返回 -1
func _find_blank_line() -> int:
	var n := _bytes.size()
	for i in range(n - 1):
		if _bytes[i] == _LF and _bytes[i + 1] == _LF:
			return i
		if i + 3 < n and _bytes[i] == _CR and _bytes[i + 1] == _LF \
				and _bytes[i + 2] == _CR and _bytes[i + 3] == _LF:
			return i
	return -1

func _handle_block(block: String) -> void:
	# 一个块可能有多行：event: / data: / id: / 注释行(:)
	var payload := ""
	for raw_line in block.split("\n"):
		var line := String(raw_line).strip_edges()
		if line.is_empty() or line.begins_with(":"):
			continue
		if line.begins_with("data:"):
			var part := line.substr(5).strip_edges()
			if payload.is_empty():
				payload = part
			else:
				payload += "\n" + part
	if payload.is_empty():
		return
	var parsed: Variant = JSON.parse_string(payload)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_warning("[SSE] 无法解析的帧: %s" % payload.substr(0, 120))
		return
	frame_received.emit(parsed)

func _set_state(s: int, detail: String) -> void:
	if state == s:
		return
	state = s
	state_changed.emit(s, detail)
