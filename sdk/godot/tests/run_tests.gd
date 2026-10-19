extends Node
## StageChannel Godot SDK 无网络单元测试。
##
## 跑法（在仓库根目录）：
##   "$HOME/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot" \
##       --headless --path sdk/godot res://tests/run_tests.tscn
##
## 覆盖：
##   · sdk/spec/fixtures 全部 server_to_client 帧的解析 / 校验；
##   · 全部 client_to_server 帧由 StageChannelProtocol 构造后与样例逐字段等价；
##   · 未知 type / 未知字段 / 非法 JSON 的容忍；
##   · hello → hello_ack → stage_register → stage_activate 状态机（role=user 跳过激活）；
##   · 30s 握手超时、4001 关闭原因透出、command stageId 路由、llm_event 派发；
##   · StageChannelDiscovery 的网关/直连 URL 构造与 online+stage 过滤。
##
## fixtures 位于项目目录外，默认按 <res://>/../spec/fixtures 查找；
## 也可用环境变量 STAGE_CHANNEL_FIXTURES=/abs/path/to/spec/fixtures 覆盖。

const Protocol := preload("res://addons/stage_channel_sdk/stage_channel_protocol.gd")
const ClientScript := preload("res://addons/stage_channel_sdk/stage_channel_client.gd")
const DiscoveryScript := preload("res://addons/stage_channel_sdk/stage_channel_discovery.gd")
const RecordingClient := preload("res://tests/recording_client.gd")

const FIXTURES_ENV := "STAGE_CHANNEL_FIXTURES"

var _pass := 0
var _fail := 0
var _fixtures_dir := ""
var _manifest_cache: Dictionary = {}


func _ready() -> void:
	print("\n════ StageChannel Godot SDK tests ════")
	_fixtures_dir = _resolve_fixtures_dir()
	print("fixtures: ", _fixtures_dir)
	print("")

	_test_protocol_builders()
	_test_protocol_tolerance()
	_test_fixtures_manifest()
	_test_server_fixtures_parse()
	_test_client_fixtures_construct()
	_test_discovery_urls()
	_test_discovery_filtering()
	_test_client_peer_buffers()
	_test_handshake_assistant()
	_test_handshake_user()
	_test_handshake_rejections()
	_test_handshake_timeout()
	_test_hello_ack_channel_mismatch()
	_test_close_reasons()
	_test_command_routing()
	_test_llm_event_and_unknown_frames()
	_test_outbound_frames()
	_test_client_urls()

	print("\n════ %d passed / %d failed ════\n" % [_pass, _fail])
	get_tree().quit(0 if _fail == 0 else 1)


# ============================================================
# 断言 / 通用辅助
# ============================================================

func _check(label: String, condition: bool) -> void:
	if condition:
		_pass += 1
		print("  PASS  ", label)
	else:
		_fail += 1
		print("  FAIL  ", label)


func _resolve_fixtures_dir() -> String:
	var override := OS.get_environment(FIXTURES_ENV).strip_edges()
	if not override.is_empty():
		return override
	var project_dir := ProjectSettings.globalize_path("res://")
	var candidates := [
		project_dir.path_join("../spec/fixtures").simplify_path(),
		project_dir.path_join("../../sdk/spec/fixtures").simplify_path(),
	]
	for candidate: String in candidates:
		if FileAccess.file_exists(candidate.path_join("manifest.json")):
			return candidate
	return candidates[0]


func _load_json(path: String) -> Dictionary:
	var text := FileAccess.get_file_as_string(path)
	if text.is_empty():
		return {}
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		return {}
	var frame: Dictionary = parsed
	return frame


func _load_fixture(file_name: String) -> Dictionary:
	return _load_json(_fixtures_dir.path_join(file_name))


func _manifest() -> Dictionary:
	if not _manifest_cache.is_empty():
		return _manifest_cache
	_manifest_cache = _load_json(_fixtures_dir.path_join("manifest.json"))
	return _manifest_cache


func _fixture_entries() -> Array:
	var fixtures: Variant = _manifest().get("fixtures", [])
	return fixtures if typeof(fixtures) == TYPE_ARRAY else []


func _dict_value(value: Variant) -> Dictionary:
	return value if typeof(value) == TYPE_DICTIONARY else {}


func _array_value(value: Variant) -> Array:
	return value if typeof(value) == TYPE_ARRAY else []


func _new_client(
	role: String = "assistant",
	stage_id: String = "town:meadow",
	stage_kind: String = "town",
) -> Node:
	var client = RecordingClient.new()
	client._client_id = "godot-1"
	client._role = role
	client._stage_id = stage_id
	client._stage_kind = stage_kind
	client._environment = {"text": "萤火镇"}
	client._commands = [{"name": "say"}]
	client._phase = ClientScript.PHASE_HELLO_SENT
	client._hello_sent = true
	client._handshake_deadline = Time.get_ticks_msec() + ClientScript.HANDSHAKE_TIMEOUT_MSEC
	return client


func _snapshot(id: String, kind: String, revision: int, status: String, capabilities: Array) -> Dictionary:
	return {
		"id": id,
		"kind": kind,
		"revision": revision,
		"status": status,
		"participants": [],
		"capabilities": capabilities,
	}


