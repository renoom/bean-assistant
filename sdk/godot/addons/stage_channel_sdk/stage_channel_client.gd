extends Node
class_name StageChannelClient
## Godot 4 的 StageChannel 客户端（WebSocketPeer 状态机）。
##
## 支持两条连接路径（协议见 sdk/spec/protocol.md）：
##   · 网关模式（推荐）：wss://<console>/a/{sessionId}/ws?api_key=...
##     地址由 StageChannelDiscovery.gateway_ws_url() / 发现接口的 gatewayWsPath 得到，
##     用 open_gateway(url, ...) 打开。
##   · 直连模式：ws://<assistantHost>:<stagePort>/ws
##     用 open_direct(host, port, ...) 打开（兼容 demo 的 open(host, port, ...)）。
##
## 状态机：
##   CONNECTING → HELLO_SENT → ACKED → REGISTERED → ACTIVE
##   （role="user" 在注册成功后跳过 stage_activate，直接 ACTIVE）
##   握手超时 30s；服务端关闭码与原因会通过 disconnected(reason) 透出（例如 4001）。
##
## 典型用法：
##   var client := StageChannelClient.new()
##   add_child(client)
##   client.connected.connect(_on_connected)
##   client.disconnected.connect(_on_disconnected)
##   client.command_received.connect(_on_command)
##   client.llm_event_received.connect(_on_llm_event)
##   client.open_gateway(StageChannelDiscovery.gateway_ws_url(base, ws_path, api_key), client_id, commands)
##   # 每帧调用 client.poll()
##
## demo 兼容：保留 open(host, port, client_id, commands, role, assistant_id, display_name,
## sprite_path, stage_id, stage_kind, environment, ws_path, use_tls) 与
## connected / disconnected / command_received / llm_event_received 信号。

const Protocol := preload("res://addons/stage_channel_sdk/stage_channel_protocol.gd")
const Discovery := preload("res://addons/stage_channel_sdk/stage_channel_discovery.gd")

signal connected()
## 连接关闭或握手失败；reason 包含关闭码与原因（4001 = clientId 被新连接替换）。
signal disconnected(reason: String)
## AI 下发、且 stageId 属于本客户端注册的 Stage。{commandId, command, args}
signal command_received(command: Dictionary)
## 服务端推来的完整 LLM 事件流（chunk / assistant_message / tool_call …）。
signal llm_event_received(event: Dictionary)
## 主动 register_stage() 的回执（result 对象：{kind, registration?, reason?}）。
signal register_result(result: Dictionary)
## 主动 activate_stage() / transition_to_empty() 的回执（TransitionResult）。
signal activate_result(result: Dictionary)
## 已连接后的 error 帧。
signal error_received(message: Dictionary)
## 服务端拒绝了本客户端的 event（stage 不属于当前 Stage）。
signal event_rejected(reason: String)

const INBOUND_BUFFER_BYTES := 8 * 1024 * 1024
const OUTBOUND_BUFFER_BYTES := 1024 * 1024
const MAX_QUEUED_PACKETS := 4096
const HANDSHAKE_TIMEOUT_MSEC := 30000
const DEFAULT_STAGE_ID := "vn:godot-main"
const DEFAULT_STAGE_KIND := "vn"
const DEFAULT_WS_PATH := "/ws"

const INITIAL_REGISTER_REQUEST_ID := "initial-register"
const INITIAL_ACTIVATE_REQUEST_ID := "initial-activate"

const PHASE_DISCONNECTED := "disconnected"
const PHASE_CONNECTING := "connecting"
const PHASE_HELLO_SENT := "hello_sent"
const PHASE_ACKED := "acked"
const PHASE_REGISTERED := "registered"
const PHASE_ACTIVE := "active"

## 最近一次关闭的 code / reason（4001 = clientId replaced by a new connection）。
var last_close_code := 0
var last_close_reason := ""

var _peer: WebSocketPeer = null
var _url := ""
var _client_id := ""
var _role := "assistant"
var _assistant_id := ""
var _name := ""
var _sprite_path := ""
var _stage_id := DEFAULT_STAGE_ID
var _stage_kind := DEFAULT_STAGE_KIND
var _active_stage_id := ""
var _commands: Array = []
var _environment: Dictionary = {}
var _stage_snapshot: Dictionary = {}
var _registered_stage_ids: Dictionary = {}
var _phase := PHASE_DISCONNECTED
var _hello_sent := false
var _acknowledged := false
var _failed := false
var _disconnect_reported := false
var _handshake_deadline := 0
var _request_seq := 0


