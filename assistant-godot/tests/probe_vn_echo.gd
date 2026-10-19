extends Node
## vn channel 回环探针：连接后，收到任何 command 就回 command_result。
## 用于验证 godot 端能完整走「收指令 → 回执」链路（不发消息、不花 token）。

var vn: StageChannelClient

func _ready() -> void:
	vn = StageChannelClient.new()
	add_child(vn)
	vn.connected.connect(func(): print("[echo] vn 已连接"))
	vn.command_received.connect(func(cmd):
		print("[echo] 收到指令: %s args=%s" % [cmd.get("command", "?"), cmd.get("args", {})])
		vn.send_result(String(cmd.get("commandId", "")), true, {"echo": true}, "")
		print("[echo] 已回执")
	)
	vn.open(AppConfig.host, AppConfig.port, "godot-echo",
		[
			{"name": "create_scene"}, {"name": "switch_scene"},
			{"name": "list_scenes"}, {"name": "get_scene"},
			{"name": "add_object"}, {"name": "remove_object"}, {"name": "move_object"},
			{"name": "add_assistant"}, {"name": "remove_assistant"}, {"name": "move_assistant"},
			{"name": "set_assistant_sprite"},
		],
		"assistant", "echo-assistant", "回环探针", "")
	await get_tree().create_timer(30.0).timeout
	print("[echo] 结束")
	get_tree().quit(0)


func _process(_dt: float) -> void:
	if vn != null:
		vn.poll()
