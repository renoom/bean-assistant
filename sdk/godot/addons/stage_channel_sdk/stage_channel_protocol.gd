extends RefCounted
class_name StageChannelProtocol
## StageChannel 协议 v1 的编解码、帧构造与校验工具。
##
## 协议唯一源是仓库内 `sdk/spec/protocol.md` 与 `sdk/spec/fixtures/`；本类只做
## 纯数据处理，不做网络 IO。传输层见 StageChannelClient / StageChannelDiscovery。
##
## 前向兼容约定：
##   · 未知 `type` 必须忽略 —— decode() 仍返回原始 Dictionary，validate_*() 返回空串；
##   · 未知字段必须忽略 —— decode() 原样保留，调用方只取自己认识的键；
##   · 非 JSON 对象 / 非法 JSON 返回空 Dictionary。

const CHANNEL := "stage"

# ---- client -> server ----
const TYPE_HELLO := "hello"
const TYPE_STAGE_REGISTER := "stage_register"
const TYPE_STAGE_UNREGISTER := "stage_unregister"
const TYPE_STAGE_ACTIVATE := "stage_activate"
const TYPE_STAGE_TRANSITION := "stage_transition"
const TYPE_EVENT := "event"
const TYPE_COMMAND_RESULT := "command_result"
const TYPE_CHAT := "chat"
const TYPE_MESSAGE := "message"

# ---- server -> client ----
const TYPE_HELLO_ACK := "hello_ack"
const TYPE_STAGE_REGISTER_RESULT := "stage_register_result"
const TYPE_STAGE_UNREGISTER_RESULT := "stage_unregister_result"
const TYPE_STAGE_ACTIVATE_RESULT := "stage_activate_result"
const TYPE_STAGE_TRANSITION_RESULT := "stage_transition_result"
const TYPE_COMMAND := "command"
const TYPE_LLM_EVENT := "llm_event"
const TYPE_EVENT_REJECTED := "event_rejected"
const TYPE_ERROR := "error"
const TYPE_CHAT_RESULT := "chat_result"

const ROLE_ASSISTANT := "assistant"
const ROLE_USER := "user"

const MODE_AFTER_TURN := "after-turn"
const MODE_INTERRUPT := "interrupt"

const REGISTER_OK_KINDS := ["registered", "updated", "unchanged"]
const TRANSITION_OK_KINDS := ["changed", "unchanged"]
const REGISTER_KINDS := ["registered", "updated", "unchanged", "rejected"]
const TRANSITION_KINDS := ["changed", "unchanged", "rejected"]

const CLIENT_TO_SERVER_TYPES := [
	TYPE_HELLO,
	TYPE_STAGE_REGISTER,
	TYPE_STAGE_UNREGISTER,
	TYPE_STAGE_ACTIVATE,
	TYPE_STAGE_TRANSITION,
	TYPE_EVENT,
	TYPE_COMMAND_RESULT,
	TYPE_CHAT,
	TYPE_MESSAGE,
]

const SERVER_TO_CLIENT_TYPES := [
	TYPE_HELLO_ACK,
	TYPE_STAGE_REGISTER_RESULT,
	TYPE_STAGE_UNREGISTER_RESULT,
	TYPE_STAGE_ACTIVATE_RESULT,
	TYPE_STAGE_TRANSITION_RESULT,
	TYPE_COMMAND,
	TYPE_LLM_EVENT,
	TYPE_EVENT_REJECTED,
	TYPE_ERROR,
	TYPE_CHAT_RESULT,
]


# ============================================================
# 编解码
# ============================================================

## JSON 文本 -> 帧 Dictionary。非法 JSON / 非对象返回 {}；未知 type 原样返回。
static func decode(text: String) -> Dictionary:
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		return {}
	var frame: Dictionary = parsed
	return frame


## 二进制帧（WebSocket 文本帧的字节）-> 帧 Dictionary。
static func decode_bytes(bytes: PackedByteArray) -> Dictionary:
	return decode(bytes.get_string_from_utf8())