# ============================================================
# 打开连接
# ============================================================

## demo 兼容签名：直连 ws(s)://host:port/ws。等价于 open_direct()。
func open(
	host: String,
	port: int,
	client_id: String,
	commands: Array,
	role: String = "assistant",
	assistant_id: String = "",
	display_name: String = "",
	sprite_path: String = "",
	stage_id: String = DEFAULT_STAGE_ID,
	stage_kind: String = DEFAULT_STAGE_KIND,
	environment: Dictionary = {},
	ws_path: String = DEFAULT_WS_PATH,
	use_tls: bool = false,
) -> void:
	open_direct(
		host, port, client_id, commands, role, assistant_id, display_name, sprite_path,
		stage_id, stage_kind, environment, ws_path, use_tls,
	)


## 直连模式：ws(s)://host:port/path（api_key 可选，仅用于旧版兼容，直连不校验）。
func open_direct(
	host: String,
	port: int,
	client_id: String,
	commands: Array = [],
	role: String = "assistant",
	assistant_id: String = "",
	display_name: String = "",
	sprite_path: String = "",
	stage_id: String = DEFAULT_STAGE_ID,
	stage_kind: String = DEFAULT_STAGE_KIND,
	environment: Dictionary = {},
	ws_path: String = DEFAULT_WS_PATH,
	use_tls: bool = false,
	api_key: String = "",
) -> void:
	var url := Discovery.direct_ws_url(host, port, ws_path, use_tls, api_key)
	open_url(url, client_id, commands, role, assistant_id, display_name, sprite_path,
		stage_id, stage_kind, environment)


## 网关模式：ws_url 由 StageChannelDiscovery.gateway_ws_url() 构造（含 ?api_key=）。
func open_gateway(
	ws_url: String,
	client_id: String,
	commands: Array = [],
	role: String = "assistant",
	assistant_id: String = "",
	display_name: String = "",
	sprite_path: String = "",
	stage_id: String = DEFAULT_STAGE_ID,
	stage_kind: String = DEFAULT_STAGE_KIND,
	environment: Dictionary = {},
) -> void:
	open_url(ws_url, client_id, commands, role, assistant_id, display_name, sprite_path,
		stage_id, stage_kind, environment)


## 底层入口：直接使用完整 ws(s) URL。
func open_url(
	url: String,
	client_id: String,
	commands: Array = [],
	role: String = "assistant",
	assistant_id: String = "",
	display_name: String = "",
	sprite_path: String = "",
	stage_id: String = DEFAULT_STAGE_ID,
	stage_kind: String = DEFAULT_STAGE_KIND,
	environment: Dictionary = {},
) -> void:
	_client_id = client_id.strip_edges()
	if _client_id.is_empty():
		# clientId 必须实例唯一；调用方没给时退化为随机值（跨重连需调用方自己保持稳定）。
		_client_id = "godot-%d" % Time.get_ticks_usec()
	_commands = commands.duplicate(true)
	_role = "user" if role == "user" else "assistant"
	_assistant_id = assistant_id
	_name = display_name
	_sprite_path = sprite_path
	var trimmed_stage_id := stage_id.strip_edges()
	_stage_id = trimmed_stage_id if not trimmed_stage_id.is_empty() else DEFAULT_STAGE_ID
	var trimmed_stage_kind := stage_kind.strip_edges()
	_stage_kind = trimmed_stage_kind if not trimmed_stage_kind.is_empty() else DEFAULT_STAGE_KIND
	_environment = environment.duplicate(true)
	_url = url.strip_edges()
	_reset_state()

	if _peer != null:
		_peer.close()
		_peer = null
	if _url.is_empty() or not (_url.begins_with("ws://") or _url.begins_with("wss://")):
		_failed = true
		_phase = PHASE_DISCONNECTED
		_emit_disconnected_once("invalid StageChannel url: " + _url, true)
		return
	_peer = make_peer()
	var error := _peer.connect_to_url(_url)
	if error != OK:
		_failed = true
		_phase = PHASE_DISCONNECTED
		_emit_disconnected_once(
			"WebSocket connect failed: %s (%d)" % [error_string(error), error], true
		)


