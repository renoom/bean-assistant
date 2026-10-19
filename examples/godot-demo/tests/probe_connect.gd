extends Node
## 直接测 VnClientManager.connect_assistant 能否连上真实助手（虹猫 3102）。

const EventBusScript = preload("res://core/scene/event_bus.gd")
const VnClientManagerScript = preload("res://core/scene/vn_client_manager.gd")

var bus: SceneEventBus
var mgr: VnClientManager

func _ready() -> void:
	print("\n════ connect_assistant 连接探针 ════")
	bus = EventBusScript.new()
	add_child(bus)
	mgr = VnClientManagerScript.new()
	add_child(mgr)
	mgr.setup("127.0.0.1", 3102, bus)

	bus.assistant_joined.connect(func(m): print("  [joined] ", m))
	bus.assistant_left.connect(func(a): print("  [left] ", a))

	var c := mgr.connect_assistant({
		"assistantId": "assistant-3102-f43903a0",
		"name": "虹猫",
		"spritePath": "",
		"commands": [{"name": "say"}, {"name": "say_to"}, {"name": "create_scene"}],
	})
	print("  connect_assistant 返回: ", c)
	print("  clients: ", mgr.list_assistants())

	# 等 4 秒让 ws 完成握手 + hello
	await get_tree().create_timer(4.0).timeout
	print("  4 秒后 clients: ", mgr.list_assistants())
	print("════ 探针结束 ════")
	get_tree().quit(0)


func _process(_dt: float) -> void:
	if mgr != null:
		mgr.poll()
