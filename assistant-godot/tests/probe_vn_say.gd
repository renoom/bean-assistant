extends Node
## 多助手场景事件路由冒烟测试。
##
## say / say_to 是「指令」（SUPPORTED_COMMANDS），由 main.gd 的 _execute_command 解析。
## 助手说话时，main.gd 渲染气泡后用 broadcast_event(exclude=说话者) / send_event_to 转发事件。
## 回喂控制（发给谁 / 广播 / 不回喂自己）都在 VnClientManager 出站路由里。
##
## 本探针不连真实 ws，构造 VnClientManager + 若干 mock client（_peer==null，send_event 静默丢弃），
## 验证 broadcast_event / send_event_to 的迭代逻辑不抛异常。

const EventBusScript = preload("res://core/scene/event_bus.gd")
const VnClientManagerScript = preload("res://core/scene/vn_client_manager.gd")

var bus: SceneEventBus
var mgr: VnClientManager
var _pass := 0
var _fail := 0

func _ready() -> void:
	print("\n════ 多助手场景事件路由探针 ════")
	bus = EventBusScript.new()
	add_child(bus)
	mgr = VnClientManagerScript.new()
	add_child(mgr)
	mgr.setup("127.0.0.1", 0, bus)

	# mock 三个 client（不连真实 ws）。_peer==null，send_event 会静默 return，正好验证「不 crash」。
	mgr._clients["A"] = _mock_client("A")
	mgr._clients["B"] = _mock_client("B")
	mgr._user_ws = _mock_client("user")

	# Case 1：公开 say —— 广播给其他助手（排除自己）
	print("\n  [case 1] broadcast_event(assistant_said, exclude=A)")
	mgr.broadcast_event({"kind": "assistant_said", "from": "A", "text": "大家好"}, "A")
	_check("broadcast_event(exclude) 不抛异常", true)

	# Case 2：私聊 say_to —— 定向 B
	print("\n  [case 2] send_event_to(B, assistant_said)")
	mgr.send_event_to("B", {"kind": "assistant_said", "from": "A", "text": "私聊"})
	_check("send_event_to 不抛异常", true)

	# Case 3：用户互动 —— 广播（不排除）
	print("\n  [case 3] broadcast_event(user 互动)")
	mgr.broadcast_event({"kind": "object_clicked", "sceneId": "s", "objectId": "sword", "actor": "user"})
	_check("broadcast_event 不抛异常", true)

	# Case 4：定向不存在的助手
	print("\n  [case 4] send_event_to(ghost)")
	mgr.send_event_to("ghost", {"kind": "assistant_said", "from": "A", "text": "空"})
	_check("目标不存在不抛异常", true)

	print("\n════ %d 通过 / %d 失败 ════\n" % [_pass, _fail])
	get_tree().quit(0 if _fail == 0 else 1)


func _mock_client(aid: String) -> StageChannelClient:
	var c := StageChannelClient.new()
	c.command_received.connect(mgr._on_command.bind(aid))
	c.llm_event_received.connect(mgr._on_llm_event.bind(aid))
	c.disconnected.connect(mgr._on_ws_disconnected.bind(aid))
	add_child(c)
	return c


func _check(label: String, ok: bool) -> void:
	if ok:
		_pass += 1
		print("  ✓ %s" % label)
	else:
		_fail += 1
		printerr("  ✗ %s" % label)