## 构造配置了协议要求缓冲区的 WebSocketPeer（入站 ≥8MiB，出站 ≥1MiB）。
static func make_peer() -> WebSocketPeer:
	var peer := WebSocketPeer.new()
	peer.inbound_buffer_size = INBOUND_BUFFER_BYTES
	peer.outbound_buffer_size = OUTBOUND_BUFFER_BYTES
	peer.max_queued_packets = MAX_QUEUED_PACKETS
	return peer


func _reset_state() -> void:
	_phase = PHASE_CONNECTING
	_hello_sent = false
	_acknowledged = false
	_failed = false
	_disconnect_reported = false
	_handshake_deadline = Time.get_ticks_msec() + HANDSHAKE_TIMEOUT_MSEC
	last_close_code = 0
	last_close_reason = ""
	_active_stage_id = ""
	_stage_snapshot = {}
	_registered_stage_ids.clear()
	_request_seq = 0


# ============================================================
# 每帧轮询
# ============================================================

## 必须每帧调用：驱动 WebSocketPeer，发送 hello / 处理入站帧并检测握手超时。
func poll() -> void:
	if _failed or _phase == PHASE_DISCONNECTED:
		return
	if (
		not _acknowledged
		and _handshake_deadline > 0
		and Time.get_ticks_msec() > _handshake_deadline
	):
		_fail_handshake(
			"StageChannel handshake timed out after %d ms (phase=%s)"
			% [HANDSHAKE_TIMEOUT_MSEC, _phase]
		)
		return
	if _peer == null:
		return
	_peer.poll()
	match _peer.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			_on_open()
		WebSocketPeer.STATE_CLOSED:
			_handle_close(_peer.get_close_code(), _peer.get_close_reason())
		_:
			pass


func _on_open() -> void:
	if not _hello_sent:
		var hello := Protocol.hello(
			_client_id,
			_role,
			_assistant_id if _role == "assistant" else "",
			_name,
			_sprite_path,
			"godot",
		)
		_send(hello)
		_hello_sent = true
		_phase = PHASE_HELLO_SENT
	var pending := _peer.get_available_packet_count()
	while pending > 0:
		_handle(_peer.get_packet().get_string_from_utf8())
		if _failed:
			return
		pending -= 1
		# 服务端一帧可能触发更多入站帧，重新读取计数。
		pending = _peer.get_available_packet_count()


# ============================================================
# 入站帧
# ============================================================

## 处理一条 JSON 文本帧。公开以便无网络单测直接注入帧。
func _handle(text: String) -> void:
	var frame := Protocol.decode(text)
	if frame.is_empty():
		return
	_dispatch(frame)


func _dispatch(frame: Dictionary) -> void:
	# 与 StageChannelProtocol.TYPE_* 常量一一对应；未知 type 落到默认分支忽略。
	match Protocol.frame_type(frame):
		"hello_ack":
			_on_hello_ack(frame)
		"stage_register_result":
			_on_register_result(frame)
		"stage_activate_result", "stage_transition_result":
			_on_transition_result(frame)
		"command":
			_on_command(frame)
		"llm_event":
			_on_llm_event(frame)
		"error":
			_on_error(frame)
		"event_rejected":
			event_rejected.emit(String(frame.get("reason", "")))
		_:
			# 未知 type / 其它已知帧（chat_result、stage_unregister_result…）一律忽略。
			pass


func _on_hello_ack(frame: Dictionary) -> void:
	if _failed or _phase != PHASE_HELLO_SENT:
		return
	var channel := String(frame.get("channel", ""))
	if not channel.is_empty() and channel != Protocol.CHANNEL:
		_fail_handshake("hello_ack.channel is not \"stage\": " + channel)
		return
	_store_stage_snapshot(frame)
	_mark_hello_registrations(frame)
	_phase = PHASE_ACKED
	_send(Protocol.stage_register(
		_stage_id, _stage_kind, _environment, _commands, INITIAL_REGISTER_REQUEST_ID
	))


func _on_register_result(frame: Dictionary) -> void:
	var result := Protocol.result_object(frame)
	var kind := Protocol.register_result_kind(frame)
	_store_stage_snapshot(frame)
	var request_id := String(frame.get("requestId", ""))

	if _phase == PHASE_ACKED and request_id == INITIAL_REGISTER_REQUEST_ID:
		if Protocol.REGISTER_OK_KINDS.has(kind):
			_mark_registered(result)
			register_result.emit(result)
			if _role == Protocol.ROLE_ASSISTANT:
				_phase = PHASE_REGISTERED
				_send(Protocol.stage_activate(
					_stage_id, "", "", -1, INITIAL_ACTIVATE_REQUEST_ID
				))
			else:
				_finish_handshake()
		else:
			register_result.emit(result)
			_fail_handshake(
				"stage registration rejected: " + _rejected_reason(frame, "invalid reply")
			)
		return

	# 连接就绪后主动 register_stage() 的回执。
	if not kind.is_empty():
		if Protocol.REGISTER_OK_KINDS.has(kind):
			_mark_registered(result)
		register_result.emit(result)


