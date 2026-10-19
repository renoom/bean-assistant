extends Node
## vn channel 连通性探针：连 /ws，上报 hello，验证收到 hello_ack。
## 不发消息、不花 token。
##
##   Godot --headless --path . res://tests/probe_vn.tscn -- --port=3101

var vn: StageChannelClient

func _ready() -> void:
	print("\n════ vn 通道探针 → %s ════" % AppConfig.base_url())
	vn = StageChannelClient.new()
	add_child(vn)
	vn.connected.connect(func():
		print("  ✓ vn channel 已连接（hello_ack 收到）")
		get_tree().quit(0)
	)
	vn.disconnected.connect(func(r):
		printerr("  ✗ 断开：%s" % r)
		get_tree().quit(1)
	)
	vn.open(AppConfig.host, AppConfig.port, "godot-probe",
		[
			{"name": "create_scene"},
			{"name": "switch_scene"},
			{"name": "list_scenes"},
			{"name": "get_scene"},
			{"name": "add_object"},
			{"name": "remove_object"},
			{"name": "move_object"},
			{"name": "add_assistant"},
			{"name": "remove_assistant"},
			{"name": "move_assistant"},
			{"name": "set_assistant_sprite"},
		],
		"assistant", "probe-assistant", "探针助手", "")

	await get_tree().create_timer(6.0).timeout
	printerr("  ✗ 6 秒内没连上 vn channel")
	get_tree().quit(1)


func _process(_dt: float) -> void:
	if vn != null:
		vn.poll()
