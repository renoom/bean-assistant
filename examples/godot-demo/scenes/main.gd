extends Control
## 多助手 Stage 主场景。
##
## 形态：
##   - 1 个由用户预先选择的 Stage（背景 + 互动热点 + NPC）
##   - N 个 StageChannelClient（每个一个 assistant 进程），进入 Stage 后再连接
##   - SceneEventBus 聚合并广播事件
##   - 每个在线助手头顶一个气泡；气泡走打字机独立推进
##
## 玩家输入：输入栏打字 → user_said 事件 → 只广播给已完成 NPC 入场的助手
## 助手说话：LLM 调 stage_action 的 say/say_to 指令 → 服务端转发 command → 本端渲染气泡 + 转发给其他助手
## 公开 say：在说话者立绘上方显示气泡 + 把 assistant_intercom 转发给所有**其他**助手 ws
## 私聊 say_to：显示气泡 + 转发给 target ws
##
## 多助手关系由 Godot 路由；每个助手通过独立 StageChannel 接入。
## Bridge 连接与 NPC 入场分离：助手必须先自行生成形象并调用 enter_stage。

const COL_BG := Color("14161d")
const COL_PANEL := Color(0.07, 0.08, 0.11, 0.92)
const COL_TEXT := Color("e8e6e0")
const COL_NAME := Color("7fc4ff")
const COL_DIM := Color(0.62, 0.64, 0.70)
const COL_ERR := Color("ff8a80")
const COL_BUBBLE_BG := Color(0.05, 0.06, 0.09, 0.88)
const COL_BUBBLE_BORDER := Color(1, 1, 1, 0.18)
## 气泡打字完成后停留多少秒自动消失
const BUBBLE_HOLD_SEC := 10.0

const StageScript = preload("res://core/stage/stage.gd")
const StageCatalogScript = preload("res://core/stage/stage_catalog.gd")
const EventBusScript = preload("res://core/scene/event_bus.gd")
const VnClientManagerScript = preload("res://core/scene/vn_client_manager.gd")
const ConsoleApiScript = preload("res://core/transport/console_api.gd")
const ConnectionSettingsScript = preload("res://core/ui/connection_settings.gd")

# 注：上面 4 个 const 是 preload 引用（不依赖 class_name 注册顺序）。
# 但本文件用到的 typed var 直接用 class_name（Stage / SceneEventBus / VnClientManager / StageChannelClient），
# 这要求 class_name 在本脚本解析前已注册。Godot 4 全局类解析按文件名字典序，
# event_bus / stage / vn_channel / vn_client_manager 都以小写字母开头，main.gd 也是。
# 如果遇到 class_name 未注册的循环依赖，启用 const 形式：把类型注解改成 StageScript 等。

## Stage 能力由 StageCatalog 中被选中的场景定义，并由 StageChannel Bridge 上报。

# ── 核心对象 ──
var _stage: Stage
var _bus: SceneEventBus
var _vn_clients: VnClientManager
## 当前 Godot 客户端 clientId（每个 Godot 进程唯一）。用户 ws 用这个 id；助手 ws 用各自动 assistantId。
var _client_id := ""
## 当前 Stage 的静态定义与对助手公开的能力。它们来自场景目录，不来自 Channel。
var _stage_definition: Dictionary = {}
var _stage_commands: Array = []

# ── 节点 ──
var _bg: ColorRect
var _hud: Label
var _toast: Label
var _debug_panel: PanelContainer
var _debug_text: RichTextLabel
## 输入栏区域
var _input_bar: PanelContainer
var _input: LineEdit
var _target_picker: OptionButton
## 「正在响应」提示（输入栏上方）
var _thinking_label: Label
## 「加助手」按钮 + 弹窗（把更多在线助手拉进当前场景）
var _add_btn: Button
var _add_panel: PanelContainer
var _add_list: ItemList
var _add_entries: Array = []
var _add_status: Label
var _console_api: ConsoleApi
var _connection_settings: ConfirmationDialog

## 助手气泡层（assistantId -> BubbleLabel）
var _bubbles: Dictionary = {}
## 助手名映射（assistantId -> 显示名），用于气泡标题
var _assistant_names: Dictionary = {}
## 当前活跃的 turn 数（turn_start +1 / turn_end -1），>0 表示有助手在响应中
var _active_turns := 0

var _toast_until := 0.0
var _debug_lines: PackedStringArray = []


# ══════════════════════════════════════════════════════════════
#  生命周期
# ══════════════════════════════════════════════════════════════

func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_stage_definition = StageCatalogScript.get_stage(AppConfig.stage_id)
	if _stage_definition.is_empty():
		_stage_definition = StageCatalogScript.default_stage()
		AppConfig.stage_id = String(_stage_definition.get("id", "town:ai-meadow"))
		AppConfig.stage_kind = String(_stage_definition.get("kind", "town"))
		AppConfig.stage_name = String(_stage_definition.get("name", "AI 萤火镇"))
	_stage_commands = _stage_definition.get("commands", []).duplicate(true)
	_client_id = _make_client_id()
	# 层叠顺序（后 add_child 的在上层）：
	#   1. _bg 背景色（最底，纯底色兜底）
	#   2. Stage（场景背景图 / 立绘 / 物件）
	#   3. UI（HUD / 输入栏 / 气泡 / 调试面板）
	# 注意 _bg 必须在 Stage 之前建，否则不透明底色会盖住整个场景。
	_build_background()
	_build_scene_pipeline()
	_build_ui()
	_restore_stage()
	_console_api = ConsoleApiScript.new()
	add_child(_console_api)
	_console_api.listed.connect(_on_add_listed)
	_console_api.list_failed.connect(_on_add_failed)

	# Stage 是用户先选定的环境。首次进入时用目录定义初始化，之后按 stageId 恢复。
	if _stage.list_scenes().is_empty():
		_seed_selected_stage()
		_save_stage()
	_set_hud("● %s · 尚未邀请助手（F4）" % AppConfig.stage_name, COL_DIM)

	_input.grab_focus()