## 帧 Dictionary -> JSON 文本（一条消息一个完整帧，不做分片协议）。
static func encode(frame: Dictionary) -> String:
	return JSON.stringify(frame)


# ============================================================
# 类型判断
# ============================================================

static func frame_type(frame: Dictionary) -> String:
	var value: Variant = frame.get("type", "")
	return value if typeof(value) == TYPE_STRING else ""


static func is_known_type(type_name: String) -> bool:
	return type_name in CLIENT_TO_SERVER_TYPES or type_name in SERVER_TO_CLIENT_TYPES


static func is_known_client_type(type_name: String) -> bool:
	return type_name in CLIENT_TO_SERVER_TYPES


static func is_known_server_type(type_name: String) -> bool:
	return type_name in SERVER_TO_CLIENT_TYPES


## 只要求是带非空字符串 type 的 JSON 对象；未知 type 也算“可解析”。
static func is_frame(value: Variant) -> bool:
	if typeof(value) != TYPE_DICTIONARY:
		return false
	var frame: Dictionary = value
	return not frame_type(frame).is_empty()


# ============================================================
# 帧构造（client -> server）
# ============================================================

## hello 帧。只写入非空的可选字段，因此能与 fixtures 逐字段等价。
static func hello(
	client_id: String,
	role: String = "",
	assistant_id: String = "",
	name: String = "",
	sprite_path: String = "",
	client_type: String = "",
	stage_id: String = "",
	stage_kind: String = "",
	environment: Dictionary = {},
	commands: Array = [],
	activate_stage: bool = false,
) -> Dictionary:
	var frame := {"type": TYPE_HELLO, "channel": CHANNEL, "clientId": client_id}
	if not role.is_empty():
		frame["role"] = role
	if not assistant_id.is_empty():
		frame["assistantId"] = assistant_id
	if not name.is_empty():
		frame["name"] = name
	if not sprite_path.is_empty():
		frame["spritePath"] = sprite_path
	if not client_type.is_empty():
		frame["clientType"] = client_type
	# 旧版兼容字段：新版客户端走独立的 stage_register，不再用这些字段。
	if not stage_id.is_empty():
		frame["stageId"] = stage_id
	if not stage_kind.is_empty():
		frame["stageKind"] = stage_kind
	if not environment.is_empty():
		frame["environment"] = environment.duplicate(true)
	if not commands.is_empty():
		frame["commands"] = commands.duplicate(true)
	if activate_stage:
		frame["activateStage"] = true
	return frame


## stage_register 帧。
static func stage_register(
	stage_id: String,
	stage_kind: String,
	environment: Dictionary = {},
	commands: Array = [],
	request_id: String = "",
) -> Dictionary:
	var stage := {"id": stage_id, "kind": stage_kind}
	if not environment.is_empty():
		stage["environment"] = environment.duplicate(true)
	if not commands.is_empty():
		stage["commands"] = commands.duplicate(true)
	var frame := {"type": TYPE_STAGE_REGISTER, "stage": stage}
	if not request_id.is_empty():
		frame["requestId"] = request_id
	return frame


## stage_unregister 帧。
static func stage_unregister(stage_id: String, request_id: String = "") -> Dictionary:
	var frame := {"type": TYPE_STAGE_UNREGISTER, "stageId": stage_id}
	if not request_id.is_empty():
		frame["requestId"] = request_id
	return frame


## stage_activate 帧。expected_revision < 0 表示不带乐观并发字段。
static func stage_activate(
	stage_id: String,
	mode: String = "",
	expected_stage_id: String = "",
	expected_revision: int = -1,
	request_id: String = "",
) -> Dictionary:
	var frame := {"type": TYPE_STAGE_ACTIVATE, "stageId": stage_id}
	_append_transition_options(frame, mode, expected_stage_id, expected_revision)
	if not request_id.is_empty():
		frame["requestId"] = request_id
	return frame