func _hello_ack_frame() -> Dictionary:
	return {
		"type": "hello_ack",
		"channel": "stage",
		"clientId": "godot-1",
		"bridgeId": "stage:godot-1:town:meadow",
		"registrations": [],
		"stage": _snapshot("empty", "empty", 0, "empty", []),
	}


func _register_result_frame(request_id: String, kind: String, reason: String = "") -> Dictionary:
	var result := {"kind": kind}
	if kind == "rejected":
		result["reason"] = reason
	else:
		result["registration"] = {
			"id": "stage:godot-1:town:meadow",
			"stageId": "town:meadow",
			"stageKind": "town",
			"environment": {"text": "萤火镇"},
			"capabilities": [{"name": "say"}],
		}
	return {
		"type": "stage_register_result",
		"requestId": request_id,
		"result": result,
		"stage": _snapshot("empty", "empty", 0, "empty", []),
	}


func _activate_result_frame(
	request_id: String, kind: String, stage_id: String = "town:meadow", reason: String = ""
) -> Dictionary:
	var result := {"kind": kind}
	if kind == "rejected":
		result["reason"] = reason
	else:
		result["stage"] = _snapshot(stage_id, "town", 1, "active", [{"name": "say"}])
	return {"type": "stage_activate_result", "requestId": request_id, "result": result}


func _command_frame(
	command_id: String,
	stage_id: String,
	command: String = "say",
	args: Variant = {"text": "你好"},
) -> Dictionary:
	return {
		"type": "command",
		"commandId": command_id,
		"bridgeId": "stage:godot-1:town:meadow",
		"stageId": stage_id,
		"command": command,
		"args": args,
	}


func _simulate_connected(client: Node) -> void:
	client._handle(Protocol.encode(_hello_ack_frame()))
	client._handle(Protocol.encode(
		_register_result_frame(ClientScript.INITIAL_REGISTER_REQUEST_ID, "registered")
	))
	if String(client._role) == "assistant":
		client._handle(Protocol.encode(
			_activate_result_frame(ClientScript.INITIAL_ACTIVATE_REQUEST_ID, "changed")
		))


# ============================================================
# 协议层
# ============================================================

func _test_protocol_builders() -> void:
	var hello := Protocol.hello("godot-1")
	_check("hello 最小帧只有 type/channel/clientId", hello.size() == 3)
	_check("hello 带可选字段", Protocol.hello(
		"godot-1", "assistant", "assistant-1", "编码助手", "/sprite.png", "godot",
		"town:meadow", "town", {"text": "萤火镇"}, [{"name": "say"}], true,
	).get("activateStage") == true)

	var activate := Protocol.stage_activate("town:meadow", "after-turn", "empty", 0, "a1")
	_check("stage_activate 保留 expectedRevision=0",
		activate.has("expectedRevision") and int(activate["expectedRevision"]) == 0)
	var activate_default := Protocol.stage_activate("town:meadow")
	_check("stage_activate 默认不带乐观并发字段",
		not activate_default.has("expectedRevision") and not activate_default.has("mode"))

	var transition := Protocol.transition_to_empty("town:meadow")
	_check("transition_to_empty 带 target=empty",
		String(transition.get("target", "")) == "empty" and transition.get("type") == "stage_transition")

	var result := Protocol.command_result_frame("cmd-1", false, null, "")
	_check("command_result ok=false / 省略空 error", result.get("ok") == false and not result.has("error"))
	_check("command_result 非空 error 会保留", Protocol.command_result_frame("c", true, {}, "boom").get("error") == "boom")

	_check("equivalent 字段顺序无关", Protocol.equivalent(
		{"a": 1, "b": {"c": [1, 2]}}, {"b": {"c": [1.0, 2.0]}, "a": 1.0}
	))
	_check("equivalent 能识别差异", not Protocol.equivalent({"a": 1}, {"a": 2}))
	_check("equivalent 能识别字段缺失", not Protocol.equivalent({"a": 1, "b": 2}, {"a": 1}))

	_check("validate_client_frame 接受 hello fixture",
		Protocol.validate_client_frame(_load_fixture("hello.client.json")).is_empty())
	_check("validate_client_frame 拒绝缺 clientId 的 hello",
		not Protocol.validate_client_frame({"type": "hello", "channel": "stage"}).is_empty())
	_check("validate_server_frame 拒绝非 stage hello_ack",
		not Protocol.validate_server_frame({"type": "hello_ack", "channel": "http"}).is_empty())
	_check("validate_server_frame 拒绝缺 args 的 command",
		not Protocol.validate_server_frame({
			"type": "command", "commandId": "c", "bridgeId": "b", "stageId": "s", "command": "say",
		}).is_empty())


func _test_protocol_tolerance() -> void:
	# 注意：Godot 的 JSON.parse_string 在解析失败时会向 stderr 打一条 ERROR，属预期噪声。
	_check("非法 JSON 解码为空", Protocol.decode("not json").is_empty())
	_check("非对象 JSON 解码为空", Protocol.decode("[1,2,3]").is_empty())

	var future := Protocol.decode('{"type":"future_frame","payload":{"x":1}}')
	_check("未知 type 仍可解析", future.get("type") == "future_frame")
	_check("未知 type 不视为已知", not Protocol.is_known_type(Protocol.frame_type(future)))
	_check("未知 type 校验保持容忍", Protocol.validate_server_frame(future).is_empty())

	var extended := Protocol.decode(
		'{"type":"command","commandId":"c1","bridgeId":"b","stageId":"s",'
		+ '"command":"say","args":{},"futureField":true}'
	)
	_check("未知字段原样保留", extended.get("futureField") == true)

	var bytes := JSON.stringify({"type": "error", "error": "boom"}).to_utf8_buffer()
	_check("decode_bytes 可解码二进制帧", Protocol.frame_type(Protocol.decode_bytes(bytes)) == "error")

	var encoded := Protocol.encode({"type": "event", "stageId": "s", "event": {"kind": "x"}})
	_check("encode → decode 往返等价",
		Protocol.equivalent(Protocol.decode(encoded), {"type": "event", "stageId": "s", "event": {"kind": "x"}}))