func _process(dt: float) -> void:
	if _vn_clients != null:
		_vn_clients.poll()
	_tick_bubbles(dt)
	if _toast.visible and Time.get_ticks_msec() / 1000.0 > _toast_until:
		_toast.visible = false


func _make_client_id() -> String:
	return "godot-" + AppConfig.stage_id.validate_filename()


func _seed_selected_stage() -> void:
	var sid := String(_stage_definition.get("id", AppConfig.stage_id))
	_stage.create_scene(
		sid,
		String(_stage_definition.get("name", AppConfig.stage_name)),
		String(_stage_definition.get("background", "")),
	)
	for object_any in _stage_definition.get("objects", []):
		if typeof(object_any) != TYPE_DICTIONARY:
			continue
		var object: Dictionary = object_any
		_stage.add_object(
			sid,
			String(object.get("id", "")),
			String(object.get("image", "")),
			float(object.get("x", 0.5)),
			float(object.get("y", 0.5)),
			float(object.get("size", 100.0)),
			object.get("actions", {}) if typeof(object.get("actions")) == TYPE_DICTIONARY else {},
			String(object.get("label", object.get("id", ""))),
		)
	_stage.switch_scene(sid)


## 构建事件管线：EventBus + VnClientManager + Stage。
func _build_scene_pipeline() -> void:
	_stage = StageScript.new()
	add_child(_stage)

	_bus = EventBusScript.new()
	add_child(_bus)

	_vn_clients = VnClientManagerScript.new()
	add_child(_vn_clients)
	_vn_clients.setup(
		AppConfig.host if AppConfig.port > 0 else "127.0.0.1",
		AppConfig.port,
		_bus,
		AppConfig.stage_id,
		AppConfig.stage_kind,
	)

	_bus.user_said.connect(_on_user_said_via_bus)
	_bus.command_received.connect(_on_command)
	_bus.assistant_joined.connect(_on_assistant_joined)
	_bus.assistant_left.connect(_on_assistant_left)
	_bus.scene_event.connect(_on_scene_event)
	_bus.llm_event_received.connect(_on_llm_event)

	_stage.interaction.connect(_on_stage_interaction)


## 把一个助手进程接入场景。d = console 条目（sessionId/name/host/port/spritePath）。
func _resolve_ws_target(d: Dictionary) -> Dictionary:
	var ws_path := String(d.get("gatewayWsPath", ""))
	var host := String(d.get("host", ""))
	var port := int(d.get("port", 0))
	var secure := false

	if not ws_path.is_empty():
		var console_url := AppConfig.console_url
		secure = console_url.begins_with("https://")
		var rest := console_url.trim_prefix("https://").trim_prefix("http://")
		var slash := rest.find("/")
		var authority := rest if slash < 0 else rest.left(slash)
		var base_path := "" if slash < 0 else rest.substr(slash).trim_suffix("/")
		port = 443 if secure else 80
		if authority.begins_with("["):
			var bracket := authority.find("]")
			if bracket < 0:
				return {}
			host = authority.left(bracket + 1)
			if authority.substr(bracket + 1).begins_with(":"):
				port = int(authority.substr(bracket + 2))
		else:
			var colon := authority.rfind(":")
			host = authority if colon < 0 else authority.left(colon)
			if colon >= 0:
				port = int(authority.substr(colon + 1))
		ws_path = base_path + ws_path
	else:
		var endpoint := ConsoleApi.stage_endpoint(d)
		if endpoint.is_empty():
			return {}
		host = String(endpoint.get("host", host))
		port = int(endpoint.get("port", port))
		ws_path = String(endpoint.get("path", "/ws"))

	return {"host": host, "port": port, "wsPath": ws_path, "secure": secure}


func _connect_assistant(d: Dictionary) -> void:
	if _vn_clients == null:
		return
	var assistant_id := String(d.get("sessionId", d.get("assistantId", "")))
	if assistant_id.is_empty():
		_show_toast("助手缺少 sessionId")
		return
	if _vn_clients.has_assistant(assistant_id):
		return
	var target := _resolve_ws_target(d)
	if target.is_empty() or int(target.get("port", 0)) <= 0:
		_show_toast("助手未提供可用的 StageChannel 端点")
		return
	var c := _vn_clients.connect_assistant({
		"assistantId": assistant_id,
		"name": String(d.get("name", "助手")),
		"spritePath": String(d.get("spritePath", "")),
		"host": String(target.get("host", "")),
		"port": int(target.get("port", 0)),
		"wsPath": String(target.get("wsPath", "/ws")),
		"secure": bool(target.get("secure", false)),
		"commands": _stage_commands,
		"environment": StageCatalogScript.environment_for(_stage_definition),
	})
	if c == null:
		_show_toast("连接助手 %s 失败" % assistant_id)
		return
	# Bridge 连上不等于 NPC 已入场。首次加入必须由助手自己生成形象并调用 enter_stage；
	# 已在这个 Stage 留有形象的助手重连时可以恢复原 NPC。
	c.connected.connect(func(): _on_assistant_bridge_ready(c, assistant_id, String(d.get("name", "助手"))))
	c.disconnected.connect(func(r: String): _push_debug("[vn/%s] 断开: %s" % [assistant_id, r]))