## stage_transition 帧。target="empty" 表示回到默认环境。
static func stage_transition(
	stage_id: String,
	target: String = "",
	mode: String = "",
	expected_stage_id: String = "",
	expected_revision: int = -1,
	request_id: String = "",
) -> Dictionary:
	var frame := {"type": TYPE_STAGE_TRANSITION, "stageId": stage_id}
	if not target.is_empty():
		frame["target"] = target
	_append_transition_options(frame, mode, expected_stage_id, expected_revision)
	if not request_id.is_empty():
		frame["requestId"] = request_id
	return frame


## stage_transition(target="empty") 的便捷形式。
static func transition_to_empty(
	stage_id: String,
	mode: String = "",
	expected_stage_id: String = "",
	expected_revision: int = -1,
	request_id: String = "",
) -> Dictionary:
	return stage_transition(stage_id, "empty", mode, expected_stage_id, expected_revision, request_id)


## event 帧。stage_id 为空时省略（服务端按当前 Stage 路由）。
static func event_frame(stage_id: String, event: Dictionary) -> Dictionary:
	var frame := {"type": TYPE_EVENT, "event": event.duplicate(true)}
	if not stage_id.is_empty():
		frame["stageId"] = stage_id
	return frame


## command_result 帧。error 为空时省略。
static func command_result_frame(command_id: String, ok: bool, result: Variant, error: String = "") -> Dictionary:
	var frame := {"type": TYPE_COMMAND_RESULT, "commandId": command_id, "ok": ok, "result": result}
	if not error.is_empty():
		frame["error"] = error
	return frame


static func _append_transition_options(
	frame: Dictionary, mode: String, expected_stage_id: String, expected_revision: int
) -> void:
	if not mode.is_empty():
		frame["mode"] = mode
	if not expected_stage_id.is_empty():
		frame["expectedStageId"] = expected_stage_id
	if expected_revision >= 0:
		frame["expectedRevision"] = expected_revision


# ============================================================
# 服务端帧读取辅助
# ============================================================

## command 帧 -> {commandId, command, args}；args 非 Dictionary 时归一为 {}。
static func command_payload(frame: Dictionary) -> Dictionary:
	var args: Variant = frame.get("args", {})
	return {
		"commandId": String(frame.get("commandId", "")),
		"command": String(frame.get("command", "")),
		"args": args if typeof(args) == TYPE_DICTIONARY else {},
	}


static func llm_event_payload(frame: Dictionary) -> Dictionary:
	var event: Variant = frame.get("event", {})
	return event if typeof(event) == TYPE_DICTIONARY else {}


static func stage_snapshot(frame: Dictionary) -> Dictionary:
	var stage: Variant = frame.get("stage", {})
	return stage if typeof(stage) == TYPE_DICTIONARY else {}


static func result_object(frame: Dictionary) -> Dictionary:
	var result: Variant = frame.get("result", {})
	return result if typeof(result) == TYPE_DICTIONARY else {}


static func register_result_kind(frame: Dictionary) -> String:
	return String(result_object(frame).get("kind", ""))


static func transition_result_kind(frame: Dictionary) -> String:
	return String(result_object(frame).get("kind", ""))


## rejected 结果里的原因；兼容顶层 error 字段。
static func rejected_reason(frame: Dictionary) -> String:
	var reason := String(result_object(frame).get("reason", ""))
	if reason.is_empty():
		reason = String(frame.get("error", ""))
	return reason


# ============================================================
# 校验（fixtures / 入站帧测试用）
# ============================================================

