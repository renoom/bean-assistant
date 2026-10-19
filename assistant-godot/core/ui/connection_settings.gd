extends ConfirmationDialog
## Console 连接设置。配置仅保存在 user://config.json，不记录 API Key。

signal saved

var _console_url: LineEdit
var _api_key: LineEdit
var _show_key: CheckButton
var _error: Label
var _save_button: Button


func _ready() -> void:
	title = "连接设置"
	set_hide_on_ok(false)
	min_size = Vector2i(620, 360)
	_build_ui()
	_save_button = get_ok_button()
	_save_button.text = "保存"
	get_cancel_button().text = "取消"
	confirmed.connect(_save)


## 打开时始终从已生效的配置回填，避免显示上次取消的草稿。
func open() -> void:
	if not is_node_ready():
		await ready
	_console_url.text = AppConfig.console_url
	_api_key.text = AppConfig.api_key
	_show_key.button_pressed = false
	_api_key.secret = true
	_error.text = ""
	popup_centered(Vector2i(620, 360))
	_console_url.grab_focus()


func _build_ui() -> void:
	var body := Control.new()
	body.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	body.offset_left = 20
	body.offset_top = 18
	body.offset_right = -20
	body.offset_bottom = -70
	# Control 不会把自动换行 Label 的零宽最小尺寸传递给窗口。
	add_child(body)

	var intro := Label.new()
	intro.text = "填写控制台地址与平台 API Key。请从控制台复制 Key。"
	intro.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	intro.position = Vector2(0, 0)
	intro.size = Vector2(580, 42)
	intro.add_theme_font_size_override("font_size", 16)
	body.add_child(intro)

	var url_label := _field_label("Console 地址")
	url_label.position = Vector2(0, 54)
	body.add_child(url_label)
	_console_url = LineEdit.new()
	_console_url.name = "ConsoleUrl"
	_console_url.placeholder_text = "http://127.0.0.1:3000"
	_console_url.position = Vector2(0, 78)
	_console_url.size = Vector2(580, 40)
	_console_url.add_theme_font_size_override("font_size", 17)
	body.add_child(_console_url)

	var key_label := _field_label("平台 API Key")
	key_label.position = Vector2(0, 130)
	body.add_child(key_label)
	var key_row := HBoxContainer.new()
	key_row.position = Vector2(0, 154)
	key_row.size = Vector2(580, 40)
	key_row.add_theme_constant_override("separation", 8)
	body.add_child(key_row)
	_api_key = LineEdit.new()
	_api_key.name = "ApiKey"
	_api_key.secret = true
	_api_key.placeholder_text = "从 Console 复制 API Key"
	_api_key.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_api_key.custom_minimum_size = Vector2(0, 40)
	_api_key.add_theme_font_size_override("font_size", 17)
	key_row.add_child(_api_key)
	_show_key = CheckButton.new()
	_show_key.text = "显示"
	_show_key.toggled.connect(func(show: bool): _api_key.secret = not show)
	key_row.add_child(_show_key)

	_error = Label.new()
	_error.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_error.position = Vector2(0, 206)
	_error.size = Vector2(580, 42)
	_error.add_theme_color_override("font_color", Color("ef8c8c"))
	_error.add_theme_font_size_override("font_size", 15)
	body.add_child(_error)


func _field_label(text_value: String) -> Label:
	var label := Label.new()
	label.text = text_value
	label.add_theme_font_size_override("font_size", 16)
	return label


func _save() -> void:
	_save_button.disabled = true
	_error.text = ""
	var result := normalize_console_url(_console_url.text)
	if not bool(result.get("valid", false)):
		_error.text = String(result.get("error", "Console 地址无效。"))
		_save_button.disabled = false
		return

	var previous_url := AppConfig.console_url
	var previous_key := AppConfig.api_key
	AppConfig.console_url = String(result.get("url", ""))
	# 空值同样写入，便于用户主动清除旧 Key。
	AppConfig.api_key = _api_key.text.strip_edges()
	var write_error := AppConfig.save()
	if write_error != OK:
		AppConfig.console_url = previous_url
		AppConfig.api_key = previous_key
		_error.text = "无法保存设置：%s。请检查应用数据目录是否可写。" % error_string(write_error)
		_save_button.disabled = false
		return
	hide()
	saved.emit()
	_save_button.disabled = false