# ============================================================
# Fixtures 一致性
# ============================================================

func _test_fixtures_manifest() -> void:
	var manifest_path := _fixtures_dir.path_join("manifest.json")
	_check("fixtures manifest 存在: " + manifest_path, FileAccess.file_exists(manifest_path))
	if not FileAccess.file_exists(manifest_path):
		return
	var manifest := _manifest()
	_check("manifest.version = 1", int(manifest.get("version", 0)) == 1)
	var entries := _fixture_entries()
	_check("manifest.fixtures 非空", not entries.is_empty())

	for entry: Variant in entries:
		_check("manifest 条目是对象", typeof(entry) == TYPE_DICTIONARY)
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		var item: Dictionary = entry
		var file_name := String(item.get("file", ""))
		var direction := String(item.get("direction", ""))
		var type_name := String(item.get("type", ""))
		_check("fixture 文件存在: " + file_name, FileAccess.file_exists(_fixtures_dir.path_join(file_name)))
		_check("fixture 方向合法: " + file_name,
			direction == "client_to_server" or direction == "server_to_client")
		var frame := _load_fixture(file_name)
		_check("fixture 可解析且 type 一致: " + file_name,
			not frame.is_empty() and Protocol.frame_type(frame) == type_name)


func _test_server_fixtures_parse() -> void:
	var entries := _fixture_entries()
	if entries.is_empty():
		_check("server_to_client fixtures 可读", false)
		return
	var expected := 0
	var seen := 0
	for entry: Variant in entries:
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		if String((entry as Dictionary).get("direction", "")) != "server_to_client":
			continue
		expected += 1
	for entry: Variant in entries:
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		var item: Dictionary = entry
		if String(item.get("direction", "")) != "server_to_client":
			continue
		seen += 1
		var file_name := String(item.get("file", ""))
		var frame := _load_fixture(file_name)
		if frame.is_empty():
			_check("解析 server 帧: " + file_name, false)
			continue
		var error := Protocol.validate_server_frame(frame)
		_check("server 帧校验通过 (%s)%s" % [file_name, "" if error.is_empty() else ": " + error], error.is_empty())
		_check_server_fixture_fields(file_name, frame)
	_check("覆盖全部 server_to_client fixtures (%d)" % expected, seen == expected and seen > 0)


func _check_server_fixture_fields(file_name: String, frame: Dictionary) -> void:
	match Protocol.frame_type(frame):
		"hello_ack":
			var stage := Protocol.stage_snapshot(frame)
			_check("hello_ack.channel = stage (%s)" % file_name, frame.get("channel") == "stage")
			_check("hello_ack.clientId 非空 (%s)" % file_name, not String(frame.get("clientId", "")).is_empty())
			_check("hello_ack.stage.status = empty (%s)" % file_name, stage.get("status") == "empty")
		"stage_register_result":
			_check("register_result.kind = registered (%s)" % file_name,
				Protocol.register_result_kind(frame) == "registered")
			_check("register_result.registration.stageId (%s)" % file_name,
				String(Protocol.result_object(frame).get("registration", {}).get("stageId", "")) == "town:meadow")
		"stage_activate_result":
			# TransitionResult 的 stage 嵌在 result 里：{kind, stage}。
			var stage := Protocol.stage_snapshot(Protocol.result_object(frame))
			_check("activate_result.kind = changed (%s)" % file_name,
				Protocol.transition_result_kind(frame) == "changed")
			_check("activate_result.result.stage.status = active (%s)" % file_name, stage.get("status") == "active")
			_check("activate_result.result.stage.revision = 1 (%s)" % file_name, int(stage.get("revision", -1)) == 1)
		"command":
			var payload := Protocol.command_payload(frame)
			_check("command.stageId = town:meadow (%s)" % file_name, frame.get("stageId") == "town:meadow")
			_check("command payload 完整 (%s)" % file_name,
				payload.get("command") == "say" and _dict_value(payload.get("args", {})).get("text") == "你好")
		"llm_event":
			var event := Protocol.llm_event_payload(frame)
			_check("llm_event.event.type = assistant_message (%s)" % file_name,
				event.get("type") == "assistant_message")
			_check("llm_event.event.data 非空 (%s)" % file_name,
				typeof(event.get("data", null)) == TYPE_DICTIONARY)
		"error":
			_check("error.error 非空 (%s)" % file_name, not String(frame.get("error", "")).is_empty())
			_check("error.requestId = r2 (%s)" % file_name, frame.get("requestId") == "r2")
		_:
			pass


