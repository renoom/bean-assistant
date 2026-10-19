extends Node
class_name StageChannelClient
## Godot 客户端通过 StageChannel 接入舞台协议。
##
## 连接 ws://host:port/ws，上报 client、Stage 和 Stage 能力，
## 接收 AI 主动推来的指令 / LLM 完整事件流，执行指令后回执。
##
## 协议（由 StageChannel 接入）：
##   hello(channel=stage) → hello_ack
##   stage_register(stage={id,kind,environment,commands}) → stage_register_result
##   stage_activate(stageId) → stage_activate_result → connected
##   command(commandId,command,args) → command_result(commandId,ok,result,error)
##   llm_event(event) 为模型调试事件。
##
##   上行（Godot → 服务端）统一一条场景事件：
##     {type:'event', event:{kind, ...}}  kind = 事件名称，其余为原始字段
##
## 角色（role）：
##   'assistant' = 替某个 assistant 进程接进来的会话通道
##   'user'      = 玩家自己的「私人通道」
##
## 多 ws 由 VnClientManager 持有。

signal connected()
signal disconnected(reason: String)
## AI 通过 stage_action 下发的指令。{commandId, command, args}
signal command_received(command: Dictionary)
## 服务端推来的 LLM 完整事件流（chunk / assistant_message / tool_call / tool_result …）。
## 只进调试面板，不渲染。event = {type, data}
signal llm_event_received(event: Dictionary)

# WebSocketPeer defaults to 65,535 bytes for each byte buffer. EventHub forwards
# complete raw model events (and often a readable companion frame), so a normal
# model-input/history event can exceed that single-packet ceiling. Keep an explicit,
# finite budget: enough for model context, while bounding memory per assistant.
const INBOUND_BUFFER_BYTES := 8 * 1024 * 1024
const OUTBOUND_BUFFER_BYTES := 1024 * 1024
const MAX_QUEUED_PACKETS := 4096

var _peer: WebSocketPeer
var _client_id := ""
var _role: String = "assistant"
var _assistant_id := ""
var _name := ""
var _sprite_path := ""
var _stage_id := "vn:godot-main"
var _stage_kind := "vn"
# JSON Schema 风格的场景能力列表（与 assistant/src/stage/types.ts 对齐）。
# 每个元素是 Dictionary：{name, description?, parameters?, returns?, example?}
var _commands: Array = []
var _hello_sent := false
var _was_connected := false
var _acknowledged := false
var _environment: Dictionary = {}
var _handshake_phase := "hello"
var _handshake_deadline := 0
var _failed := false
var _disconnect_reported := false


## 打开一个 StageChannel 连接。
## role='user' 时 assistantId/name/spritePath 都忽略；clientId 仍由调用方提供实例级通信身份。
func open(host: String, port: int, client_id: String, commands: Array, role: String = "assistant", assistant_id: String = "", display_name: String = "", sprite_path: String = "", stage_id: String = "vn:godot-main", stage_kind: String = "vn", environment: Dictionary = {}, ws_path: String = "/ws", use_tls: bool = false) -> void:
	_client_id = client_id
	_commands = commands
	_role = role if role == "user" else "assistant"
	_assistant_id = assistant_id
	_name = display_name
	_sprite_path = sprite_path
	_stage_id = stage_id
	_stage_kind = stage_kind
	_hello_sent = false
	_was_connected = false
	_acknowledged = false
	_environment = environment.duplicate(true)
	_handshake_phase = "hello"
	_handshake_deadline = Time.get_ticks_msec() + 30000
	_failed = false
	_disconnect_reported = false
	_peer = WebSocketPeer.new()
	_peer.inbound_buffer_size = INBOUND_BUFFER_BYTES
	_peer.outbound_buffer_size = OUTBOUND_BUFFER_BYTES
	_peer.max_queued_packets = MAX_QUEUED_PACKETS
	var query := "" if AppConfig.api_key.is_empty() else "?api_key=" + AppConfig.api_key.uri_encode()
	var scheme := "wss" if use_tls else "ws"
	var url_host := "[" + host + "]" if host.contains(":") and not host.begins_with("[") else host
	var err := _peer.connect_to_url("%s://%s:%d%s%s" % [scheme, url_host, port, ws_path, query])
	if err != OK:
		_failed = true
		_emit_disconnected_once("WS 连接失败: %s (%d)" % [error_string(err), err], true)


func close() -> void:
	if _peer != null:
		_peer.close()


## 给某条指令回执
func send_result(command_id: String, ok: bool, result: Variant, error: String = "") -> void:
	_send({
		"type": "command_result",
		"commandId": command_id,
		"ok": ok,
		"result": result,
		"error": error,
	})


