extends Node
class_name VnClientManager
## 多 ws 管理器。
##
## 持有 N 个 StageChannelClient（每个对应一个 assistant 进程），加一个用户连接。
## 职责：
##   - 入站：把 ws 收到的 command / llm_event 翻译到 SceneEventBus 信号，让 main.gd 处理
##   - 出站：把玩家互动 / 玩家打字 / 助手间转发路由到正确的 ws
##
## 路由在 Godot 端做：StageChannelClient 只负责协议；本对象实现 VN StageBridge。
## 本 manager 是 Godot 内置的「场景服务器」：所有场景里助手之间的关系由它决定。
##
## 回喂控制（事件发给谁 / 广播 / 不回喂自己）也在这里：所有场景事件统一用 broadcast_event /
## send_event_to 出站。助手自己说的话 / 自己的操作，由调用方传 exclude_id 排除，不回喂给自己。
##
## say / say_to 是「指令」（在 SUPPORTED_COMMANDS 里，Godot 端解析执行），不是服务端工具。
## 助手调用 say 时，main.gd 渲染气泡后，用 broadcast_event(exclude=说话者) 或 send_event_to
## 把「assistant_said」事件转发给其他助手 ws，让对应 CurrentStage 接收事件。

const StageChannelClientScript = preload("res://addons/stage_channel_sdk/stage_channel_client.gd")

## 当前 SceneEventBus（main.gd 注入）。所有入站事件最终都从这里 emit。
var event_bus: SceneEventBus

## assistantId -> StageChannelClient（每个助手一个独立进程/独立 StageChannel）
var _clients: Dictionary = {}
## 玩家自己的「私人通道」ws（实例级 clientId，role="user"）
var _user_ws: StageChannelClient = null

## 服务器 host（决定 ws 目标地址）
var _host: String = ""
var _port: int = 0
## 同一个 Godot 场景中的所有连接使用同一个 Stage ID。
var _stage_id: String = "vn:godot-main"
var _stage_kind: String = "vn"
## Transport identity for this running Godot instance. It must not be the semantic
## assistantId: StageChannel uses clientId as an exclusive WebSocket map key.
var _instance_client_id: String = ""


func setup(host: String, port: int, bus: SceneEventBus, stage_id: String = "", stage_kind: String = "", instance_client_id: String = "") -> void:
	_host = host
	_port = port
	event_bus = bus
	if not stage_id.is_empty():
		_stage_id = stage_id
	if not stage_kind.is_empty():
		_stage_kind = stage_kind
	_instance_client_id = instance_client_id.strip_edges()
	if _instance_client_id.is_empty():
		_instance_client_id = "godot-%s-%d-%d" % [
			_stage_id.validate_filename(), OS.get_process_id(), get_instance_id(),
		]


func poll() -> void:
	for c in _clients.values():
		if c != null: c.poll()
	if _user_ws != null:
		_user_ws.poll()


# ══════════════════════════════════════════════════════════════
#  连接管理
# ══════════════════════════════════════════════════════════════

## 给某个 assistant 进程开一个 ws。
## meta = {assistantId, name, spritePath, commands (Array[Dict])}
## commands 是这个 ws 上报的指令清单（Godot 端维护的 JSON Schema 风格 spec）。
func connect_assistant(meta: Dictionary) -> StageChannelClient:
	var assistant_id := String(meta.get("assistantId", ""))
	if assistant_id.is_empty():
		push_warning("[VnClientManager] connect_assistant: assistantId 为空，跳过")
		return null
	if _clients.has(assistant_id):
		# 已存在则先断开旧的（同一助手可能换了进程）
		var old: StageChannelClient = _clients[assistant_id]
		_clients.erase(assistant_id)
		if old != null:
			old.close()
			old.queue_free()
		if event_bus != null:
			event_bus.dispatch_assistant_left(assistant_id)

	# 每个助手是独立进程、独立端口：用 meta 里的 host/port 连它自己的 ws；
	# 没给（老调用）才退回 setup 的共享 host/port。
	var host := String(meta.get("host", ""))
	var port := int(meta.get("port", 0))
	if host.is_empty() or port <= 0:
		host = _host
		port = _port

	var c := StageChannelClientScript.new()
	add_child(c)
	var joined_meta := {
		"assistantId": assistant_id,
		"name": String(meta.get("name", "")),
		"spritePath": String(meta.get("spritePath", "")),
	}
	c.connected.connect(func():
		if event_bus != null:
			event_bus.dispatch_assistant_joined(joined_meta)
	)
	c.command_received.connect(_on_command.bind(assistant_id))
	c.llm_event_received.connect(_on_llm_event.bind(assistant_id))
	c.disconnected.connect(_on_ws_disconnected.bind(assistant_id, c))
	_clients[assistant_id] = c
	c.open(
		host, port,
		_transport_client_id("assistant", assistant_id),
		meta.get("commands", []),
		"assistant",
		assistant_id,
		String(meta.get("name", "")),
		String(meta.get("spritePath", "")),
		_stage_id,
		_stage_kind,
		meta.get("environment", {}),
		String(meta.get("wsPath", "/ws")),
		bool(meta.get("secure", false)),
	)
	return c