## 返回空串表示通过，否则返回失败原因。
## 未知 server_to_client type 视为通过（前向兼容）。
static func validate_server_frame(frame: Dictionary) -> String:
	if not is_frame(frame):
		return "frame must be a JSON object with a non-empty string type"
	var type_name := frame_type(frame)
	match type_name:
		TYPE_HELLO_ACK:
			if String(frame.get("channel", "")) != CHANNEL:
				return "hello_ack.channel must be \"stage\""
			if String(frame.get("clientId", "")).is_empty():
				return "hello_ack.clientId is required"
			if typeof(frame.get("registrations", null)) != TYPE_ARRAY:
				return "hello_ack.registrations must be an array"
			return _validate_snapshot(frame.get("stage", null), "hello_ack.stage")
		TYPE_STAGE_REGISTER_RESULT:
			var error := _validate_result_kind(frame, REGISTER_KINDS)
			if not error.is_empty():
				return error
			return _validate_snapshot(frame.get("stage", null), "stage_register_result.stage")
		TYPE_STAGE_UNREGISTER_RESULT:
			if typeof(frame.get("removed", null)) != TYPE_BOOL:
				return "stage_unregister_result.removed must be a boolean"
			return _validate_snapshot(frame.get("stage", null), "stage_unregister_result.stage")
		TYPE_STAGE_ACTIVATE_RESULT, TYPE_STAGE_TRANSITION_RESULT:
			var kind_error := _validate_result_kind(frame, TRANSITION_KINDS)
			if not kind_error.is_empty():
				return kind_error
			if transition_result_kind(frame) != "rejected":
				# TransitionResult 的 stage 嵌在 result 里：{kind, stage}。
				var snapshot_error := _validate_snapshot(
					result_object(frame).get("stage", null), type_name + ".result.stage"
				)
				if not snapshot_error.is_empty():
					return snapshot_error
			return ""
		TYPE_COMMAND:
			for key in ["commandId", "bridgeId", "stageId", "command"]:
				if typeof(frame.get(key, null)) != TYPE_STRING:
					return "command.%s must be a string" % key
			if typeof(frame.get("args", null)) != TYPE_DICTIONARY:
				return "command.args must be an object"
			return ""
		TYPE_LLM_EVENT:
			var event: Variant = frame.get("event", null)
			if typeof(event) != TYPE_DICTIONARY:
				return "llm_event.event must be an object"
			if (event as Dictionary).is_empty():
				return "llm_event.event must not be empty"
			return ""
		TYPE_EVENT_REJECTED:
			if String(frame.get("reason", "")).is_empty():
				return "event_rejected.reason is required"
			return ""
		TYPE_ERROR:
			if String(frame.get("error", "")).is_empty():
				return "error.error is required"
			return ""
		TYPE_CHAT_RESULT:
			if typeof(frame.get("accepted", null)) != TYPE_BOOL:
				return "chat_result.accepted must be a boolean"
			return ""
		_:
			return ""