func _on_transition_result(frame: Dictionary) -> void:
	var result := Protocol.result_object(frame)
	var kind := Protocol.transition_result_kind(frame)
	_store_stage_snapshot(frame)
	var request_id := String(frame.get("requestId", ""))

	if _phase == PHASE_REGISTERED and request_id == INITIAL_ACTIVATE_REQUEST_ID:
		if Protocol.TRANSITION_OK_KINDS.has(kind):
			_apply_active_stage(result)
			activate_result.emit(result)
			_finish_handshake()
		else:
			activate_result.emit(result)
			_fail_handshake(
				"stage activation rejected: " + _rejected_reason(frame, "invalid reply")
			)
		return

	if not kind.is_empty():
		_apply_active_stage(result)
		activate_result.emit(result)


func _on_command(frame: Dictionary) -> void:
	var payload := Protocol.command_payload(frame)
	var stage_id := String(frame.get("stageId", ""))
	if stage_id.is_empty():
		stage_id = _event_stage_id()
	if not _is_registered_stage(stage_id):
		send_result(
			String(payload.get("commandId", "")),
			false,
			null,
			"command stageId \"%s\" is not registered by this client" % stage_id,
		)
		return
	command_received.emit(payload)


func _on_llm_event(frame: Dictionary) -> void:
	var event := Protocol.llm_event_payload(frame)
	if not event.is_empty():
		llm_event_received.emit(event)


func _on_error(frame: Dictionary) -> void:
	var message := String(frame.get("error", "StageChannel error"))
	if not _acknowledged and _is_handshaking():
		_fail_handshake(message)
	else:
		error_received.emit(frame)


func _handle_close(code: int, reason: String) -> void:
	if _disconnect_reported:
		return
	last_close_code = code
	last_close_reason = reason
	_phase = PHASE_DISCONNECTED
	_acknowledged = false
	_handshake_deadline = 0
	var detail := "WebSocket closed (code=%d" % code
	var trimmed := reason.strip_edges()
	if not trimmed.is_empty():
		detail += ", reason=" + trimmed
	detail += ")"
	# 4001 == clientId replaced by a new connection；关闭原因必须透出给调用方。
	_emit_disconnected_once(detail)


# ============================================================
# 握手辅助
# ============================================================

func _finish_handshake() -> void:
	if _acknowledged or _failed:
		return
	_phase = PHASE_ACTIVE
	_acknowledged = true
	_handshake_deadline = 0
	connected.emit()


func _fail_handshake(reason: String) -> void:
	if _failed:
		return
	_failed = true
	_phase = PHASE_DISCONNECTED
	_acknowledged = false
	_handshake_deadline = 0
	if _peer != null:
		_peer.close()
	_emit_disconnected_once(reason)


func _emit_disconnected_once(reason: String, deferred: bool = false) -> void:
	if _disconnect_reported:
		return
	_disconnect_reported = true
	if deferred:
		disconnected.emit.call_deferred(reason)
	else:
		disconnected.emit(reason)


func _is_handshaking() -> bool:
	return _phase in [PHASE_CONNECTING, PHASE_HELLO_SENT, PHASE_ACKED, PHASE_REGISTERED]


func _store_stage_snapshot(frame: Dictionary) -> void:
	var snapshot := Protocol.stage_snapshot(frame)
	if not snapshot.is_empty():
		_stage_snapshot = snapshot.duplicate(true)


func _mark_hello_registrations(frame: Dictionary) -> void:
	var registrations: Variant = frame.get("registrations", [])
	if typeof(registrations) != TYPE_ARRAY:
		return
	for item: Variant in registrations:
		if typeof(item) != TYPE_DICTIONARY:
			continue
		var stage_id := String((item as Dictionary).get("stageId", ""))
		if not stage_id.is_empty():
			_registered_stage_ids[stage_id] = true


func _mark_registered(result: Dictionary) -> void:
	var registration: Variant = result.get("registration", {})
	var stage_id := ""
	if typeof(registration) == TYPE_DICTIONARY:
		stage_id = String((registration as Dictionary).get("stageId", ""))
	if stage_id.is_empty():
		stage_id = _stage_id
	_registered_stage_ids[stage_id] = true


