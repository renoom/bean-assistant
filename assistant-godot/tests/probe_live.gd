extends Node
## 只读连通性探针。连上真实助手订阅事件流，**不发任何消息** —— 不花 token。
##
##   Godot --headless --path client res://tests/probe_live.tscn -- --port=3101

var session: SessionClient
var _frames := 0

func _ready() -> void:
	print("\n════ 只读探针 → %s ════" % AppConfig.base_url())
	session = SessionClient.new()
	add_child(session)
	session.connected.connect(func(info):
		print("  ✓ 已连上事件流")
		if not info.is_empty():
			print("    助手：%s   模型：%s   状态：%s" % [
				info.get("name", "?"), info.get("model", "?"), info.get("status", "?")])
	)
	session.disconnected.connect(func(r): printerr("  ✗ 断开：%s" % r))
	session.failed.connect(func(m): printerr("  ✗ 错误：%s" % m))
	session.raw_frame.connect(func(f):
		_frames += 1
		print("    ← %s" % f.get("type", "?"))
	)
	session.open()

	await get_tree().create_timer(6.0).timeout
	print("\n  收到 %d 帧" % _frames)
	if _frames > 0:
		print("  ✓ SSE 链路通\n")
	else:
		printerr("  ✗ 一帧都没收到 —— 助手可能没在跑，或端口不对\n")
	get_tree().quit(0 if _frames > 0 else 1)