func _on_assistant_bridge_ready(c: StageChannelClient, assistant_id: String, display_name: String) -> void:
	_push_debug("[stage/%s] Bridge 已连接，等待 NPC 入场: %s" % [AppConfig.stage_id, assistant_id])
	var existing := _stage.get_assistant_meta(_stage.current_scene_id(), assistant_id)
	if not existing.is_empty() and (not String(existing.get("animationPath", "")).is_empty() or not String(existing.get("spritePath", "")).is_empty()):
		_stage.set_assistant_present(assistant_id, true)
		_save_stage()
		c.send_event({
			"kind": "stage_reentered",
			"stageId": AppConfig.stage_id,
			"stageName": AppConfig.stage_name,
			"message": "你已恢复此前在这个场景中的 NPC 形象，可以继续行动。",
		})
		return
	c.send_event({
		"kind": "stage_join_requested",
		"stageId": AppConfig.stage_id,
		"stageName": AppConfig.stage_name,
		"assistantId": assistant_id,
		"assistantName": display_name,
		"instruction": String(_stage_definition.get("join_instruction", "请先生成 NPC 形象并调用 enter_stage。")),
		"requiredCommand": "enter_stage",
	})


# ══════════════════════════════════════════════════════════════
#  UI 构建
# ══════════════════════════════════════════════════════════════

## 纯底色兜底（最底层）。必须在 Stage 之前 add_child，否则会盖住场景。
func _build_background() -> void:
	_bg = ColorRect.new()
	_bg.color = COL_BG
	_bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_bg)


func _build_ui() -> void:
	# ── HUD ──
	_hud = Label.new()
	_hud.set_anchors_and_offsets_preset(Control.PRESET_TOP_RIGHT)
	_hud.offset_left = -420
	_hud.offset_right = -16
	_hud.offset_top = 12
	_hud.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_hud.add_theme_font_size_override("font_size", 13)
	_hud.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_hud)

	# ── 吐司 ──
	_toast = Label.new()
	_toast.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
	_toast.offset_left = 40
	_toast.offset_right = -40
	_toast.offset_top = 44
	_toast.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_toast.add_theme_color_override("font_color", COL_ERR)
	_toast.add_theme_font_size_override("font_size", 15)
	_toast.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_toast.visible = false
	add_child(_toast)

	# ── 输入栏（含目标选择）──
	_input_bar = PanelContainer.new()
	_input_bar.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE)
	_input_bar.offset_left = 40
	_input_bar.offset_right = -40
	_input_bar.offset_top = -82
	_input_bar.offset_bottom = -22
	_input_bar.add_theme_stylebox_override("panel", _panel_style(0.7))
	_input_bar.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_input_bar)

	var hbox := HBoxContainer.new()
	hbox.add_theme_constant_override("separation", 8)
	hbox.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_input_bar.add_child(hbox)

	_target_picker = OptionButton.new()
	_target_picker.add_item("📢 所有人")
	_target_picker.set_item_metadata(0, "__all__")
	_target_picker.add_item("👤 仅玩家")
	_target_picker.set_item_metadata(1, "__user__")
	_target_picker.select(0)
	_target_picker.add_theme_font_size_override("font_size", AppConfig.font_size - 2)
	hbox.add_child(_target_picker)

	_input = LineEdit.new()
	_input.placeholder_text = "说点什么…（Enter 发送 · Tab 切目标 · F3 调试 · F4 加助手）"
	_input.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_input.add_theme_font_size_override("font_size", AppConfig.font_size - 2)
	_input.text_submitted.connect(_on_submit)
	hbox.add_child(_input)

	_add_btn = Button.new()
	_add_btn.text = "➕ 加助手"
	_add_btn.add_theme_font_size_override("font_size", AppConfig.font_size - 2)
	_add_btn.pressed.connect(_open_add_panel)
	hbox.add_child(_add_btn)
	var settings_btn := Button.new()
	settings_btn.text = "连接设置"
	settings_btn.tooltip_text = "Console 地址与 API Key（F5）"
	settings_btn.add_theme_font_size_override("font_size", AppConfig.font_size - 2)
	settings_btn.pressed.connect(_open_connection_settings)
	hbox.add_child(settings_btn)

	# ── 「正在响应」提示（输入栏上方，默认隐藏）──
	_thinking_label = Label.new()
	_thinking_label.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE)
	_thinking_label.offset_left = 40
	_thinking_label.offset_right = -40
	_thinking_label.offset_top = -104
	_thinking_label.offset_bottom = -88
	_thinking_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
	_thinking_label.add_theme_color_override("font_color", COL_DIM)
	_thinking_label.add_theme_font_size_override("font_size", AppConfig.font_size - 3)
	_thinking_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_thinking_label.visible = false
	add_child(_thinking_label)

	# ── 调试面板 ──
	_debug_panel = PanelContainer.new()
	_debug_panel.set_anchors_and_offsets_preset(Control.PRESET_RIGHT_WIDE)
	_debug_panel.offset_left = -520
	_debug_panel.offset_right = -8
	_debug_panel.offset_top = 40
	_debug_panel.offset_bottom = -120
	_debug_panel.add_theme_stylebox_override("panel", _panel_style(0.95))
	_debug_panel.visible = AppConfig.debug_overlay
	add_child(_debug_panel)

	var dvb := VBoxContainer.new()
	_debug_panel.add_child(dvb)
	var dtitle := Label.new()
	dtitle.text = "原始事件流（含被丢弃的思考与工具）"
	dtitle.add_theme_color_override("font_color", COL_DIM)
	dtitle.add_theme_font_size_override("font_size", 12)
	dvb.add_child(dtitle)
	_debug_text = RichTextLabel.new()
	_debug_text.bbcode_enabled = false
	_debug_text.scroll_active = true
	_debug_text.scroll_following = true
	_debug_text.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_debug_text.add_theme_color_override("default_color", COL_DIM)
	_debug_text.add_theme_font_size_override("normal_font_size", 11)
	dvb.add_child(_debug_text)

	_build_add_panel()
	_connection_settings = ConnectionSettingsScript.new()
	add_child(_connection_settings)
	_connection_settings.saved.connect(_on_connection_saved)