func _test_client_fixtures_construct() -> void:
	var entries := _fixture_entries()
	if entries.is_empty():
		_check("client_to_server fixtures 可读", false)
		return
	var expected := 0
	var seen := 0
	for entry: Variant in entries:
		if typeof(entry) == TYPE_DICTIONARY and String((entry as Dictionary).get("direction", "")) == "client_to_server":
			expected += 1
	for entry: Variant in entries:
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		var item: Dictionary = entry
		if String(item.get("direction", "")) != "client_to_server":
			continue
		seen += 1
		var file_name := String(item.get("file", ""))
		var frame := _load_fixture(file_name)
		if frame.is_empty():
			_check("解析 client 帧: " + file_name, false)
			continue
		var built := _build_client_frame(frame)
		_check("构造帧非空: " + file_name, not built.is_empty())
		_check("构造帧与样例等价: " + file_name, Protocol.equivalent(built, frame))
		var error := Protocol.validate_client_frame(built)
		_check("构造帧自校验通过 (%s)%s" % [file_name, "" if error.is_empty() else ": " + error], error.is_empty())
	_check("覆盖全部 client_to_server fixtures (%d)" % expected, seen == expected and seen > 0)


func _build_client_frame(frame: Dictionary) -> Dictionary:
	match Protocol.frame_type(frame):
		"hello":
			return Protocol.hello(
				String(frame.get("clientId", "")),
				String(frame.get("role", "")),
				String(frame.get("assistantId", "")),
				String(frame.get("name", "")),
				String(frame.get("spritePath", "")),
				String(frame.get("clientType", "")),
				String(frame.get("stageId", "")),
				String(frame.get("stageKind", "")),
				_dict_value(frame.get("environment", {})),
				_array_value(frame.get("commands", [])),
				bool(frame.get("activateStage", false)),
			)
		"stage_register":
			var stage := _dict_value(frame.get("stage", {}))
			return Protocol.stage_register(
				String(stage.get("id", "")),
				String(stage.get("kind", "")),
				_dict_value(stage.get("environment", {})),
				_array_value(stage.get("commands", [])),
				String(frame.get("requestId", "")),
			)
		"stage_activate":
			return Protocol.stage_activate(
				String(frame.get("stageId", "")),
				String(frame.get("mode", "")),
				String(frame.get("expectedStageId", "")),
				int(frame.get("expectedRevision", -1)),
				String(frame.get("requestId", "")),
			)
		"stage_transition":
			return Protocol.stage_transition(
				String(frame.get("stageId", "")),
				String(frame.get("target", "")),
				String(frame.get("mode", "")),
				String(frame.get("expectedStageId", "")),
				int(frame.get("expectedRevision", -1)),
				String(frame.get("requestId", "")),
			)
		"command_result":
			return Protocol.command_result_frame(
				String(frame.get("commandId", "")),
				bool(frame.get("ok", false)),
				frame.get("result", null),
				String(frame.get("error", "")),
			)
		"event":
			return Protocol.event_frame(
				String(frame.get("stageId", "")),
				_dict_value(frame.get("event", {})),
			)
		_:
			return {}


# ============================================================
# Discovery
# ============================================================

func _test_discovery_urls() -> void:
	_check("assistants_url 处理尾部斜杠",
		DiscoveryScript.assistants_url("http://127.0.0.1:3000/") == "http://127.0.0.1:3000/api/assistants")
	_check("assistants_url 保留反向代理前缀",
		DiscoveryScript.assistants_url("http://127.0.0.1:3000/console")
		== "http://127.0.0.1:3000/console/api/assistants")

	_check("gateway_ws_url http → ws",
		DiscoveryScript.gateway_ws_url("http://127.0.0.1:3000", "/a/assistant-1/ws", "key")
		== "ws://127.0.0.1:3000/a/assistant-1/ws?api_key=key")
	_check("gateway_ws_url https → wss",
		DiscoveryScript.gateway_ws_url("https://console.example.com", "/a/assistant-1/ws", "key")
		== "wss://console.example.com/a/assistant-1/ws?api_key=key")
	_check("gateway_ws_url 保留 Console 路径前缀",
		DiscoveryScript.gateway_ws_url("https://console.example.com/console/", "/a/assistant-1/ws", "key")
		== "wss://console.example.com/console/a/assistant-1/ws?api_key=key")
	_check("gateway_ws_url 支持 IPv6 Console",
		DiscoveryScript.gateway_ws_url("https://[::1]:3443/console", "/a/assistant-1/ws", "key")
		== "wss://[::1]:3443/console/a/assistant-1/ws?api_key=key")
	_check("gateway_ws_url 空 api_key 不带 query",
		DiscoveryScript.gateway_ws_url("https://console.example.com", "/a/assistant-1/ws")
		== "wss://console.example.com/a/assistant-1/ws")
	_check("gateway_ws_url 对 api_key 做 URL 编码",
		DiscoveryScript.gateway_ws_url("http://127.0.0.1:3000", "/a/x/ws", "test key")
		== "ws://127.0.0.1:3000/a/x/ws?api_key=test%20key")
	_check("gateway_ws_url 补全缺失的前导斜杠",
		DiscoveryScript.gateway_ws_url("http://127.0.0.1:3000", "a/x/ws", "")
		== "ws://127.0.0.1:3000/a/x/ws")

	_check("direct_ws_url 默认 /ws",
		DiscoveryScript.direct_ws_url("127.0.0.1", 41232) == "ws://127.0.0.1:41232/ws")
	_check("direct_ws_url TLS + 自定义 path",
		DiscoveryScript.direct_ws_url("127.0.0.1", 41232, "/stage", true)
		== "wss://127.0.0.1:41232/stage")
	_check("direct_ws_url IPv6 加方括号",
		DiscoveryScript.direct_ws_url("::1", 8080) == "ws://[::1]:8080/ws")
	_check("direct_ws_url 带 api_key",
		DiscoveryScript.direct_ws_url("127.0.0.1", 41232, "/ws", false, "k")
		== "ws://127.0.0.1:41232/ws?api_key=k")

	_check("gateway_ws_path 优先 gatewayWsPath",
		DiscoveryScript.gateway_ws_path({"gatewayWsPath": "/a/x/ws", "gatewayBase": "/a/x"}) == "/a/x/ws")
	_check("gateway_ws_path 回退 gatewayBase + /ws",
		DiscoveryScript.gateway_ws_path({"gatewayBase": "/a/x/"}) == "/a/x/ws")
	_check("gateway_ws_path 缺失时为空",
		DiscoveryScript.gateway_ws_path({"sessionId": "s"}).is_empty())
	_check("normalize_ws_path 空值回退 /ws", DiscoveryScript.normalize_ws_path("") == "/ws")


