extends Control
## Stage 选择页。
##
## 启动顺序固定为：选择 Stage → 进入环境 → 在环境内添加助手。
## 这里不查询 Console，也不选择助手，避免把通信对象和场景生命周期绑在一起。

const StageCatalogScript = preload("res://core/stage/stage_catalog.gd")
const SettingsScript = preload("res://core/ui/connection_settings.gd")

const COL_BG := Color("101821")
const COL_PANEL := Color(0.06, 0.09, 0.12, 0.96)
const COL_TEXT := Color("f4eedf")
const COL_DIM := Color("9ca7ad")
const COL_ACCENT := Color("f0c76b")

var _stages: Array = []
var _selected := 0
var _list: ItemList
var _preview: TextureRect
var _preview_empty: Label
var _name: Label
var _description: RichTextLabel
var _enter: Button
var _connection_settings: ConfirmationDialog


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_stages = StageCatalogScript.all()
	_build_ui()
	_connection_settings = SettingsScript.new()
	add_child(_connection_settings)
	for stage_any in _stages:
		var stage: Dictionary = stage_any
		_list.add_item(String(stage.get("name", "未命名场景")))
	if not _stages.is_empty():
		_list.select(0)
		_show_stage(0)


func _build_ui() -> void:
	var bg := ColorRect.new()
	bg.color = COL_BG
	bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(bg)

	var root := VBoxContainer.new()
	root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.offset_left = 42
	root.offset_right = -42
	root.offset_top = 30
	root.offset_bottom = -28
	root.add_theme_constant_override("separation", 14)
	add_child(root)

	var title := Label.new()
	title.text = "选择要进入的场景"
	title.add_theme_color_override("font_color", COL_TEXT)
	title.add_theme_font_size_override("font_size", 28)
	root.add_child(title)

	var subtitle := Label.new()
	subtitle.text = "进入场景之后，再把在线助手邀请进来。场景负责提供互动能力。"
	subtitle.add_theme_color_override("font_color", COL_DIM)
	subtitle.add_theme_font_size_override("font_size", 15)
	root.add_child(subtitle)

	var split := HBoxContainer.new()
	split.size_flags_vertical = Control.SIZE_EXPAND_FILL
	split.add_theme_constant_override("separation", 18)
	root.add_child(split)

	var left := PanelContainer.new()
	left.custom_minimum_size = Vector2(290, 0)
	left.add_theme_stylebox_override("panel", _panel_style())
	split.add_child(left)
	_list = ItemList.new()
	_list.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_list.add_theme_font_size_override("font_size", 18)
	_list.item_selected.connect(_show_stage)
	_list.item_activated.connect(func(_idx): _enter_stage())
	left.add_child(_list)

	var right := PanelContainer.new()
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	right.add_theme_stylebox_override("panel", _panel_style())
	split.add_child(right)
	var rv := VBoxContainer.new()
	rv.add_theme_constant_override("separation", 10)
	right.add_child(rv)

	_name = Label.new()
	_name.add_theme_color_override("font_color", COL_ACCENT)
	_name.add_theme_font_size_override("font_size", 21)
	rv.add_child(_name)

	var preview_box := Control.new()
	preview_box.size_flags_vertical = Control.SIZE_EXPAND_FILL
	preview_box.custom_minimum_size = Vector2(640, 360)
	rv.add_child(preview_box)
	_preview = TextureRect.new()
	_preview.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_preview.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_preview.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	_preview.mouse_filter = Control.MOUSE_FILTER_IGNORE
	preview_box.add_child(_preview)
	_preview_empty = Label.new()
	_preview_empty.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_preview_empty.text = "空白舞台"
	_preview_empty.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_preview_empty.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_preview_empty.add_theme_color_override("font_color", Color(1, 1, 1, 0.22))
	_preview_empty.add_theme_font_size_override("font_size", 24)
	_preview_empty.mouse_filter = Control.MOUSE_FILTER_IGNORE
	preview_box.add_child(_preview_empty)

	_description = RichTextLabel.new()
	_description.bbcode_enabled = false
	_description.fit_content = true
	_description.custom_minimum_size = Vector2(0, 64)
	_description.add_theme_color_override("default_color", COL_DIM)
	_description.add_theme_font_size_override("normal_font_size", 15)
	rv.add_child(_description)

	var bar := HBoxContainer.new()
	root.add_child(bar)
	var connection_settings := Button.new()
	connection_settings.text = "连接设置"
	connection_settings.custom_minimum_size = Vector2(130, 44)
	connection_settings.add_theme_font_size_override("font_size", 17)
	connection_settings.pressed.connect(func(): _connection_settings.open())
	bar.add_child(connection_settings)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	bar.add_child(spacer)
	_enter = Button.new()
	_enter.text = "进入场景"
	_enter.custom_minimum_size = Vector2(150, 44)
	_enter.add_theme_font_size_override("font_size", 17)
	_enter.pressed.connect(_enter_stage)
	bar.add_child(_enter)


func _show_stage(index: int) -> void:
	if index < 0 or index >= _stages.size():
		return
	_selected = index
	var stage: Dictionary = _stages[index]
	_name.text = String(stage.get("name", "未命名场景"))
	_description.text = String(stage.get("description", ""))
	var path := String(stage.get("background", ""))
	var texture: Texture2D = null
	if not path.is_empty() and ResourceLoader.exists(path):
		texture = load(path)
	_preview.texture = texture
	_preview_empty.visible = texture == null


func _enter_stage() -> void:
	if _selected < 0 or _selected >= _stages.size():
		return
	var stage: Dictionary = _stages[_selected]
	AppConfig.stage_id = String(stage.get("id", ""))
	AppConfig.stage_kind = String(stage.get("kind", "stage"))
	AppConfig.stage_name = String(stage.get("name", "场景"))
	get_tree().change_scene_to_file("res://scenes/main.tscn")


func _panel_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = COL_PANEL
	style.border_color = Color(1, 1, 1, 0.10)
	style.set_border_width_all(1)
	style.set_corner_radius_all(12)
	style.set_content_margin_all(12)
	return style


func _unhandled_input(event: InputEvent) -> void:
	if not (event is InputEventKey) or not event.pressed or event.echo:
		return
	if event.keycode == KEY_ENTER or event.keycode == KEY_KP_ENTER:
		_enter_stage()