## 「加助手」弹窗：列出 console 里在线、且不在当前场景的助手，供玩家逐个拉进来。
func _build_add_panel() -> void:
	_add_panel = PanelContainer.new()
	_add_panel.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	_add_panel.offset_left = -260
	_add_panel.offset_right = 260
	_add_panel.offset_top = -240
	_add_panel.offset_bottom = 240
	_add_panel.add_theme_stylebox_override("panel", _panel_style(1.0))
	_add_panel.visible = false
	add_child(_add_panel)

	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 10)
	_add_panel.add_child(v)

	var t := Label.new()
	t.text = "添加助手进场景"
	t.add_theme_color_override("font_color", COL_TEXT)
	t.add_theme_font_size_override("font_size", 17)
	v.add_child(t)
	_add_status = Label.new()
	_add_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_add_status.add_theme_color_override("font_color", COL_DIM)
	_add_status.custom_minimum_size = Vector2(0, 56)
	v.add_child(_add_status)

	_add_list = ItemList.new()
	_add_list.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_add_list.custom_minimum_size = Vector2(0, 260)
	_add_list.add_theme_font_size_override("font_size", 15)
	_add_list.item_activated.connect(_on_add_activated)
	v.add_child(_add_list)

	var actions := HBoxContainer.new()
	v.add_child(actions)
	var refresh := Button.new()
	refresh.text = "刷新"
	refresh.pressed.connect(_open_add_panel)
	actions.add_child(refresh)
	var settings := Button.new()
	settings.text = "连接设置"
	settings.pressed.connect(_open_connection_settings)
	actions.add_child(settings)
	var invite := Button.new()
	invite.text = "邀请选中助手"
	invite.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	invite.pressed.connect(func():
		var selected := _add_list.get_selected_items()
		if not selected.is_empty():
			_on_add_activated(selected[0])
	)
	actions.add_child(invite)
	var close := Button.new()
	close.text = "取消"
	close.pressed.connect(func(): _add_panel.visible = false; _input.grab_focus())
	actions.add_child(close)


## 打开「加助手」弹窗并查询 console。
func _open_add_panel() -> void:
	if _add_panel == null or _console_api == null:
		return
	_add_panel.visible = true
	_add_list.clear()
	_add_entries = []
	_add_list.grab_focus()
	_set_hud("正在查询在线助手…", COL_DIM)
	_add_status.text = "正在查询 %s 的在线助手…" % AppConfig.console_url
	_add_status.add_theme_color_override("font_color", COL_DIM)
	_console_api.list()


func _on_add_listed(entries: Array) -> void:
	_add_entries = []
	_add_list.clear()
	var online_count := 0
	var stage_count := 0
	for item in entries:
		if typeof(item) != TYPE_DICTIONARY:
			continue
		var d: Dictionary = item
		if String(d.get("status", "")) != "online":
			continue
		online_count += 1
		if not ConsoleApi.has_ws(d):
			continue
		stage_count += 1
		var aid := String(d.get("sessionId", ""))
		if aid.is_empty() or (_vn_clients != null and _vn_clients.has_assistant(aid)):
			continue
		_add_entries.append(d)
		_add_list.add_item(String(d.get("name", "助手")))
	var message: String
	if not _add_entries.is_empty():
		message = "找到 %d 个可邀请的助手，选中后点击邀请或双击。" % _add_entries.size()
		_add_list.select(0)
	elif online_count == 0:
		message = "没有在线助手，请先在 Console 启动助手，再点击刷新。"
	elif stage_count == 0:
		message = "在线助手未启用 StageChannel，请在 Console 启用后重启助手。"
	else:
		message = "支持 StageChannel 的在线助手已全部加入当前场景。"
	_add_status.text = message
	_add_status.add_theme_color_override("font_color", COL_DIM)
	_set_hud(message, COL_DIM)


func _on_add_failed(reason: String) -> void:
	_add_entries = []
	_add_list.clear()
	_add_status.text = reason
	_add_status.add_theme_color_override("font_color", COL_ERR)
	_set_hud("助手列表获取失败", COL_ERR)
	if _console_api.last_list_status == 401 and _add_panel.visible:
		_open_connection_settings()


func _open_connection_settings() -> void:
	if _connection_settings != null and not _connection_settings.visible:
		_connection_settings.open()


func _on_connection_saved() -> void:
	_open_add_panel()


## 双击/回车选中一个在线助手 → 拉进当前场景
func _on_add_activated(idx: int) -> void:
	if idx < 0 or idx >= _add_entries.size():
		return
	var d: Dictionary = _add_entries[idx]
	_connect_assistant(d)
	_add_panel.visible = false
	_add_list.clear()
	_add_entries = []
	_input.grab_focus()