func _apply_active_stage(result: Dictionary) -> void:
	var raw_stage: Variant = result.get("stage", {})
	if typeof(raw_stage) != TYPE_DICTIONARY:
		return
	var stage: Dictionary = raw_stage
	if stage.is_empty():
		return
	_stage_snapshot = stage.duplicate(true)
	var stage_id := String(stage.get("id", ""))
	if not stage_id.is_empty():
		_active_stage_id = stage_id


func _rejected_reason(frame: Dictionary, fallback: String) -> String:
	var reason := Protocol.rejected_reason(frame)
	return reason if not reason.is_empty() else fallback


func _event_stage_id() -> String:
	return _active_stage_id if not _active_stage_id.is_empty() else _stage_id


func _is_registered_stage(stage_id: String) -> bool:
	if stage_id.is_empty():
		return false
	return _registered_stage_ids.has(stage_id) or stage_id == _stage_id


func _next_request_id(prefix: String) -> String:
	_request_seq += 1
	return "%s-%d" % [prefix, _request_seq]


# ============================================================
# 出站 API
# ============================================================

## 关闭连接（会由 poll() 收到 CLOSED 后发 disconnected(reason)）。
func close() -> void:
	_handshake_deadline = 0
	if _peer != null:
		_peer.close()


## 给某条 command 回执。
func send_result(command_id: String, ok: bool, result: Variant, error: String = "") -> void:
	_send(Protocol.command_result_frame(command_id, ok, result, error))


## 上报一条场景/用户事件；stageId 使用当前激活 Stage（无激活时用注册 Stage）。
func send_event(event: Dictionary) -> void:
	_send(Protocol.event_frame(_event_stage_id(), event))


## 主动注册（或更新）一个 Stage；连接准备好后也可用于补充注册。
func register_stage(
	stage_id: String = "",
	stage_kind: String = "",
	environment: Dictionary = {},
	commands: Array = [],
	request_id: String = "",
) -> void:
	var target_stage_id := stage_id if not stage_id.is_empty() else _stage_id
	var target_stage_kind := stage_kind if not stage_kind.is_empty() else _stage_kind
	var target_environment := environment if not environment.is_empty() else _environment
	var target_commands := commands if not commands.is_empty() else _commands
	var target_request_id := request_id
	if target_request_id.is_empty():
		target_request_id = _next_request_id("register")
	_send(Protocol.stage_register(
		target_stage_id, target_stage_kind, target_environment, target_commands,
		target_request_id,
	))


## 激活 Stage（默认 stageId 为本客户端注册的 Stage）。
func activate_stage(
	stage_id: String = "",
	mode: String = "",
	expected_stage_id: String = "",
	expected_revision: int = -1,
	request_id: String = "",
) -> void:
	var target_stage_id := stage_id if not stage_id.is_empty() else _stage_id
	var target_request_id := request_id
	if target_request_id.is_empty():
		target_request_id = _next_request_id("activate")
	_send(Protocol.stage_activate(
		target_stage_id, mode, expected_stage_id, expected_revision, target_request_id
	))


## 切换到默认（empty）环境。
func transition_to_empty(
	stage_id: String = "",
	mode: String = "",
	expected_stage_id: String = "",
	expected_revision: int = -1,
	request_id: String = "",
) -> void:
	var target_stage_id := stage_id if not stage_id.is_empty() else _event_stage_id()
	var target_request_id := request_id
	if target_request_id.is_empty():
		target_request_id = _next_request_id("transition")
	_send(Protocol.stage_transition(
		target_stage_id, "empty", mode, expected_stage_id, expected_revision,
		target_request_id,
	))


func _send(frame: Dictionary) -> void:
	if _peer == null:
		return
	_peer.send_text(Protocol.encode(frame))


# ============================================================
# 只读访问器
# ============================================================

func get_url() -> String:
	return _url


func get_client_id() -> String:
	return _client_id


func get_phase() -> String:
	return _phase


func is_ready() -> bool:
	return _acknowledged and _phase == PHASE_ACTIVE


func get_stage_snapshot() -> Dictionary:
	return _stage_snapshot.duplicate(true)


func get_active_stage_id() -> String:
	return _event_stage_id()


func get_registered_stage_ids() -> Array:
	return _registered_stage_ids.keys()