## 返回空串表示通过，否则返回失败原因。
## 未知 client_to_server type 视为通过（前向兼容）。
static func validate_client_frame(frame: Dictionary) -> String:
	if not is_frame(frame):
		return "frame must be a JSON object with a non-empty string type"
	var type_name := frame_type(frame)
	match type_name:
		TYPE_HELLO:
			if String(frame.get("channel", "")) != CHANNEL:
				return "hello.channel must be \"stage\""
			if String(frame.get("clientId", "")).is_empty():
				return "hello.clientId is required"
			if frame.has("role"):
				var role := String(frame.get("role", ""))
				if role != ROLE_ASSISTANT and role != ROLE_USER:
					return "hello.role must be \"assistant\" or \"user\""
			if frame.has("environment") and typeof(frame.get("environment")) != TYPE_DICTIONARY:
				return "hello.environment must be an object"
			if frame.has("commands") and typeof(frame.get("commands")) != TYPE_ARRAY:
				return "hello.commands must be an array"
			return ""
		TYPE_STAGE_REGISTER:
			var stage: Variant = frame.get("stage", null)
			if typeof(stage) != TYPE_DICTIONARY:
				return "stage_register.stage must be an object"
			var stage_dict: Dictionary = stage
			if String(stage_dict.get("id", "")).is_empty():
				return "stage_register.stage.id is required"
			if String(stage_dict.get("kind", "")).is_empty():
				return "stage_register.stage.kind is required"
			if stage_dict.has("environment") and typeof(stage_dict.get("environment")) != TYPE_DICTIONARY:
				return "stage_register.stage.environment must be an object"
			if stage_dict.has("commands") and typeof(stage_dict.get("commands")) != TYPE_ARRAY:
				return "stage_register.stage.commands must be an array"
			return ""
		TYPE_STAGE_UNREGISTER:
			if String(frame.get("stageId", "")).is_empty():
				return "stage_unregister.stageId is required"
			return ""
		TYPE_STAGE_ACTIVATE, TYPE_STAGE_TRANSITION:
			if String(frame.get("stageId", "")).is_empty():
				return type_name + ".stageId is required"
			if frame.has("mode"):
				var mode := String(frame.get("mode", ""))
				if mode != MODE_AFTER_TURN and mode != MODE_INTERRUPT:
					return type_name + ".mode must be \"after-turn\" or \"interrupt\""
			if frame.has("expectedRevision") and not _is_number(frame.get("expectedRevision")):
				return type_name + ".expectedRevision must be a number"
			if type_name == TYPE_STAGE_TRANSITION and frame.has("target"):
				if String(frame.get("target", "")) != "empty":
					return "stage_transition.target must be \"empty\""
			return ""
		TYPE_EVENT:
			if typeof(frame.get("event", null)) != TYPE_DICTIONARY:
				return "event.event must be an object"
			return ""
		TYPE_COMMAND_RESULT:
			if String(frame.get("commandId", "")).is_empty():
				return "command_result.commandId is required"
			if typeof(frame.get("ok", null)) != TYPE_BOOL:
				return "command_result.ok must be a boolean"
			if frame.has("error") and typeof(frame.get("error")) != TYPE_STRING:
				return "command_result.error must be a string"
			return ""
		TYPE_CHAT, TYPE_MESSAGE:
			if typeof(frame.get("text", null)) != TYPE_STRING:
				return type_name + ".text must be a string"
			return ""
		_:
			return ""


static func _validate_result_kind(frame: Dictionary, allowed: Array) -> String:
	var result: Variant = frame.get("result", null)
	if typeof(result) != TYPE_DICTIONARY:
		return "result must be an object"
	var kind := String((result as Dictionary).get("kind", ""))
	if kind.is_empty():
		return "result.kind is required"
	if not allowed.has(kind):
		return "result.kind \"%s\" is not one of %s" % [kind, allowed]
	return ""


static func _validate_snapshot(value: Variant, label: String) -> String:
	if typeof(value) != TYPE_DICTIONARY:
		return label + " must be an object"
	var stage: Dictionary = value
	for key in ["id", "kind", "status"]:
		if typeof(stage.get(key, null)) != TYPE_STRING:
			return label + "." + key + " must be a string"
	if not _is_number(stage.get("revision", null)):
		return label + ".revision must be a number"
	if typeof(stage.get("participants", null)) != TYPE_ARRAY:
		return label + ".participants must be an array"
	if typeof(stage.get("capabilities", null)) != TYPE_ARRAY:
		return label + ".capabilities must be an array"
	return ""


# ============================================================
# 深比较（fixtures 等价性测试用）
# ============================================================

## 字段顺序无关、int/float 数值等价的深比较。
static func equivalent(a: Variant, b: Variant) -> bool:
	if _is_number(a) and _is_number(b):
		return float(a) == float(b)
	if typeof(a) != typeof(b):
		return false
	match typeof(a):
		TYPE_DICTIONARY:
			var left: Dictionary = a
			var right: Dictionary = b
			if left.size() != right.size():
				return false
			for key: Variant in left.keys():
				if not right.has(key):
					return false
				if not equivalent(left[key], right[key]):
					return false
			return true
		TYPE_ARRAY:
			var left_array: Array = a
			var right_array: Array = b
			if left_array.size() != right_array.size():
				return false
			for index in left_array.size():
				if not equivalent(left_array[index], right_array[index]):
					return false
			return true
		_:
			return a == b


static func _is_number(value: Variant) -> bool:
	var value_type := typeof(value)
	return value_type == TYPE_INT or value_type == TYPE_FLOAT