func _panel_style(alpha_mul: float = 1.0) -> StyleBoxFlat:
	var sb := StyleBoxFlat.new()
	var c := COL_PANEL
	c.a = clampf(c.a * alpha_mul, 0.0, 1.0)
	sb.bg_color = c
	sb.border_color = Color(1, 1, 1, 0.10)
	sb.set_border_width_all(1)
	sb.set_corner_radius_all(10)
	sb.set_content_margin_all(8)
	return sb


func _set_hud(t: String, c: Color) -> void:
	_hud.text = t
	_hud.add_theme_color_override("font_color", c)


func _show_toast(msg: String) -> void:
	_toast.text = "⚠ " + msg
	_toast.visible = true
	_toast_until = Time.get_ticks_msec() / 1000.0 + 6.0


func _push_debug(line: String) -> void:
	_debug_lines.append(line)
	if _debug_lines.size() > 400:
		_debug_lines = _debug_lines.slice(_debug_lines.size() - 400)
	if _debug_text != null:
		_debug_text.text = "\n".join(_debug_lines)


# ══════════════════════════════════════════════════════════════
#  气泡（BubbleLabel 是个小 PanelContainer）
# ══════════════════════════════════════════════════════════════

class BubbleLabel extends PanelContainer:
	var assistant_id := ""
	var title_label: Label
	var body_label: RichTextLabel
	var full := ""
	var revealed := 0.0
	var done := false
	var hold := 0.0   # 打字完成后已停留的秒数（用于自动消失）

	func _init() -> void:
		mouse_filter = Control.MOUSE_FILTER_IGNORE
		var sb := StyleBoxFlat.new()
		sb.bg_color = COL_BUBBLE_BG
		sb.border_color = COL_BUBBLE_BORDER
		sb.set_border_width_all(1)
		sb.set_corner_radius_all(8)
		sb.set_content_margin_all(8)
		add_theme_stylebox_override("panel", sb)
		var vb := VBoxContainer.new()
		vb.add_theme_constant_override("separation", 2)
		vb.mouse_filter = Control.MOUSE_FILTER_IGNORE
		add_child(vb)
		title_label = Label.new()
		title_label.add_theme_color_override("font_color", COL_NAME)
		title_label.add_theme_font_size_override("font_size", AppConfig.font_size - 4)
		title_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
		vb.add_child(title_label)
		body_label = RichTextLabel.new()
		body_label.bbcode_enabled = false
		body_label.fit_content = true
		body_label.scroll_active = false
		body_label.custom_minimum_size = Vector2(280, 0)
		body_label.add_theme_color_override("default_color", COL_TEXT)
		body_label.add_theme_font_size_override("normal_font_size", AppConfig.font_size - 2)
		body_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
		vb.add_child(body_label)

	func set_message(name_: String, text: String) -> void:
		title_label.text = name_
		full = text
		revealed = 0.0
		done = false
		hold = 0.0
		body_label.text = text
		body_label.visible_characters = 0

	func tick(dt: float) -> void:
		if done:
			hold += dt
			return
		var total := float(full.length())
		if revealed < total:
			if AppConfig.text_cps <= 0.0:
				revealed = total
			else:
				revealed = minf(total, revealed + AppConfig.text_cps * dt)
			body_label.visible_characters = int(revealed)
		if revealed >= total:
			done = true


## 把气泡放到对应助手立绘正上方
func _place_bubble(b: BubbleLabel) -> void:
	if b == null:
		return
	var sprite := _stage.get_assistant_sprite(b.assistant_id)
	var anchor := Vector2(0.5, 0.0)
	var top_y := 0.0
	if sprite != null:
		anchor = Vector2((sprite.anchor_left + sprite.anchor_right) / 2.0, sprite.anchor_top)
		top_y = anchor.y * _stage.size.y - sprite.get_size().y * 0.5
	# 等 1 帧让 bubble 拿到自己的尺寸
	b.set_anchors_and_offsets_preset(Control.PRESET_TOP_LEFT)
	b.pivot_offset = Vector2(b.size.x / 2.0, b.size.y)
	var cx := anchor.x * _stage.size.x
	var bx := clampf(cx - b.size.x / 2.0, 8.0, _stage.size.x - b.size.x - 8.0)
	var by := clampf(top_y - b.size.y - 12.0, 8.0, _stage.size.y - 200.0)
	b.position = Vector2(bx, by)


func _tick_bubbles(dt: float) -> void:
	for aid in _bubbles.keys():
		var b: BubbleLabel = _bubbles[aid]
		if b == null:
			continue
		b.tick(dt)
		if b.done and b.hold > BUBBLE_HOLD_SEC:
			_remove_bubble(aid)


## 在某个助手头顶显示一条新气泡
func _show_bubble(assistant_id: String, name_: String, text: String) -> void:
	var b: BubbleLabel = _bubbles.get(assistant_id)
	if b == null:
		b = BubbleLabel.new()
		b.assistant_id = assistant_id
		add_child(b)
		_bubbles[assistant_id] = b
	b.set_message(name_, text)
	# 等一帧布局后定位
	call_deferred("_place_bubble", b)


func _remove_bubble(assistant_id: String) -> void:
	var b: BubbleLabel = _bubbles.get(assistant_id)
	if b != null:
		b.queue_free()
		_bubbles.erase(assistant_id)


# ══════════════════════════════════════════════════════════════
#  EventBus 回调
# ══════════════════════════════════════════════════════════════

