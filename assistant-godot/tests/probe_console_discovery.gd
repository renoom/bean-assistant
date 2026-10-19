extends Node
## 只测「加助手」列表和连接设置的真实 HTTP 流程；不连接助手 Channel，也不发送事件。

const MainScene = preload("res://scenes/main.tscn")

var _main: Control
var _mock_url := ""
var _expected_user_data_dir := ""
var _screenshot_path := ""


func _ready() -> void:
	_mock_url = _arg_value("--mock-url=")
	_expected_user_data_dir = _arg_value("--expected-user-data-dir=")
	_screenshot_path = _arg_value("--screenshot=")
	get_tree().root.gui_embed_subwindows = true
	if _arg_value("--report-user-data-dir=") == "true":
		print("CONSOLE_DISCOVERY_USER_DATA_DIR=", OS.get_user_data_dir())
		get_tree().quit(0)
		return
	if _mock_url.is_empty() or _expected_user_data_dir.is_empty():
		_fail("缺少 mock URL 或隔离 user data 参数")
		return
	if OS.get_user_data_dir().simplify_path() != _expected_user_data_dir.simplify_path():
		_fail("user:// 未隔离；拒绝保存配置")
		return

	# 空白舞台不会加载城镇资源，也不会因为旧配置而选错 Stage。
	AppConfig.stage_id = "sandbox:blank"
	AppConfig.stage_kind = "sandbox"
	AppConfig.stage_name = "空白舞台"
	AppConfig.console_url = _mock_url
	AppConfig.api_key = ""
	_main = MainScene.instantiate()
	add_child(_main)
	await get_tree().process_frame
	await get_tree().process_frame

	_main._open_add_panel()
	if not await _wait_until(func(): return _main._add_status.text.contains("401") and _main._connection_settings.visible, "未显示 401 和连接设置"):
		return
	await get_tree().process_frame
	await get_tree().process_frame
	if not _screenshot_path.is_empty():
		var image := get_viewport().get_texture().get_image()
		if image.save_png(_screenshot_path) != OK:
			_fail("无法保存连接设置截图")
			return

	var settings: ConfirmationDialog = _main._connection_settings
	var url_edit := settings.find_child("ConsoleUrl", true, false) as LineEdit
	var key_edit := settings.find_child("ApiKey", true, false) as LineEdit
	if url_edit == null or key_edit == null:
		_fail("连接设置缺少 ConsoleUrl 或 ApiKey")
		return
	url_edit.text = _mock_url + "/"
	key_edit.text = " test-key "
	# 先走和用户点击一致的路径；某些 headless 版本不会由 emit 自动转发 confirmed，故补发一次。
	settings.get_ok_button().pressed.emit()
	await get_tree().process_frame
	if settings.visible:
		settings.confirmed.emit()
	if not await _wait_until(func(): return _main._add_entries.size() == 1 and not _main._add_status.text.contains("失败"), "保存后未刷新到唯一的 Stage 助手"):
		return
	if AppConfig.api_key != "test-key" or AppConfig.console_url != _mock_url:
		_fail("保存后的连接设置未规范化")
		return
	var config_file := FileAccess.open("user://config.json", FileAccess.READ)
	var saved_config: Variant = null if config_file == null else JSON.parse_string(config_file.get_as_text())
	if config_file != null:
		config_file.close()
	var config_ok := typeof(saved_config) == TYPE_DICTIONARY and String(saved_config.get("api_key", "")) == "test-key" and String(saved_config.get("console_url", "")) == _mock_url
	print("CONSOLE_DISCOVERY_CONFIG_OK=", config_ok)
	if not config_ok:
		_fail("隔离配置未保存为规范化 URL 和 Key")
		return

	# 第三次 mock 响应为空，必须清除上一次结果并给出明确的空状态。
	_main._open_add_panel()
	if not await _wait_until(func(): return _main._add_entries.is_empty() and _main._add_status.text.contains("没有") and _main._add_status.text.contains("在线"), "空列表没有清除旧助手或没有可读提示"):
		return
	print("CONSOLE_DISCOVERY_PROBE_PASS")
	get_tree().quit(0)


func _wait_until(predicate: Callable, failure: String) -> bool:
	var deadline := Time.get_ticks_msec() + 8000
	while Time.get_ticks_msec() < deadline:
		if predicate.call():
			return true
		await get_tree().create_timer(0.03).timeout
	_fail(failure + "；状态：" + _main._add_status.text)
	return false


func _arg_value(prefix: String) -> String:
	for raw_arg in OS.get_cmdline_user_args():
		var arg := String(raw_arg)
		if arg.begins_with(prefix):
			return arg.substr(prefix.length())
	return ""


func _fail(reason: String) -> void:
	push_error("CONSOLE_DISCOVERY_PROBE_FAIL: " + reason)
	print("CONSOLE_DISCOVERY_PROBE_FAIL: ", reason)
	get_tree().quit(1)