func _test_discovery_filtering() -> void:
	var info_gateway := {
		"sessionId": "assistant-a",
		"status": "online",
		"channels": ["http", "stage"],
		"gatewayBase": "/a/assistant-a",
		"gatewayWsPath": "/a/assistant-a/ws",
	}
	var info_direct := {
		"sessionId": "assistant-d",
		"status": "online",
		"channels": ["http"],
		"channelEndpoints": [
			{"id": "http", "protocol": "http", "host": "127.0.0.1", "port": 41231, "path": "/api/message"},
			{"id": "stage", "protocol": "ws", "host": "127.0.0.1", "port": 41232, "path": "/ws"},
		],
	}
	var sample := [
		info_gateway,
		{"sessionId": "assistant-b", "status": "offline", "channels": ["stage"]},
		{"sessionId": "assistant-c", "status": "online", "channels": ["http"]},
		info_direct,
		{"sessionId": "assistant-e", "status": "online", "channels": ["stage"], "channelEndpoints": []},
		"not-a-dict",
	]
	var filtered := DiscoveryScript.online_stage_assistants(sample)
	_check("过滤 online + stage：只保留两个", filtered.size() == 2)
	var ids: Array = []
	for item: Variant in filtered:
		if typeof(item) == TYPE_DICTIONARY:
			ids.append(String((item as Dictionary).get("sessionId", "")))
	_check("过滤保留 gateway 与 endpoint 元数据助手", ids.has("assistant-a") and ids.has("assistant-d"))
	_check("过滤丢掉了 offline / 仅 http / 空元数据 / 非对象",
		not ids.has("assistant-b") and not ids.has("assistant-c")
		and not ids.has("assistant-e") and not ids.has("not-a-dict"))

	_check("supports_stage 识别 channels", DiscoveryScript.supports_stage({"channels": ["http", "stage"]}))
	_check("supports_stage 拒绝仅 http", not DiscoveryScript.supports_stage({"channels": ["http"]}))
	_check("supports_stage 端点元数据优先（空端点 = 禁用）",
		not DiscoveryScript.supports_stage({"channels": ["stage"], "channelEndpoints": []}))
	_check("supports_stage 接受 stage ws 端点", DiscoveryScript.supports_stage(info_direct))

	var endpoint := DiscoveryScript.stage_endpoint(info_direct)
	_check("stage_endpoint 取 stage ws 端点",
		String(endpoint.get("host", "")) == "127.0.0.1" and int(endpoint.get("port", 0)) == 41232
		and String(endpoint.get("path", "")) == "/ws")
	_check("stage_endpoint 空元数据返回空字典",
		DiscoveryScript.stage_endpoint({"channelEndpoints": []}).is_empty())
	_check("stage_endpoint 无元数据时回退 host/port",
		int(DiscoveryScript.stage_endpoint({"host": "10.0.0.1", "port": 9000}).get("port", 0)) == 9000)
	_check("发现条目可拼出网关 URL",
		DiscoveryScript.gateway_ws_url(
			"https://console.example.com", DiscoveryScript.gateway_ws_path(info_gateway), "key"
		) == "wss://console.example.com/a/assistant-a/ws?api_key=key")


# ============================================================
# Client：传输配置 / 状态机
# ============================================================

func _test_client_peer_buffers() -> void:
	_check("握手超时常量 = 30s", ClientScript.HANDSHAKE_TIMEOUT_MSEC == 30000)
	_check("入站缓冲常量 ≥ 8 MiB", ClientScript.INBOUND_BUFFER_BYTES >= 8 * 1024 * 1024)
	var peer := ClientScript.make_peer()
	_check("make_peer 入站缓冲 ≥ 8 MiB", peer.inbound_buffer_size >= 8 * 1024 * 1024)
	_check("make_peer 出站缓冲 ≥ 1 MiB", peer.outbound_buffer_size >= 1024 * 1024)
	_check("make_peer 排队包上限 ≥ 4096", peer.max_queued_packets >= 4096)
	peer = null