## 规范化 Console 根地址。支持 localhost、域名、IPv4、方括号 IPv6 和端口。
static func normalize_console_url(raw_value: String) -> Dictionary:
	var value := raw_value.strip_edges()
	if value.is_empty():
		return {"valid": false, "error": "请填写 Console 地址。"}
	if value.contains(" ") or value.contains("\t") or value.contains("\n"):
		return {"valid": false, "error": "Console 地址中不能包含空白字符。"}
	if value.contains("?") or value.contains("#"):
		return {"valid": false, "error": "Console 地址不能包含查询参数或片段。"}
	var scheme_end := value.find("://")
	if scheme_end <= 0:
		return {"valid": false, "error": "Console 地址需以 http:// 或 https:// 开头。"}
	var scheme := value.left(scheme_end).to_lower()
	if scheme != "http" and scheme != "https":
		return {"valid": false, "error": "Console 地址只支持 http 或 https。"}
	var authority_and_path := value.substr(scheme_end + 3)
	if authority_and_path.is_empty() or authority_and_path.begins_with("/"):
		return {"valid": false, "error": "Console 地址缺少主机名。"}
	var authority_end := authority_and_path.find("/")
	var authority := authority_and_path if authority_end < 0 else authority_and_path.left(authority_end)
	var path := "" if authority_end < 0 else authority_and_path.substr(authority_end)
	if authority.contains("@"):
		return {"valid": false, "error": "Console 地址不能包含账户信息。"}
	var host_check := _validate_authority(authority)
	if not bool(host_check.get("valid", false)):
		return host_check
	while path.ends_with("/"):
		path = path.trim_suffix("/")
	return {"valid": true, "url": scheme + "://" + authority + path}


static func _validate_authority(authority: String) -> Dictionary:
	var host := authority
	var port_text := ""
	if authority.begins_with("["):
		var bracket := authority.find("]")
		if bracket < 2:
			return {"valid": false, "error": "IPv6 地址需使用方括号，例如 http://[::1]:3000。"}
		host = authority.substr(1, bracket - 1)
		var remainder := authority.substr(bracket + 1)
		if not remainder.is_empty():
			if not remainder.begins_with(":"):
				return {"valid": false, "error": "IPv6 地址后的端口格式无效。"}
			port_text = remainder.substr(1)
		if not _is_valid_ipv6(host):
			return {"valid": false, "error": "IPv6 地址无效。"}
	else:
		if authority.count(":") > 1:
			return {"valid": false, "error": "IPv6 地址需使用方括号，例如 http://[::1]:3000。"}
		var colon := authority.rfind(":")
		if colon >= 0:
			host = authority.left(colon)
			port_text = authority.substr(colon + 1)
		if not _is_valid_host(host):
			return {"valid": false, "error": "Console 主机名无效。"}
	if not port_text.is_empty():
		if not port_text.is_valid_int():
			return {"valid": false, "error": "端口必须是 1 到 65535 的整数。"}
		var port := int(port_text)
		if port < 1 or port > 65535:
			return {"valid": false, "error": "端口必须在 1 到 65535 之间。"}
	elif authority.ends_with(":"):
		return {"valid": false, "error": "端口不能为空。"}
	return {"valid": true}


static func _is_valid_host(host: String) -> bool:
	if host.is_empty():
		return false
	if _is_valid_ipv4(host):
		return true
	var numeric_or_dots := true
	for character in host:
		if character != "." and not (character >= "0" and character <= "9"):
			numeric_or_dots = false
			break
	if numeric_or_dots:
		return false
	for label in host.split("."):
		if label.is_empty() or label.length() > 63 or label.begins_with("-") or label.ends_with("-"):
			return false
		for character in label:
			if not (character >= "a" and character <= "z") and not (character >= "A" and character <= "Z") and not (character >= "0" and character <= "9") and character != "-":
				return false
	return true


static func _is_valid_ipv4(host: String) -> bool:
	var parts := host.split(".")
	if parts.size() != 4:
		return false
	for part in parts:
		if part.is_empty() or not part.is_valid_int():
			return false
		var octet := int(part)
		if octet < 0 or octet > 255:
			return false
	return true


static func _is_valid_ipv6(host: String) -> bool:
	if host.is_empty() or host.count("::") > 1 or host.contains(":::"):
		return false
	var compressed := host.contains("::")
	if not compressed and (host.begins_with(":") or host.ends_with(":")):
		return false
	var groups := host.split(":", false)
	if compressed:
		if groups.size() > 7:
			return false
	elif groups.size() != 8:
		return false
	for group in groups:
		if group.length() > 4:
			return false
		for character in group:
			if not (character >= "0" and character <= "9") and not (character >= "a" and character <= "f") and not (character >= "A" and character <= "F"):
				return false
	return true
