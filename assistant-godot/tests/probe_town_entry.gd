extends Node
## 真实链路探针：直接装载 AI 小镇，邀请助手，等待它自己生成序列帧 NPC 并 enter_stage。
##
## Godot --headless --path . -s res://tests/probe_town_entry.gd -- --port=3102 --session-id=...

const TIMEOUT_SECONDS := 900.0


func _ready() -> void:
	AppConfig.stage_id = "town:ai-meadow"
	AppConfig.stage_kind = "town"
	AppConfig.stage_name = "AI 萤火镇"
	var scene: Control = load("res://scenes/main.tscn").instantiate()
	add_child(scene)
	await get_tree().process_frame
	await get_tree().process_frame

	var session_id := AppConfig.session_id
	if session_id.is_empty():
		session_id = "assistant-3102-f43903a0"
	var port := AppConfig.port if AppConfig.port > 0 else 3102
	scene.call("_connect_assistant", {
		"sessionId": session_id,
		"name": AppConfig.assistant_name if not AppConfig.assistant_name.is_empty() else "虹猫",
		"host": AppConfig.host,
		"port": port,
	})

	var deadline := Time.get_ticks_msec() + int(TIMEOUT_SECONDS * 1000.0)
	while Time.get_ticks_msec() < deadline:
		await get_tree().create_timer(1.0).timeout
		var stage: Stage = scene.get("_stage")
		if stage != null and stage.list_assistants().has(session_id):
			var meta := stage.get_assistant_meta(stage.current_scene_id(), session_id)
			print("[probe-town] NPC 已入场: ", JSON.stringify(meta))
			get_tree().quit(0)
			return
	printerr("[probe-town] 超时：助手没有完成 draw_sprite_animation + enter_stage")
	get_tree().quit(1)