func _test_handshake_assistant() -> void:
	var client := _new_client("assistant")
	var connected_calls: Array = []
	var disconnected_calls: Array = []
	client.connected.connect(func(): connected_calls.append(true))
	client.disconnected.connect(func(reason): disconnected_calls.append(String(reason)))

	client._handle(Protocol.encode(_hello_ack_frame()))
	_check("hello_ack 后发送 stage_register", client.sent.size() == 1 and client.sent[0].get("type") == "stage_register")
	if client.sent.size() == 1:
		var register_frame: Dictionary = client.sent[0]
		var stage := _dict_value(register_frame.get("stage", {}))
		_check("stage_register 带初始 requestId",
			register_frame.get("requestId") == ClientScript.INITIAL_REGISTER_REQUEST_ID)
		_check("stage_register 带 stage id/kind",
			stage.get("id") == "town:meadow" and stage.get("kind") == "town")
		_check("stage_register 带 environment",
			_dict_value(stage.get("environment", {})).get("text") == "萤火镇")
		_check("stage_register 带 commands",
			_array_value(stage.get("commands", [])).size() == 1)
	_check("hello_ack 后阶段 = acked", client.get_phase() == ClientScript.PHASE_ACKED)

	client._handle(Protocol.encode(_register_result_frame("other", "registered")))
	_check("忽略无关 requestId 的注册回执", client.sent.size() == 1 and client.get_phase() == ClientScript.PHASE_ACKED)

	client._handle(Protocol.encode(
		_register_result_frame(ClientScript.INITIAL_REGISTER_REQUEST_ID, "registered")
	))
	_check("注册成功后才请求激活", client.sent.size() == 2 and client.sent[1].get("type") == "stage_activate")
	if client.sent.size() == 2:
		_check("stage_activate 带初始 requestId 与 stageId",
			client.sent[1].get("requestId") == ClientScript.INITIAL_ACTIVATE_REQUEST_ID
			and client.sent[1].get("stageId") == "town:meadow")
	_check("激活前不宣告 connected", connected_calls.is_empty() and client.get_phase() == ClientScript.PHASE_REGISTERED)

	client._handle(Protocol.encode(
		_activate_result_frame(ClientScript.INITIAL_ACTIVATE_REQUEST_ID, "changed")
	))
	_check("激活成功只触发一次 connected", connected_calls.size() == 1)
	_check("连接就绪：is_ready + phase active", client.is_ready() and client.get_phase() == ClientScript.PHASE_ACTIVE)
	_check("激活后记录 active stage id", client.get_active_stage_id() == "town:meadow")
	_check("激活后保存 StageSnapshot", String(client.get_stage_snapshot().get("status", "")) == "active")

	client._handle(Protocol.encode(
		_activate_result_frame(ClientScript.INITIAL_ACTIVATE_REQUEST_ID, "changed")
	))
	_check("重复激活回执不会重复 connected", connected_calls.size() == 1)
	_check("整个握手过程没有 disconnected", disconnected_calls.is_empty())
	client.free()


func _test_handshake_user() -> void:
	var client := _new_client("user")
	var connected_calls: Array = []
	client.connected.connect(func(): connected_calls.append(true))

	client._handle(Protocol.encode(_hello_ack_frame()))
	client._handle(Protocol.encode(
		_register_result_frame(ClientScript.INITIAL_REGISTER_REQUEST_ID, "unchanged")
	))
	_check("role=user 注册成功后直接 connected", connected_calls.size() == 1 and client.is_ready())
	_check("role=user 跳过 stage_activate", client.sent.size() == 1 and client.sent[0].get("type") == "stage_register")
	client.free()


func _test_handshake_rejections() -> void:
	var rejected_register := _new_client()
	var reasons: Array = []
	var ready: Array = []
	rejected_register.disconnected.connect(func(reason): reasons.append(String(reason)))
	rejected_register.connected.connect(func(): ready.append(true))
	rejected_register._handle(Protocol.encode(_hello_ack_frame()))
	rejected_register._handle(Protocol.encode(
		_register_result_frame(ClientScript.INITIAL_REGISTER_REQUEST_ID, "rejected", "stage conflict")
	))
	_check("注册被拒 → disconnected 且无 connected",
		reasons.size() == 1 and ready.is_empty() and not rejected_register.get_phase() == ClientScript.PHASE_ACTIVE)
	_check("注册被拒原因透出", not reasons.is_empty() and String(reasons[0]).contains("stage conflict"))
	_check("注册被拒后不再发送 stage_activate", rejected_register.sent.size() == 1)
	rejected_register.free()

	var rejected_activate := _new_client()
	var activate_reasons: Array = []
	rejected_activate.disconnected.connect(func(reason): activate_reasons.append(String(reason)))
	rejected_activate._handle(Protocol.encode(_hello_ack_frame()))
	rejected_activate._handle(Protocol.encode(
		_register_result_frame(ClientScript.INITIAL_REGISTER_REQUEST_ID, "registered")
	))
	rejected_activate._handle(Protocol.encode(
		_activate_result_frame(ClientScript.INITIAL_ACTIVATE_REQUEST_ID, "rejected", "town:meadow", "stale revision")
	))
	_check("激活被拒原因透出", activate_reasons.size() == 1 and String(activate_reasons[0]).contains("stale revision"))
	_check("激活被拒后未就绪", not rejected_activate.is_ready())
	rejected_activate.free()

	var error_client := _new_client()
	var error_reasons: Array = []
	error_client.disconnected.connect(func(reason): error_reasons.append(String(reason)))
	error_client._handle(Protocol.encode(_hello_ack_frame()))
	error_client._handle(Protocol.encode({"type": "error", "requestId": "r2", "error": "clientId is required"}))
	_check("握手期 error 帧 → disconnected", error_reasons.size() == 1
		and String(error_reasons[0]).contains("clientId is required"))
	error_client.free()