## 上行一条场景事件（用户说话 / 互动 / 另一助手说话），统一用 event 消息。
## event 由调用方（VnClientManager）构造好，含 kind（事件名称）+ 原始字段。
func send_event(event: Dictionary) -> void:
	_send({ "type": "event", "stageId": _stage_id, "event": event })


func _send(d: Dictionary) -> void:
	if _peer == null:
		return
	_peer.send_text(JSON.stringify(d))


## 每帧调用
func poll() -> void:
	if _peer == null or _failed:
		return
	if not _acknowledged and Time.get_ticks_msec() > _handshake_deadline:
		_fail_handshake("场景连接超时：" + _handshake_phase)
		return
	_peer.poll()
	match _peer.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			if not _hello_sent:
				var hello := {
					"type": "hello",
					"channel": "stage",
					"clientType": "godot",
					"clientId": _client_id,
					"role": _role,
				}
				if _role == "assistant" and not _assistant_id.is_empty():
					hello["assistantId"] = _assistant_id
				if not _name.is_empty():
					hello["name"] = _name
				if not _sprite_path.is_empty():
					hello["spritePath"] = _sprite_path
				_send(hello)
				_hello_sent = true
				_was_connected = true
			while _peer.get_available_packet_count() > 0:
				_handle(_peer.get_packet().get_string_from_utf8())

		WebSocketPeer.STATE_CLOSED:
			_was_connected = false
			var close_code := _peer.get_close_code()
			var close_reason := _peer.get_close_reason().strip_edges()
			var detail := "WS 已关闭 (code=%d" % close_code
			if not close_reason.is_empty():
				detail += ", reason=%s" % close_reason
			detail += ")"
			_emit_disconnected_once(detail)

		_:
			pass


func _handle(text: String) -> void:
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		return
	var d: Dictionary = parsed
	match String(d.get("type", "")):
		"hello_ack":
			if _handshake_phase != "hello" or _failed:
				return
			_handshake_phase = "register"
			_send({
				"type": "stage_register", "requestId": "initial-register",
				"stage": {"id": _stage_id, "kind": _stage_kind,
					"environment": _environment, "commands": _commands},
			})
		"stage_register_result":
			if _handshake_phase != "register" or d.get("requestId") != "initial-register" or _failed:
				return
			var result: Dictionary = d.get("result", {}) if d.get("result") is Dictionary else {}
			if not String(result.get("kind", "")).is_empty() and result.get("kind") in ["registered", "updated", "unchanged"]:
				if _role == "assistant":
					_handshake_phase = "activate"
					_send({"type": "stage_activate", "requestId": "initial-activate", "stageId": _stage_id})
				else:
					_finish_handshake()
			else:
				_fail_handshake("场景注册失败：" + String(result.get("reason", d.get("error", "无效回执"))))
		"stage_activate_result":
			if _handshake_phase != "activate" or d.get("requestId") != "initial-activate" or _failed:
				return
			var result: Dictionary = d.get("result", {}) if d.get("result") is Dictionary else {}
			if result.get("kind") in ["changed", "unchanged"]:
				_finish_handshake()
			else:
				_fail_handshake("场景激活失败：" + String(result.get("reason", d.get("error", "无效回执"))))
		"error":
			if not _acknowledged:
				_fail_handshake(String(d.get("error", "连接失败")))
		"command":
			if String(d.get("stageId", _stage_id)) != _stage_id:
				send_result(String(d.get("commandId", "")), false, null, "该场景未在此客户端加载")
				return
			var args: Variant = d.get("args", {})
			var args_dict: Dictionary = args if typeof(args) == TYPE_DICTIONARY else {}
			command_received.emit({
				"commandId": String(d.get("commandId", "")),
				"command": String(d.get("command", "")),
				"args": args_dict,
			})
		"llm_event":
			var ev: Variant = d.get("event", {})
			if typeof(ev) == TYPE_DICTIONARY:
				llm_event_received.emit(ev)
		_:
			pass   # hello_ack / error / 其它帧忽略


func _finish_handshake() -> void:
	if _acknowledged or _failed:
		return
	_handshake_phase = "ready"
	_acknowledged = true
	connected.emit()


func _fail_handshake(reason: String) -> void:
	if _failed:
		return
	_failed = true
	_was_connected = false
	close()
	_emit_disconnected_once(reason)


func _emit_disconnected_once(reason: String, deferred: bool = false) -> void:
	if _disconnect_reported:
		return
	_disconnect_reported = true
	if deferred:
		disconnected.emit.call_deferred(reason)
	else:
		disconnected.emit(reason)