## 服务端推来的 LLM 完整事件流（chunk / assistant_message / tool_call / tool_result …）。
## 只进调试面板，不渲染；但用 turn_start / turn_end 驱动「正在响应」提示。
func _on_llm_event(ev: Dictionary, from_ws_id: String) -> void:
	var t := String(ev.get("type", "?"))
	var data: Dictionary = ev.get("data", {}) if typeof(ev.get("data")) == TYPE_DICTIONARY else {}
	var extra := ""
	match t:
		"turn_start":
			_active_turns += 1
			_update_thinking()
		"turn_end":
			_active_turns = maxi(0, _active_turns - 1)
			_update_thinking()
		"chunk":
			extra = " kind=%s len=%d" % [data.get("kind", "?"), String(data.get("text", "")).length()]
		"tool_call", "tool_result":
			extra = " name=%s" % data.get("name", "?")
		"assistant_message":
			extra = " turn=%s" % data.get("turn", "?")
	_push_debug("[llm/%s] %s%s" % [from_ws_id, t, extra])


## 有活跃 turn 时在输入栏上方显示「正在响应…」
func _update_thinking() -> void:
	if _thinking_label == null:
		return
	if _active_turns > 0:
		_thinking_label.text = "● 助手正在响应…"
		_thinking_label.visible = true
	else:
		_thinking_label.visible = false


## 用户说话：已经在 _on_submit 里发到 bus，这里主要给调试。
func _on_user_said_via_bus(text: String, target: String) -> void:
	_push_debug("[user] → %s: %s" % [target if not target.is_empty() else "所有人", text])


## ws 推来的 command（来自某个 assistant 的 LLM 调了 stage_action）。
func _on_command(cmd: Dictionary) -> void:
	var command_id := String(cmd.get("commandId", ""))
	var name := String(cmd.get("command", ""))
	var args: Dictionary = cmd.get("args", {}) if typeof(cmd.get("args")) == TYPE_DICTIONARY else {}
	var from_ws_id := String(cmd.get("fromWsId", ""))
	var result := _execute_command(name, args, from_ws_id)
	# 回执发回给原 ws
	var c := _vn_clients.get_client(from_ws_id) if from_ws_id != "user" else _vn_clients.user_ws()
	if c != null:
		c.send_result(command_id, bool(result.get("ok", false)), result.get("result", null), String(result.get("error", "")))
	_push_debug("[vn/%s] %s → %s" % [from_ws_id, name, "ok" if bool(result.get("ok", false)) else "fail: " + String(result.get("error", ""))])


func _on_assistant_joined(meta: Dictionary) -> void:
	var aid := String(meta.get("assistantId", ""))
	var nm := String(meta.get("name", aid))
	if not aid.is_empty():
		_assistant_names[aid] = nm
	# 更新目标下拉
	_add_target_option(aid, nm)
	_set_hud("◌ %s 已连接，正在准备自己的 NPC 形象…" % nm, COL_DIM)
	_push_debug("[vn] Bridge 已就绪，等待 enter_stage: %s" % aid)


func _on_assistant_left(assistant_id: String) -> void:
	if assistant_id.is_empty() or assistant_id == "user":
		_push_debug("[vn] 用户 ws 断开")
		return
	_remove_bubble(assistant_id)
	_assistant_names.erase(assistant_id)
	_remove_target_option(assistant_id)
	# 助手下线 → 标记不在场，立绘从场景里移除（身份仍保留在存档，重连可恢复）
	if _stage != null:
		_stage.set_assistant_present(assistant_id, false)
	_push_debug("[vn] 助手下线: %s" % assistant_id)


func _on_scene_event(scene_id: String, kind: String, payload: Dictionary) -> void:
	# 此处不进 LLM（CurrentStage 已做来源判定），只调试
	_push_debug("[scene] %s/%s %s" % [scene_id, kind, JSON.stringify(payload)])


func _add_target_option(assistant_id: String, name_: String) -> void:
	# 避免重复
	for i in _target_picker.item_count:
		if _target_picker.get_item_metadata(i) == assistant_id:
			return
	_target_picker.add_item("🎭 " + name_)
	_target_picker.set_item_metadata(_target_picker.item_count - 1, assistant_id)


func _remove_target_option(assistant_id: String) -> void:
	for i in _target_picker.item_count:
		if _target_picker.get_item_metadata(i) == assistant_id:
			_target_picker.remove_item(i)
			return


# ══════════════════════════════════════════════════════════════
#  Stage 能力执行（每个 ws 都共享场景定义；assistantId 来源 = cmd.fromWsId）
# ══════════════════════════════════════════════════════════════