func _test_handshake_timeout() -> void:
	var client := _new_client()
	var reasons: Array = []
	var ready: Array = []
	client.disconnected.connect(func(reason): reasons.append(String(reason)))
	client.connected.connect(func(): ready.append(true))
	client._phase = ClientScript.PHASE_HELLO_SENT
	client._handshake_deadline = Time.get_ticks_msec() - 1
	client.poll()
	_check("30s 握手超时 → disconnected", reasons.size() == 1 and ready.is_empty())
	_check("超时原因含 timed out 与阶段",
		not reasons.is_empty() and String(reasons[0]).contains("timed out"))
	_check("超时后阶段回 DISCONNECTED", client.get_phase() == ClientScript.PHASE_DISCONNECTED)
	client.free()

	var patient := _new_client()
	var patient_reasons: Array = []
	patient.disconnected.connect(func(reason): patient_reasons.append(String(reason)))
	patient._handshake_deadline = Time.get_ticks_msec() + 5000
	patient.poll()
	_check("未到超时时间不触发 disconnected", patient_reasons.is_empty())
	patient.free()


func _test_hello_ack_channel_mismatch() -> void:
	var client := _new_client()
	var reasons: Array = []
	client.disconnected.connect(func(reason): reasons.append(String(reason)))
	client._handle(Protocol.encode({
		"type": "hello_ack",
		"channel": "http",
		"clientId": "godot-1",
		"registrations": [],
		"stage": _snapshot("empty", "empty", 0, "empty", []),
	}))
	_check("hello_ack.channel != stage → 握手失败",
		reasons.size() == 1 and client.sent.is_empty() and not client.is_ready())
	client.free()


func _test_close_reasons() -> void:
	var client := _new_client()
	var connected_calls: Array = []
	var reasons: Array = []
	client.connected.connect(func(): connected_calls.append(true))
	client.disconnected.connect(func(reason): reasons.append(String(reason)))
	_simulate_connected(client)
	_check("关闭测试前已 connected", connected_calls.size() == 1 and client.is_ready())

	client._handle_close(4001, "clientId replaced by a new connection")
	_check("4001 关闭只触发一次 disconnected", reasons.size() == 1)
	_check("disconnected reason 透出关闭码",
		not reasons.is_empty() and String(reasons[0]).contains("4001"))
	_check("disconnected reason 透出服务端关闭原因",
		not reasons.is_empty() and String(reasons[0]).contains("clientId replaced by a new connection"))
	_check("last_close_code / last_close_reason 可读",
		client.last_close_code == 4001 and client.last_close_reason == "clientId replaced by a new connection")
	_check("关闭后 is_ready = false", not client.is_ready())
	client._handle_close(4001, "clientId replaced by a new connection")
	_check("重复关闭事件被去重", reasons.size() == 1)
	client.free()


func _test_command_routing() -> void:
	var client := _new_client()
	var commands: Array = []
	client.command_received.connect(func(command): commands.append(command))
	_simulate_connected(client)
	var baseline: int = client.sent.size()

	client._handle(Protocol.encode(_command_frame("stage-1", "town:meadow")))
	_check("本 Stage 的 command 派发到 command_received", commands.size() == 1)
	if commands.size() == 1:
		var payload: Dictionary = commands[0]
		_check("command_received 结构 = {commandId, command, args}",
			payload.get("commandId") == "stage-1" and payload.get("command") == "say"
			and _dict_value(payload.get("args", {})).get("text") == "你好")
	_check("接受 command 时客户端不自动回执", client.sent.size() == baseline)

	client._handle(Protocol.encode(_command_frame("stage-2", "another-town")))
	_check("stageId 不匹配自动回 ok=false",
		client.sent.size() == baseline + 1 and client.sent.back().get("type") == "command_result"
		and client.sent.back().get("ok") == false)
	_check("不匹配回执带 commandId 与原因",
		client.sent.back().get("commandId") == "stage-2"
		and not String(client.sent.back().get("error", "")).is_empty())
	_check("不匹配 command 不派发", commands.size() == 1)

	client._handle(Protocol.encode(_command_frame("stage-3", "town:meadow", "say", [])))
	_check("args 非对象容忍为 {}", commands.size() == 2 and _dict_value(commands[1].get("args", {})).is_empty())

	var no_stage := _command_frame("stage-4", "")
	no_stage.erase("stageId")
	client._handle(Protocol.encode(no_stage))
	_check("缺 stageId 的 command 归到当前 Stage", commands.size() == 3)
	client.free()