## 关掉某个助手 ws
func disconnect_assistant(assistant_id: String) -> void:
	if not _clients.has(assistant_id):
		return
	var c: StageChannelClient = _clients[assistant_id]
	_clients.erase(assistant_id)
	if c != null:
		c.close()
		c.queue_free()
	if event_bus != null:
		event_bus.dispatch_assistant_left(assistant_id)


## 打开玩家的「私人通道」ws。user_commands 是这个 ws 上报的指令（通常是空）。
func open_user_ws(commands: Array = []) -> StageChannelClient:
	if _user_ws != null:
		_user_ws.close()
		_user_ws.queue_free()
	var c := StageChannelClientScript.new()
	add_child(c)
	c.command_received.connect(_on_command.bind("user"))
	c.llm_event_received.connect(_on_llm_event.bind("user"))
	c.disconnected.connect(_on_ws_disconnected.bind("user", c))
	_user_ws = c
	c.open(_host, _port, _transport_client_id("user", "user"), commands, "user", "", "", "", _stage_id, _stage_kind, {}, "/ws")
	return c


func has_assistant(assistant_id: String) -> bool:
	return _clients.has(assistant_id)


func list_assistants() -> Array:
	return _clients.keys()


func get_client(assistant_id: String) -> StageChannelClient:
	return _clients.get(assistant_id, null)


func user_ws() -> StageChannelClient:
	return _user_ws


# ══════════════════════════════════════════════════════════════
#  出站路由（回喂控制在这里 —— 决定事件发给谁）
# ══════════════════════════════════════════════════════════════

## 广播一条场景事件给所有 assistant ws。
## exclude_id 非空 = 跳过某个助手（助手自己说的话/自己的操作，不回喂给自己）。
func broadcast_event(event: Dictionary, exclude_id: String = "") -> void:
	for aid in _clients.keys():
		if aid == exclude_id:
			continue
		var c: StageChannelClient = _clients[aid]
		if c != null:
			c.send_event(event)


## 定向发一条场景事件给某个 assistant ws。目标不存在则静默忽略。
func send_event_to(assistant_id: String, event: Dictionary) -> void:
	if assistant_id.is_empty():
		return
	var c: StageChannelClient = _clients.get(assistant_id, null)
	if c != null:
		c.send_event(event)


# ══════════════════════════════════════════════════════════════
#  入站处理（ws → EventBus）
# ══════════════════════════════════════════════════════════════

func _on_command(cmd: Dictionary, from_ws_id: String) -> void:
	if event_bus != null:
		# 把 from_ws_id 塞进 cmd 让 main.gd 知道是谁发的指令
		var enriched := cmd.duplicate()
		enriched["fromWsId"] = from_ws_id
		event_bus.dispatch_command(enriched)


func _on_llm_event(ev: Dictionary, from_ws_id: String) -> void:
	if event_bus != null:
		event_bus.dispatch_llm_event(ev, from_ws_id)


func _on_ws_disconnected(_reason: String, from_ws_id: String, source: StageChannelClient = null) -> void:
	_client_disconnect(from_ws_id, source)


func _client_disconnect(from_ws_id: String, source: StageChannelClient = null) -> void:
	if from_ws_id == "user":
		if source != null and _user_ws != source:
			return
		if _user_ws != null:
			_user_ws.queue_free()
			_user_ws = null
		if event_bus != null:
			event_bus.dispatch_assistant_left("user")
		return
	if _clients.has(from_ws_id):
		var c: StageChannelClient = _clients[from_ws_id]
		if source != null and c != source:
			return
		_clients.erase(from_ws_id)
		if c != null:
			c.queue_free()
		if event_bus != null:
			event_bus.dispatch_assistant_left(from_ws_id)


func _transport_client_id(role: String, participant_id: String) -> String:
	if _instance_client_id.is_empty():
		_instance_client_id = "godot-%s-%d-%d" % [
			_stage_id.validate_filename(), OS.get_process_id(), get_instance_id(),
		]
	return "%s:%s:%s" % [_instance_client_id, role, participant_id]