func _execute_command(name: String, args: Dictionary, from_ws_id: String) -> Dictionary:
	var supported := false
	for spec_any in _stage_commands:
		var spec: Dictionary = spec_any
		if String(spec.get("name", "")) == name:
			supported = true
			break
	if not supported:
		return {"ok": false, "error": "unknown command: " + name}
	match name:
		"enter_stage":
			if from_ws_id.is_empty() or from_ws_id == "user":
				return {"ok": false, "error": "只有助手 Bridge 可以创建 NPC"}
			var animation := String(args.get("animation", "")).strip_edges()
			var image := String(args.get("image", "")).strip_edges() # 兼容旧 Stage 客户端
			if animation.is_empty() and image.is_empty():
				return {"ok": false, "error": "enter_stage 需要 draw_sprite_animation 返回的 metadataPath，并作为 animation 传入"}
			var npc_name := String(args.get("name", "")).strip_edges()
			if npc_name.is_empty():
				npc_name = _assistant_names.get(from_ws_id, from_ws_id)
			var profession := String(args.get("profession", "镇民")).strip_edges()
			_stage.add_assistant(_stage.current_scene_id(), from_ws_id, npc_name, image,
				float(args.get("x", 0.5)), float(args.get("y", 0.68)), profession, animation)
			var appearance_error := _stage.set_assistant_animation(_stage.current_scene_id(), from_ws_id, animation) if not animation.is_empty() else _stage.set_assistant_sprite(_stage.current_scene_id(), from_ws_id, image)
			if not appearance_error.is_empty():
				_stage.remove_assistant(_stage.current_scene_id(), from_ws_id)
				return {"ok": false, "error": appearance_error}
			_assistant_names[from_ws_id] = npc_name
			_save_stage()
			_broadcast_to_present({
				"kind": "assistant_entered",
				"assistantId": from_ws_id,
				"name": npc_name,
				"profession": profession,
			}, from_ws_id)
			var introduction := String(args.get("introduction", "")).strip_edges()
			if not introduction.is_empty():
				_speak(from_ws_id, "", introduction)
			_set_hud("● %s 已作为「%s」进入 %s" % [npc_name, profession, AppConfig.stage_name], Color("8fd694"))
			return {"ok": true, "result": {"assistantId": from_ws_id, "name": npc_name, "profession": profession}}
		"get_stage_state":
			return {"ok": true, "result": {"stage": _stage.get_scene(_stage.current_scene_id())}}
		"move_npc":
			var presence_error := _require_present(from_ws_id)
			if not presence_error.is_empty():
				return {"ok": false, "error": presence_error}
			var place_id := String(args.get("placeId", "")).strip_edges()
			var nx := float(args.get("x", 0.5))
			var ny := float(args.get("y", 0.68))
			if not place_id.is_empty():
				var place := _stage.get_object(_stage.current_scene_id(), place_id)
				if place.is_empty():
					return {"ok": false, "error": "场景地点不存在: " + place_id}
				nx = float(place.get("x", nx))
				ny = minf(0.78, float(place.get("y", ny)) + 0.10)
			_stage.move_assistant(_stage.current_scene_id(), from_ws_id, nx, ny)
			_save_stage()
			return {"ok": true, "result": {"x": nx, "y": ny, "placeId": place_id}}
		"interact_at":
			var presence_error := _require_present(from_ws_id)
			if not presence_error.is_empty():
				return {"ok": false, "error": presence_error}
			var place_id := String(args.get("placeId", "")).strip_edges()
			var action := String(args.get("action", "")).strip_edges()
			if place_id.is_empty() or action.is_empty():
				return {"ok": false, "error": "interact_at 需要 placeId 和 action"}
			var place := _stage.get_object(_stage.current_scene_id(), place_id)
			if place.is_empty():
				return {"ok": false, "error": "场景地点不存在: " + place_id}
			var ix := float(place.get("x", 0.5))
			var iy := minf(0.78, float(place.get("y", 0.6)) + 0.10)
			_stage.move_assistant(_stage.current_scene_id(), from_ws_id, ix, iy)
			var event := {
				"kind": "assistant_interacted",
				"from": from_ws_id,
				"placeId": place_id,
				"place": String(place.get("label", place_id)),
				"action": action,
				"description": String(args.get("description", "")),
			}
			_broadcast_to_present(event, from_ws_id)
			_show_bubble(from_ws_id, _resolve_name(from_ws_id), "在%s：%s" % [event["place"], action])
			_save_stage()
			return {"ok": true, "result": {"placeId": place_id, "action": action}}
		"change_npc_appearance":
			var presence_error := _require_present(from_ws_id)
			if not presence_error.is_empty():
				return {"ok": false, "error": presence_error}
			var animation := String(args.get("animation", "")).strip_edges()
			if animation.is_empty():
				return {"ok": false, "error": "change_npc_appearance 需要 draw_sprite_animation 返回的 metadataPath"}
			var appearance_error := _stage.set_assistant_animation(_stage.current_scene_id(), from_ws_id, animation)
			if not appearance_error.is_empty():
				return {"ok": false, "error": appearance_error}
			_save_stage()
			return {"ok": true, "result": {}}
		"leave_stage":
			var presence_error := _require_present(from_ws_id)
			if not presence_error.is_empty():
				return {"ok": false, "error": presence_error}
			_stage.remove_assistant(_stage.current_scene_id(), from_ws_id)
			_save_stage()
			_broadcast_to_present({"kind": "assistant_left_stage", "assistantId": from_ws_id}, from_ws_id)
			return {"ok": true, "result": {}}
		"say":
			var presence_error := _require_present(from_ws_id)
			if not presence_error.is_empty():
				return {"ok": false, "error": presence_error}
			var text := String(args.get("text", "")).strip_edges()
			if text.is_empty():
				return {"ok": false, "error": "say 需要 text"}
			_speak(from_ws_id, "", text)
			return {"ok": true, "result": {}}
		"say_to":
			var presence_error := _require_present(from_ws_id)
			if not presence_error.is_empty():
				return {"ok": false, "error": presence_error}
			var text2 := String(args.get("text", "")).strip_edges()
			if text2.is_empty():
				return {"ok": false, "error": "say_to 需要 text"}
			var target := String(args.get("target", ""))
			if target.is_empty():
				target = "user"
			_speak(from_ws_id, target, text2)
			return {"ok": true, "result": {}}
		_:
			return {"ok": false, "error": "unknown command: " + name}


func _require_present(assistant_id: String) -> String:
	if assistant_id.is_empty() or assistant_id == "user":
		return "缺少助手身份"
	if not _stage.list_assistants().has(assistant_id):
		return "你的 NPC 尚未入场，请先用 draw_sprite_animation 生成序列帧并调用 enter_stage"
	return ""


