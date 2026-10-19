extends Node
## 接入隔离测试服务：验证真实 Godot WS 注册、激活和工具回执，不调用模型。

var client: StageChannelClient
var completed := false

func _ready() -> void:
	client = StageChannelClient.new()
	add_child(client)
	client.connected.connect(func(): print("[stage-probe] activated"))
	client.disconnected.connect(func(reason):
		if not completed:
			printerr("[stage-probe] " + reason)
			get_tree().quit(1)
	)
	client.command_received.connect(func(command):
		if String(command.get("command", "")) != "probe":
			get_tree().quit(1)
			return
		client.send_result(String(command.commandId), true, {"godot": true})
		completed = true
		print("[stage-probe] command replied")
		await get_tree().create_timer(0.2).timeout
		get_tree().quit(0)
	)
	client.open(AppConfig.host, AppConfig.port, "protocol-probe", [{"name": "probe"}],
		"assistant", "probe-assistant", "Protocol probe", "", "town:probe", "town",
		{"text": "Godot integration test environment"})
	await get_tree().create_timer(10).timeout
	if not completed:
		printerr("[stage-probe] timeout")
		get_tree().quit(1)

func _process(_dt: float) -> void:
	if client != null:
		client.poll()