func _test_llm_event_and_unknown_frames() -> void:
	var client := _new_client()
	var events: Array = []
	var rejected: Array = []
	var errors: Array = []
	var disconnected_calls: Array = []
	client.llm_event_received.connect(func(event): events.append(event))
	client.event_rejected.connect(func(reason): rejected.append(String(reason)))
	client.error_received.connect(func(message): errors.append(message))
	client.disconnected.connect(func(reason): disconnected_calls.append(String(reason)))
	_simulate_connected(client)

	var fixture := _load_fixture("llm-event.server.json")
	client._handle(Protocol.encode(fixture))
	_check("llm_event 派发到 llm_event_received", events.size() == 1)
	if events.size() == 1:
		_check("llm_event 内容是原始 event", _dict_value(events[0]).get("type") == "assistant_message")

	client._handle(Protocol.encode({"type": "llm_event", "event": "not-an-object"}))
	_check("非对象 llm_event.event 被忽略", events.size() == 1)

	var sent_before: int = client.sent.size()
	client._handle(Protocol.encode({"type": "future_frame", "payload": {"anything": true}}))
	_check("未知 type 被忽略且不发送任何帧",
		client.sent.size() == sent_before and client.is_ready())
	_check("未知 type 不触发 disconnected", disconnected_calls.is_empty())

	client._handle(Protocol.encode({"type": "event_rejected", "reason": "event stage is not current"}))
	_check("event_rejected 原因透出", rejected.size() == 1 and String(rejected[0]).contains("not current"))

	client._handle(Protocol.encode({"type": "error", "requestId": "r9", "error": "unsupported interaction"}))
	_check("连接后 error 帧走 error_received 而非断开",
		errors.size() == 1 and disconnected_calls.is_empty() and client.is_ready())
	client.free()


# ============================================================
# Client：出站帧 / URL
# ============================================================

func _test_outbound_frames() -> void:
	var client := _new_client()

	var register_fixture := _load_fixture("stage-register.client.json")
	var stage := _dict_value(register_fixture.get("stage", {}))
	client.register_stage(
		String(stage.get("id", "")),
		String(stage.get("kind", "")),
		_dict_value(stage.get("environment", {})),
		_array_value(stage.get("commands", [])),
		String(register_fixture.get("requestId", "")),
	)
	_check("register_stage 帧与 fixture 等价",
		client.sent.size() == 1 and Protocol.equivalent(client.sent.back(), register_fixture))

	client.activate_stage("town:meadow", "after-turn", "empty", 0, "a1")
	_check("activate_stage 帧与 fixture 等价",
		Protocol.equivalent(client.sent.back(), _load_fixture("stage-activate.client.json")))

	client.transition_to_empty("town:meadow", "interrupt", "", -1, "t1")
	_check("transition_to_empty 帧与 fixture 等价",
		Protocol.equivalent(client.sent.back(), _load_fixture("stage-transition.client.json")))

	client.send_result("stage-1750000000000-1", true, {"accepted": true})
	_check("send_result 帧与 fixture 等价",
		Protocol.equivalent(client.sent.back(), _load_fixture("command-result.client.json")))

	client.send_event({"kind": "user_said", "text": "你好", "participantId": "user-1"})
	_check("send_event 帧与 fixture 等价",
		Protocol.equivalent(client.sent.back(), _load_fixture("event.client.json")))

	client.register_stage()
	_check("register_stage 自动生成 requestId",
		String(client.sent.back().get("requestId", "")).begins_with("register-"))
	client.activate_stage()
	_check("activate_stage 自动生成 requestId",
		String(client.sent.back().get("requestId", "")).begins_with("activate-"))
	client.transition_to_empty()
	_check("transition_to_empty 自动生成 requestId",
		String(client.sent.back().get("requestId", "")).begins_with("transition-"))
	client.free()


func _test_client_urls() -> void:
	var direct = RecordingClient.new()
	direct.open_direct("127.0.0.1", 41232, "godot-client")
	_check("open_direct 构造直连 URL", direct.get_url() == "ws://127.0.0.1:41232/ws")
	_check("open_direct 进入 connecting 阶段", direct.get_phase() == ClientScript.PHASE_CONNECTING)
	_check("open_direct 保留 clientId", direct.get_client_id() == "godot-client")
	direct.free()

	var gateway = RecordingClient.new()
	gateway.open_gateway(
		"ws://127.0.0.1:41233/a/assistant-1/ws?api_key=k", "godot-2", [], "user"
	)
	_check("open_gateway 保留完整网关 URL",
		gateway.get_url() == "ws://127.0.0.1:41233/a/assistant-1/ws?api_key=k")
	_check("open_gateway role=user 生效", gateway._role == "user")
	gateway.free()

	var demo = RecordingClient.new()
	demo.open(
		"127.0.0.1", 41232, "godot-client", [], "assistant", "assistant-1", "编码助手", "",
		"vn:godot-main", "vn", {}, "/ws", false,
	)
	_check("demo 兼容 open() 构造直连 URL", demo.get_url() == "ws://127.0.0.1:41232/ws")
	_check("demo 兼容 open() 保留 stage 配置",
		demo._stage_id == "vn:godot-main" and demo._stage_kind == "vn" and demo._role == "assistant")
	demo.free()

	var demo_tls = RecordingClient.new()
	demo_tls.open(
		"127.0.0.1", 443, "godot-client", [], "user", "", "", "",
		"vn:godot-main", "vn", {}, "/ws", true,
	)
	_check("demo 兼容 open(use_tls=true) → wss", demo_tls.get_url() == "wss://127.0.0.1:443/ws")
	_check("demo 兼容 open(role=user)", demo_tls._role == "user")
	demo_tls.free()

	var auto_id = RecordingClient.new()
	auto_id.open_url("ws://127.0.0.1:41234/ws", "")
	_check("空 clientId 自动生成且非空", not auto_id.get_client_id().is_empty())
	auto_id.free()