func _broadcast_to_present(event: Dictionary, exclude_id: String = "") -> void:
	if _vn_clients == null or _stage == null:
		return
	for assistant_id_any in _stage.list_assistants():
		var assistant_id := String(assistant_id_any)
		if assistant_id == exclude_id:
			continue
		_vn_clients.send_event_to(assistant_id, event)


## 助手「说出口」：渲染气泡 + 把内容转发给应听到的助手。
## speaker_id = 说话者 assistantId（fromWsId）；target 空 = 公开广播；target=某 assistantId = 私聊；target='user' = 仅玩家。
func _speak(speaker_id: String, target: String, text: String) -> void:
	var nm: String = _resolve_name(speaker_id)
	# say_to：在对话内容前标出目标（对玩家 / 对某助手）
	var display_text := text
	if not target.is_empty():
		var target_name := "玩家" if target == "user" else _resolve_name(target)
		display_text = "对%s说：%s" % [target_name, text]
	_show_bubble(speaker_id, nm, display_text)
	_push_debug("[say] %s%s: %s" % [speaker_id, (" → " + target) if not target.is_empty() else "", text])
	if _vn_clients == null:
		return
	# 助手说话 = 场景事件，广播给其他助手（排除说话者自己）；私聊则定向 target。
	var event := { "kind": "assistant_said", "from": speaker_id, "text": text }
	if target.is_empty():
		_broadcast_to_present(event, speaker_id)
	elif target != "user":
		_vn_clients.send_event_to(target, event)
	# target == "user" → 仅玩家可见，不上行任何 ws


## 解析助手显示名：优先 _assistant_names，再查 stage meta，最后退回 assistantId。
func _resolve_name(assistant_id: String) -> String:
	var n: String = _assistant_names.get(assistant_id, "")
	if not n.is_empty():
		return n
	if _stage != null:
		var meta := _stage.get_assistant_meta(_stage.current_scene_id(), assistant_id)
		if not meta.is_empty():
			n = String(meta.get("name", ""))
			if not n.is_empty():
				return n
	return assistant_id


# ══════════════════════════════════════════════════════════════
#  互动（用户对物件/助手的操作）
# ══════════════════════════════════════════════════════════════

func _on_stage_interaction(kind: String, data: Dictionary) -> void:
	var event := data.duplicate()
	event["kind"] = kind
	event["actor"] = "user"
	event["operator"] = AppConfig.user_name
	_save_stage()
	# 只广播给已经完成 NPC 入场的助手；仅建立 Bridge 的助手还不属于画面。
	_broadcast_to_present(event)
	_push_debug("[stage] %s → %s" % [kind, JSON.stringify(event)])


# ══════════════════════════════════════════════════════════════
#  输入
# ══════════════════════════════════════════════════════════════

func _on_submit(text: String) -> void:
	var t := text.strip_edges()
	if t.is_empty():
		return
	_input.clear()
	# 决定目标
	var sel := _target_picker.get_selected()
	var meta: Variant = _target_picker.get_item_metadata(sel)
	var target := ""
	if meta != null:
		var m := String(meta)
		if m == "__all__":
			target = ""
		elif m == "__user__":
			target = "user"
		else:
			target = m
	# target 空 = 广播给所有已入场 NPC；非空 = 定向某助手
	if _vn_clients != null:
		var event := { "kind": "user_said", "text": t }
		if target.is_empty():
			_broadcast_to_present(event)
		elif target != "user":
			_vn_clients.send_event_to(target, event)
		# target == "user" 对玩家输入无意义（玩家就是说话人），不上行
	_push_debug("[user] → %s: %s" % [target if not target.is_empty() else "所有人", t])


func _gui_input(e: InputEvent) -> void:
	# Stage 上点击翻页 / 关闭气泡等通用 UI 行为留空（多助手 UI 由气泡自己管）
	pass


func _unhandled_input(e: InputEvent) -> void:
	if not (e is InputEventKey) or not e.pressed or e.echo:
		return
	var k: InputEventKey = e
	match k.keycode:
		KEY_F2:
			get_tree().change_scene_to_file("res://scenes/picker.tscn")
		KEY_F3:
			_debug_panel.visible = not _debug_panel.visible
		KEY_F4:
			_open_add_panel()
		KEY_F5:
			_open_connection_settings()
		KEY_TAB:
			# 切目标：所有人 → 玩家 → 助手1 → 助手2 → ...
			_target_picker.select((_target_picker.selected + 1) % maxi(1, _target_picker.item_count))
			_input.grab_focus()


# ══════════════════════════════════════════════════════════════
#  持久化
# ══════════════════════════════════════════════════════════════

func _restore_stage() -> void:
	if AppConfig.stage_id.is_empty() or _stage == null:
		return
	var data := StageStore.load_for(AppConfig.stage_id)
	if not data.is_empty():
		_stage.restore(data)
		# 把已恢复的助手同步到 _assistant_names
		for aid in _stage.list_assistants():
			var m := _stage.get_assistant_meta(_stage.current_scene_id(), aid)
			var nm := String(m.get("name", ""))
			if not nm.is_empty():
				_assistant_names[aid] = nm
				_add_target_option(aid, nm)
		_push_debug("[stage] 已恢复舞台状态")


func _save_stage() -> void:
	if AppConfig.stage_id.is_empty() or _stage == null:
		return
	StageStore.save_for(AppConfig.stage_id, _stage.snapshot())
