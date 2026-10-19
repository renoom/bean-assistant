extends Control
class_name Stage
## 舞台：多场景 + 可交互物件 + 多个助手立绘（每助手一进程一立绘）。
##
## 数据模型（持久化见 StageStore）：
##   scenes: {
##     <sceneId>: {
##       name, background,
##       objects: { <oid>: {image, x, y, size, actions:{on_click?, on_drag?}} },
##     }
##   }
##   assistants: { <assistantId>: {name, spritePath, animationPath, x, y} } ← 全局，与场景无关
##   currentScene: <sceneId>
##
## 物件字段：image(贴图/外形) + size(像素边长) + x/y(位置) + actions(动作描述)。
## 2D 场景下「外形」= 贴图；size 是像素边长。未来 3D 时这里换成 mesh + scale。
##
## 只负责「显示 + 交互」，不负责指令语义（create_scene / add_object … 由 main.gd 决定）。
## 用户对物件/助手做完整动作（拖完松手 / 点击）后发 interaction 信号，过程中不刷。

signal changed()
## 用户完成一次互动后发出。kind: object_dragged / object_clicked / assistant_dragged
## data: { objectId?, assistantId?, sceneId, action, x, y, description? }
signal interaction(kind: String, data: Dictionary)

var _bg: TextureRect
## 当前场景的助手立绘节点（运行时）：assistantId -> {sprite: TextureRect, name, spritePath, x, y}
var _assistants: Dictionary = {}
## 助手的全局身份 + 位置（与场景无关）：assistantId -> {name, spritePath, x, y}
## 形象/名字绑定在助手上，不绑定在场景上；切场景/换背景不会影响它们。
var _assistant_meta: Dictionary = {}
## 当前「在场」的助手（已连接、应渲染）：assistantId -> true
## 身份(_assistant_meta)是持久化的；在场与否是运行时的 ws 连接状态，不持久化。
var _present: Dictionary = {}
var _scenes: Dictionary = {}           # sceneId -> Dictionary
var _current_scene: String = ""
## 当前场景里已实例化的物件节点：objectId -> TextureRect
var _object_nodes: Dictionary = {}
## 物件右键菜单（共享一个，弹出前重填）
var _menu: PopupMenu
## 当前右键菜单针对的物件：{node, object_id}
var _menu_target: Dictionary = {}
## 正在「移动」的物件：{node, object_id}（选「移动」后匀速追鼠标，左键放下）
var _moving: Dictionary = {}
## 助手 move_object 触发的匀速移动列表：{node, target: Vector2, speed: float}
var _anim_moves: Array = []

const _ITEM_DEFAULT_SIZE := 240.0
## 立绘宽高比参考（4:7），实际像素尺寸随窗口缩放（见 _CHARACTER_HEIGHT_FRAC）
const _CHARACTER_W := 240.0
const _CHARACTER_H := 420.0
## 立绘高度占舞台高度的比例（相对窗口，避免窗口小时立绘过大）。角色形象用，约屏幕 10%
const _CHARACTER_HEIGHT_FRAC := 0.1
const _DRAG_THRESHOLD := 12.0          # 位移超过该像素才算「拖动」，否则算「点击」
## 物件匀速移动的默认速度（归一化单位/秒；1.0 = 每秒横穿整个场景）
const MOVE_SPEED := 1.5
const ASSISTANT_MOVE_SPEED := 0.35


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE

	_bg = _make_texture()
	_bg.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
	_bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(_bg)

	_menu = PopupMenu.new()
	add_child(_menu)
	_menu.id_pressed.connect(_on_menu_item)


func _make_texture() -> TextureRect:
	var t := TextureRect.new()
	t.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return t


# ══════════════════════════════════════════════════════════════
#  场景
# ══════════════════════════════════════════════════════════════

## 创建/覆盖一个场景（不切过去）。background 为空 = 中性底色。
## 助手是全局的（见 _assistant_meta），不挂在场景下：换场景/换背景不影响它们。
func create_scene(scene_id: String, scene_name: String, background: String) -> void:
	var scene: Dictionary = _scenes.get(scene_id, {})
	scene["id"] = scene_id
	scene["name"] = scene_name
	scene["background"] = background
	if not scene.has("objects"):
		scene["objects"] = {}
	_scenes[scene_id] = scene
	changed.emit()


## 激活场景。不存在则忽略并返回 false。
func switch_scene(scene_id: String) -> bool:
	if not _scenes.has(scene_id):
		return false
	_current_scene = scene_id
	_render_scene()
	changed.emit()
	return true


func list_scenes() -> Array:
	var out: Array = []
	for sid in _scenes:
		var s: Dictionary = _scenes[sid]
		out.append({ "id": String(sid), "name": String(s.get("name", "")) })
	return out


func get_scene(scene_id: String) -> Dictionary:
	var sid := scene_id if not scene_id.is_empty() else _current_scene
	if not _scenes.has(sid):
		return {}
	var s: Dictionary = _scenes[sid]
	var objects: Array = []
	var objs: Dictionary = s.get("objects", {})
	for oid in objs:
		var o: Dictionary = objs[oid]
		objects.append(_object_dict(String(oid), o))
	# 只返回「在场」的助手（身份取全局 registry）
	var assistants: Array = []
	for aid in _present:
		var a: Dictionary = _assistant_meta.get(aid, {})
		assistants.append({
			"assistantId": String(aid),
			"name": String(a.get("name", "")),
			"profession": String(a.get("profession", "")),
			"spritePath": String(a.get("spritePath", "")),
			"animationPath": String(a.get("animationPath", "")),
			"x": float(a.get("x", 0.5)),
			"y": float(a.get("y", 0.8)),
		})
	return {
		"id": sid,
		"name": String(s.get("name", "")),
		"background": String(s.get("background", "")),
		"objects": objects,
		"assistants": assistants,
	}


func current_scene_id() -> String:
	return _current_scene


func _object_dict(oid: String, o: Dictionary) -> Dictionary:
	return {
		"id": oid,
		"label": String(o.get("label", oid)),
		"image": String(o.get("image", "")),
		"x": float(o.get("x", 0.5)),
		"y": float(o.get("y", 0.5)),
		"size": float(o.get("size", _ITEM_DEFAULT_SIZE)),
		"actions": o.get("actions", {}),
	}


# ══════════════════════════════════════════════════════════════
#  物件
# ══════════════════════════════════════════════════════════════

## 增/改物件（作用于 scene_id，默认当前场景）。
## image = 贴图路径（可填 draw_image 生成的图）；size = 像素边长；actions = { on_click?, on_drag? }
func add_object(scene_id: String, object_id: String, image: String, x: float, y: float, size: float, actions: Dictionary, label: String = "") -> void:
	var sid := scene_id if not scene_id.is_empty() else _current_scene
	if sid.is_empty() or object_id.is_empty():
		return
	if not _scenes.has(sid):
		return
	var s: Dictionary = _scenes[sid]
	var objs: Dictionary = s.get("objects", {})
	objs[object_id] = {
		"id": object_id,
		"label": label if not label.is_empty() else object_id,
		"image": image,
		"x": clampf(x, 0.0, 1.0),
		"y": clampf(y, 0.0, 1.0),
		"size": maxf(16.0, size),
		"actions": actions.duplicate(),
	}
	s["objects"] = objs
	if sid == _current_scene:
		_render_scene()
	changed.emit()


func remove_object(scene_id: String, object_id: String) -> void:
	var sid := scene_id if not scene_id.is_empty() else _current_scene
	if sid.is_empty() or not _scenes.has(sid):
		return
	var s: Dictionary = _scenes[sid]
	var objs: Dictionary = s.get("objects", {})
	if not objs.has(object_id):
		return
	objs.erase(object_id)
	if sid == _current_scene:
		_render_scene()
	changed.emit()


func move_object(scene_id: String, object_id: String, x: float, y: float, speed: float = -1.0) -> void:
	var sid := scene_id if not scene_id.is_empty() else _current_scene
	if sid.is_empty() or not _scenes.has(sid):
		return
	var s: Dictionary = _scenes[sid]
	var objs: Dictionary = s.get("objects", {})
	if not objs.has(object_id):
		return
	var o: Dictionary = objs[object_id]
	o["x"] = clampf(x, 0.0, 1.0)
	o["y"] = clampf(y, 0.0, 1.0)
	if sid == _current_scene:
		var node: TextureRect = _object_nodes.get(object_id)
		if is_instance_valid(node):
			# speed < 0 = 未指定 → 用默认 MOVE_SPEED；speed = 0 = 瞬间；speed > 0 = 该速度
			var spd := MOVE_SPEED if speed < 0.0 else speed
			if spd > 0.0:
				_anim_moves.append({"node": node, "target": Vector2(o["x"], o["y"]), "speed": spd})
			else:
				_set_node_anchors(node, Vector2(o["x"], o["y"]))
	changed.emit()


## 取一个物件（当前场景）。供互动回读用。
func get_object(scene_id: String, object_id: String) -> Dictionary:
	var sid := scene_id if not scene_id.is_empty() else _current_scene
	var s: Dictionary = _scenes.get(sid, {})
	var objs: Dictionary = s.get("objects", {})
	return objs.get(object_id, {})


# ══════════════════════════════════════════════════════════════
#  助手（多立绘）
# ══════════════════════════════════════════════════════════════

## 注册/更新一个助手（全局，与场景无关）。name/sprite_path 为空则保留已有值，不覆盖。
## 同时标记「在场」（应渲染）。scene_id 参数仅为兼容旧调用保留。
func add_assistant(scene_id: String, assistant_id: String, name: String, sprite_path: String, x: float, y: float, profession: String = "", animation_path: String = "") -> void:
	if assistant_id.is_empty():
		return
	var existing: Dictionary = _assistant_meta.get(assistant_id, {})
	_assistant_meta[assistant_id] = {
		"id": assistant_id,
		"name": name if not name.is_empty() else String(existing.get("name", "")),
		"profession": profession if not profession.is_empty() else String(existing.get("profession", "")),
		"spritePath": sprite_path if not sprite_path.is_empty() else String(existing.get("spritePath", "")),
		"animationPath": animation_path if not animation_path.is_empty() else String(existing.get("animationPath", "")),
		"x": clampf(x, 0.0, 1.0),
		"y": clampf(y, 0.0, 1.0),
	}
	_present[assistant_id] = true
	_render_scene()
	changed.emit()


## 完全移除一个助手（身份 + 在场都删）。用于 remove_assistant 指令。
func remove_assistant(scene_id: String, assistant_id: String) -> void:
	if assistant_id.is_empty():
		return
	_assistant_meta.erase(assistant_id)
	_present.erase(assistant_id)
	_render_scene()
	changed.emit()


## 切换助手「在场」状态（ws 连接/断开）。身份(_assistant_meta)不动。
func set_assistant_present(assistant_id: String, on: bool) -> void:
	if assistant_id.is_empty():
		return
	if on:
		_present[assistant_id] = true
	else:
		_present.erase(assistant_id)
	_render_scene()


func move_assistant(scene_id: String, assistant_id: String, x: float, y: float) -> void:
	if not _assistant_meta.has(assistant_id):
		return
	var a: Dictionary = _assistant_meta[assistant_id]
	var target := Vector2(clampf(x, 0.0, 1.0), clampf(y, 0.0, 1.0))
	a["x"] = target.x
	a["y"] = target.y
	var info: Dictionary = _assistants.get(assistant_id, {})
	var node: TextureRect = info.get("sprite")
	if is_instance_valid(node):
		var current := Vector2((node.anchor_left + node.anchor_right) / 2.0, (node.anchor_top + node.anchor_bottom) / 2.0)
		var delta := target - current
		var direction := "down"
		if absf(delta.x) > absf(delta.y):
			direction = "right" if delta.x >= 0.0 else "left"
		else:
			direction = "down" if delta.y >= 0.0 else "up"
		for i in range(_anim_moves.size() - 1, -1, -1):
			if String((_anim_moves[i] as Dictionary).get("assistantId", "")) == assistant_id:
				_anim_moves.remove_at(i)
		if delta.length() > 0.001:
			_set_assistant_animation_name(assistant_id, "walk_" + direction)
			_anim_moves.append({
				"node": node,
				"target": target,
				"speed": ASSISTANT_MOVE_SPEED,
				"assistantId": assistant_id,
				"idleAnimation": "idle_" + direction,
			})
		else:
			_set_assistant_animation_name(assistant_id, "idle_" + direction)
	changed.emit()


## 设置助手立绘。返回错误信息（"" = 成功）。校验宽高比：立绘固定 240×420（4:7）。
func set_assistant_sprite(scene_id: String, assistant_id: String, sprite_path: String) -> String:
	if not _assistant_meta.has(assistant_id):
		return "助手不存在: " + assistant_id
	var tex := _load(sprite_path)
	if tex == null:
		return "图片加载失败: " + sprite_path
	var sz := tex.get_size()
	if sz.x <= 0.0 or sz.y <= 0.0:
		return "图片尺寸无效"
	var aspect := sz.x / sz.y
	var target := float(_CHARACTER_W) / float(_CHARACTER_H)
	if absf(aspect - target) > 0.05:
		return "图片宽高比不符合（需要 4:7 ≈ %.3f，实际 %.3f，建议 1024×1792）" % [target, aspect]
	_assistant_meta[assistant_id]["spritePath"] = sprite_path
	_assistant_meta[assistant_id]["animationPath"] = ""
	var info: Dictionary = _assistants.get(assistant_id, {})
	var node: TextureRect = info.get("sprite")
	if is_instance_valid(node):
		node.texture = tex
	changed.emit()
	return ""


## 设置助手的序列帧形象。animation_path 指向 draw_sprite_animation 返回的 animation.json。
func set_assistant_animation(scene_id: String, assistant_id: String, animation_path: String) -> String:
	if not _assistant_meta.has(assistant_id):
		return "助手不存在: " + assistant_id
	var loaded := _load_animation(animation_path)
	var error := String(loaded.get("error", ""))
	if not error.is_empty():
		return error
	var manifest: Dictionary = loaded.get("manifest", {})
	_assistant_meta[assistant_id]["animationPath"] = animation_path
	# sheet 路径也是旧客户端和存档查看时的静态兜底。
	_assistant_meta[assistant_id]["spritePath"] = String(manifest.get("sheet", ""))
	_render_scene()
	changed.emit()
	return ""


## 取一个助手的 meta（{name, spritePath, x, y}）。助手是全局的，scene_id 不再参与。
func get_assistant_meta(scene_id: String, assistant_id: String) -> Dictionary:
	return _assistant_meta.get(assistant_id, {})


## 当前「在场」的助手 id 列表（应渲染的）。
func list_assistants(scene_id: String = "") -> Array:
	return _present.keys()


## 当前场景里某助手的画面节点（main.gd 用来定位气泡）。
func get_assistant_sprite(assistant_id: String) -> TextureRect:
	var info: Dictionary = _assistants.get(assistant_id, {})
	var node: TextureRect = info.get("sprite")
	return node if is_instance_valid(node) else null


# ══════════════════════════════════════════════════════════════
#  渲染当前场景
# ══════════════════════════════════════════════════════════════

func _render_scene() -> void:
	var s: Dictionary = _scenes.get(_current_scene, {})
	_bg.texture = _load(String(s.get("background", "")))
	for node in _object_nodes.values():
		if is_instance_valid(node):
			node.queue_free()
	_object_nodes.clear()
	var objs: Dictionary = s.get("objects", {})
	for oid in objs:
		var o: Dictionary = objs[oid]
		var node: Control
		var image_path := String(o.get("image", ""))
		if image_path.is_empty():
			node = _make_hotspot(String(o.get("label", oid)))
		else:
			var texture := _make_texture()
			texture.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
			texture.texture = _load(image_path)
			node = texture
		node.mouse_filter = Control.MOUSE_FILTER_STOP
		node.tooltip_text = String(o.get("label", oid))
		_place_object_at(node, float(o.get("x", 0.5)), float(o.get("y", 0.5)), float(o.get("size", _ITEM_DEFAULT_SIZE)))
		add_child(node)
		_object_nodes[oid] = node
		_make_object_interactive(node, String(oid))

	# 重建所有「在场」助手的立绘（身份取全局 registry —— 场景是场景，助手是助手）
	for aid in _assistants:
		var info: Dictionary = _assistants[aid]
		var old: TextureRect = info.get("sprite")
		if is_instance_valid(old):
			old.queue_free()
	_assistants.clear()
	for aid in _present:
		var a: Dictionary = _assistant_meta.get(aid, {})
		var t2 := _make_texture()
		t2.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		t2.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		t2.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
		var animation_path := String(a.get("animationPath", ""))
		var animation_data := _load_animation(animation_path) if not animation_path.is_empty() else {}
		var tex: Texture2D = animation_data.get("texture")
		var manifest: Dictionary = animation_data.get("manifest", {})
		var frame_aspect := float(_CHARACTER_W) / float(_CHARACTER_H)
		if not manifest.is_empty():
			frame_aspect = float(manifest.get("frameWidth", 1)) / maxf(1.0, float(manifest.get("frameHeight", 1)))
		else:
			tex = _load(String(a.get("spritePath", "")))
		if tex == null:
			# 无贴图 → 占位色块（按 assistantId 稳定着色），保证助手在场景里始终可见、可拖拽
			tex = _placeholder_texture(String(aid))
		t2.texture = tex
		t2.mouse_filter = Control.MOUSE_FILTER_STOP
		_place_character_at(t2, float(a.get("x", 0.5)), float(a.get("y", 0.8)), frame_aspect)
		add_child(t2)
		_assistants[aid] = {
			"sprite": t2,
			"name": String(a.get("name", "")),
			"spritePath": String(a.get("spritePath", "")),
			"animationPath": animation_path,
			"manifest": manifest,
			"sheetTexture": tex,
			"animationName": String(manifest.get("defaultAnimation", "idle_down")),
			"animationTime": 0.0,
			"frameIndex": -1,
			"aspect": frame_aspect,
			"x": float(a.get("x", 0.5)),
			"y": float(a.get("y", 0.8)),
		}
		if not manifest.is_empty():
			_apply_assistant_frame(String(aid), true)
		_make_draggable(t2, String(aid), "assistant:" + String(aid))


## 没有独立贴图的预制地点使用轻量热点覆盖层。背景图仍负责美术，热点只提供
## 可发现的名称与点击区域；鼠标不会落在“看得见但点不到”的建筑上。
func _make_hotspot(label: String) -> PanelContainer:
	var panel := PanelContainer.new()
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.05, 0.12, 0.10, 0.16)
	style.border_color = Color(1.0, 0.86, 0.42, 0.52)
	style.set_border_width_all(2)
	style.set_corner_radius_all(12)
	panel.add_theme_stylebox_override("panel", style)
	var text := Label.new()
	text.text = label
	text.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	text.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	text.add_theme_color_override("font_color", Color(1.0, 0.96, 0.78, 0.92))
	text.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 0.85))
	text.add_theme_constant_override("shadow_offset_x", 1)
	text.add_theme_constant_override("shadow_offset_y", 2)
	text.add_theme_font_size_override("font_size", 13)
	text.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_child(text)
	return panel


## 物件：锚点设到 (x, y)，尺寸 size×size。
func _place_object_at(node: Control, x: float, y: float, size: float) -> void:
	var cx := clampf(x, 0.0, 1.0)
	var cy := clampf(y, 0.0, 1.0)
	var half := size / 2.0
	node.anchor_left = cx
	node.anchor_right = cx
	node.anchor_top = cy
	node.anchor_bottom = cy
	node.offset_left = -half
	node.offset_right = half
	node.offset_top = -half
	node.offset_bottom = half


## 助手立绘：竖版人像，锚点在 (x, y)（取人像中心）。固定像素尺寸（按 720 设计高度 × 比例）。
func _place_character_at(node: Control, x: float, y: float, aspect: float = -1.0) -> void:
	var cx := clampf(x, 0.0, 1.0)
	var cy := clampf(y, 0.0, 1.0)
	# 固定 720 设计高度 × 比例 = 72px，不依赖运行时 size（避免拉伸模式下 size 异常导致立绘过大）
	var h := 720.0 * _CHARACTER_HEIGHT_FRAC
	var resolved_aspect := aspect if aspect > 0.0 else float(_CHARACTER_W) / float(_CHARACTER_H)
	var w := h * resolved_aspect
	node.anchor_left = cx
	node.anchor_right = cx
	node.anchor_top = cy
	node.anchor_bottom = cy
	node.offset_left = -w / 2.0
	node.offset_right = w / 2.0
	node.offset_top = -h / 2.0
	node.offset_bottom = h / 2.0


# ══════════════════════════════════════════════════════════════
#  匀速移动（玩家「移动」追鼠标 + 助手 move_object 动画）
# ══════════════════════════════════════════════════════════════

## 每帧驱动：玩家「移动」模式匀速追鼠标 + 助手 move_object 的匀速移动。
func _process(dt: float) -> void:
	_tick_assistant_animations(dt)
	if not _moving.is_empty():
		var mn: Control = _moving.get("node")
		if is_instance_valid(mn):
			_chase_step(mn, _mouse_normalized(), MOVE_SPEED, dt)
		else:
			_moving = {}
	var i := _anim_moves.size() - 1
	while i >= 0:
		var m: Dictionary = _anim_moves[i]
		var an: Control = m.get("node")
		if not is_instance_valid(an):
			_anim_moves.remove_at(i)
		elif _chase_step(an, m.get("target", Vector2(0.5, 0.8)), float(m.get("speed", MOVE_SPEED)), dt):
			var assistant_id := String(m.get("assistantId", ""))
			if not assistant_id.is_empty():
				_set_assistant_animation_name(assistant_id, String(m.get("idleAnimation", "idle_down")))
			_anim_moves.remove_at(i)
		i -= 1


func _tick_assistant_animations(dt: float) -> void:
	for aid_any in _assistants:
		var aid := String(aid_any)
		var info: Dictionary = _assistants[aid]
		var manifest: Dictionary = info.get("manifest", {})
		if manifest.is_empty():
			continue
		info["animationTime"] = float(info.get("animationTime", 0.0)) + dt
		_apply_assistant_frame(aid)


func _set_assistant_animation_name(assistant_id: String, animation_name: String) -> void:
	var info: Dictionary = _assistants.get(assistant_id, {})
	var manifest: Dictionary = info.get("manifest", {})
	var animations: Dictionary = manifest.get("animations", {})
	if info.is_empty() or not animations.has(animation_name):
		return
	if String(info.get("animationName", "")) != animation_name:
		info["animationName"] = animation_name
		info["animationTime"] = 0.0
		info["frameIndex"] = -1
		_apply_assistant_frame(assistant_id, true)


func _apply_assistant_frame(assistant_id: String, force: bool = false) -> void:
	var info: Dictionary = _assistants.get(assistant_id, {})
	var node: TextureRect = info.get("sprite")
	var sheet: Texture2D = info.get("sheetTexture")
	var manifest: Dictionary = info.get("manifest", {})
	var animations: Dictionary = manifest.get("animations", {})
	var spec: Dictionary = animations.get(String(info.get("animationName", "idle_down")), {})
	var frames: Array = spec.get("frames", [])
	if not is_instance_valid(node) or sheet == null or frames.is_empty():
		return
	var fps := maxf(0.1, float(spec.get("fps", 8.0)))
	var sequence_index := int(floor(float(info.get("animationTime", 0.0)) * fps)) % frames.size()
	if not force and sequence_index == int(info.get("frameIndex", -1)):
		return
	info["frameIndex"] = sequence_index
	var column := int(frames[sequence_index])
	var row := int(spec.get("row", 0))
	var frame_width := int(manifest.get("frameWidth", 0))
	var frame_height := int(manifest.get("frameHeight", 0))
	var atlas := AtlasTexture.new()
	atlas.atlas = sheet
	atlas.region = Rect2(column * frame_width, row * frame_height, frame_width, frame_height)
	node.texture = atlas


## 鼠标在场景里的归一化坐标 [0,1]。
func _mouse_normalized() -> Vector2:
	if size.x <= 0.0 or size.y <= 0.0:
		return Vector2(0.5, 0.5)
	var mp := get_viewport().get_mouse_position()
	return Vector2(clampf(mp.x / size.x, 0.0, 1.0), clampf(mp.y / size.y, 0.0, 1.0))


## 以 speed（归一化单位/秒）匀速逼近 target，到达返回 true。
func _chase_step(node: Control, target: Vector2, speed: float, dt: float) -> bool:
	var cur := Vector2((node.anchor_left + node.anchor_right) / 2.0, (node.anchor_top + node.anchor_bottom) / 2.0)
	var delta := target - cur
	var max_step := speed * dt
	if delta.length() <= max_step:
		_set_node_anchors(node, target)
		return true
	cur += delta.normalized() * max_step
	_set_node_anchors(node, cur)
	return false


## 设节点中心锚点（归一化坐标），保留 offset（尺寸不变）。
func _set_node_anchors(node: Control, c: Vector2) -> void:
	node.anchor_left = c.x
	node.anchor_right = c.x
	node.anchor_top = c.y
	node.anchor_bottom = c.y


# ══════════════════════════════════════════════════════════════
#  物件互动（右键菜单 + 移动 + 自定义互动）
# ══════════════════════════════════════════════════════════════

## 给物件挂「右键菜单 + 移动 + 自定义互动」。取消自由拖拽。
func _make_object_interactive(node: Control, object_id: String) -> void:
	node.gui_input.connect(func(ev: InputEvent):
		if ev is InputEventMouseButton and ev.button_index == MOUSE_BUTTON_RIGHT and ev.pressed:
			if _moving.get("node") == node:
				_moving = {}   # 移动中右键 = 取消
			else:
				_open_object_menu(node, object_id, (ev as InputEventMouseButton).global_position)
		elif ev is InputEventMouseButton and ev.button_index == MOUSE_BUTTON_LEFT:
			if _moving.get("node") == node:
				if not ev.pressed:
					_finish_object_move(node, object_id)
					_moving = {}
			elif ev.pressed:
				_emit_object_click(node, object_id)
	)


## 弹出物件右键菜单：第 0 项「移动」+ 自定义互动（actions.menu）。
func _open_object_menu(node: Control, object_id: String, global_pos: Vector2) -> void:
	var o: Dictionary = get_object(_current_scene, object_id)
	if o.is_empty():
		return
	_menu_target = { "node": node, "object_id": object_id }
	_menu.clear()
	_menu.add_item("移动")
	_menu.set_item_metadata(0, "move")
	var actions: Dictionary = o.get("actions", {})
	var menu_items: Array = actions.get("menu", [])
	var idx := 1
	for item in menu_items:
		if typeof(item) != TYPE_DICTIONARY:
			continue
		var it: Dictionary = item
		var label := String(it.get("label", it.get("id", "互动")))
		_menu.add_item(label)
		_menu.set_item_metadata(idx, { "type": "custom", "label": label, "description": String(it.get("description", "")) })
		idx += 1
	_menu.popup(Rect2i(Vector2i(global_pos), Vector2i.ZERO))


func _on_menu_item(id: int) -> void:
	var meta: Variant = _menu.get_item_metadata(id)
	var target: Dictionary = _menu_target
	_menu_target = {}
	var node: Control = target.get("node")
	var object_id := String(target.get("object_id", ""))
	if node == null or not is_instance_valid(node):
		return
	if meta == "move":
		_moving = { "node": node, "object_id": object_id }
		# 进入移动模式：_process 里匀速追鼠标（不瞬间跳过去）
	elif typeof(meta) == TYPE_DICTIONARY:
		var m: Dictionary = meta
		interaction.emit("object_interacted", {
			"sceneId": _current_scene,
			"objectId": object_id,
			"action": String(m.get("label", "")),
			"x": (node.anchor_left + node.anchor_right) / 2.0,
			"y": (node.anchor_top + node.anchor_bottom) / 2.0,
			"description": String(m.get("description", "")),
		})
		changed.emit()


## 完成移动：把新位置写回物件数据 + 发 object_moved 事件。
func _finish_object_move(node: Control, object_id: String) -> void:
	var o: Dictionary = get_object(_current_scene, object_id)
	if o.is_empty():
		return
	var nx := (node.anchor_left + node.anchor_right) / 2.0
	var ny := (node.anchor_top + node.anchor_bottom) / 2.0
	o["x"] = nx
	o["y"] = ny
	interaction.emit("object_moved", {
		"sceneId": _current_scene,
		"objectId": object_id,
		"action": "move",
		"x": nx, "y": ny,
		"description": "",
	})
	changed.emit()


## 左键点击（非移动模式）→ on_click 互动（保留向后兼容）。
func _emit_object_click(node: Control, object_id: String) -> void:
	var o: Dictionary = get_object(_current_scene, object_id)
	if o.is_empty():
		return
	var actions: Dictionary = o.get("actions", {})
	var desc := String(actions.get("on_click", ""))
	interaction.emit("object_clicked", {
		"sceneId": _current_scene,
		"objectId": object_id,
		"action": "on_click",
		"x": (node.anchor_left + node.anchor_right) / 2.0,
		"y": (node.anchor_top + node.anchor_bottom) / 2.0,
		"description": desc,
	})
	changed.emit()


# ══════════════════════════════════════════════════════════════
#  拖拽 / 点击（助手立绘，保留自由拖拽）
# ══════════════════════════════════════════════════════════════

## 给一个 Control 挂拖拽+点击处理（助手立绘用）。
## target_id 是 assistantId；kind 是 "assistant:<id>"。
func _make_draggable(node: Control, target_id: String, kind: String) -> void:
	var drag := { "active": false, "start_x": 0.0, "start_y": 0.0, "moved": false }
	node.gui_input.connect(func(ev: InputEvent):
		if ev is InputEventMouseButton and ev.button_index == MOUSE_BUTTON_LEFT:
			if ev.pressed:
				drag["active"] = true
				drag["moved"] = false
				var g: Vector2 = node.global_position
				drag["start_x"] = g.x
				drag["start_y"] = g.y
			else:
				if not bool(drag.get("active", false)):
					return
				drag["active"] = false
				_finish_drag(node, target_id, kind, bool(drag.get("moved", false)))
		elif ev is InputEventMouseMotion and bool(drag.get("active", false)):
			var mx: InputEventMouseMotion = ev
			var dist := Vector2(mx.global_position.x - drag["start_x"], mx.global_position.y - drag["start_y"]).length()
			if dist > _DRAG_THRESHOLD:
				drag["moved"] = true
			_move_node_to(node, mx.global_position)
	)


## 拖动中：只更新锚点（位置），不重置尺寸/offset。
func _move_node_to(node: Control, global_pos: Vector2) -> void:
	var parent_size := size
	if parent_size.x <= 0.0 or parent_size.y <= 0.0:
		return
	var nx := clampf(global_pos.x / parent_size.x, 0.0, 1.0)
	var ny := clampf(global_pos.y / parent_size.y, 0.0, 1.0)
	node.anchor_left = nx
	node.anchor_right = nx
	node.anchor_top = ny
	node.anchor_bottom = ny


func _finish_drag(node: Control, target_id: String, kind: String, moved: bool) -> void:
	var nx := (node.anchor_left + node.anchor_right) / 2.0
	var ny := (node.anchor_top + node.anchor_bottom) / 2.0
	if kind.begins_with("assistant:"):
		var aid := kind.substr(len("assistant:"))
		if _assistant_meta.has(aid):
			var a: Dictionary = _assistant_meta[aid]
			a["x"] = nx
			a["y"] = ny
		interaction.emit("assistant_dragged", {
			"sceneId": _current_scene,
			"assistantId": aid,
			"action": "on_drag",
			"x": nx, "y": ny,
			"description": "",
		})
		changed.emit()
		return
	# object:<oid>
	var oid := kind.substr(len("object:"))
	var o: Dictionary = get_object(_current_scene, oid)
	if o.is_empty():
		return
	o["x"] = nx
	o["y"] = ny
	var actions: Dictionary = o.get("actions", {})
	if moved:
		interaction.emit("object_dragged", {
			"sceneId": _current_scene,
			"objectId": oid,
			"action": "on_drag",
			"x": nx, "y": ny,
			"description": String(actions.get("on_drag", "")),
		})
	else:
		interaction.emit("object_clicked", {
			"sceneId": _current_scene,
			"objectId": oid,
			"action": "on_click",
			"x": nx, "y": ny,
			"description": String(actions.get("on_click", "")),
		})
	changed.emit()


# ══════════════════════════════════════════════════════════════
#  持久化
# ══════════════════════════════════════════════════════════════

func snapshot() -> Dictionary:
	var scenes_out: Dictionary = {}
	for sid in _scenes:
		var s: Dictionary = _scenes[sid]
		var objs_out: Dictionary = {}
		var objs: Dictionary = s.get("objects", {})
		for oid in objs:
			var o: Dictionary = objs[oid]
			objs_out[String(oid)] = {
				"label": String(o.get("label", oid)),
				"image": String(o.get("image", "")),
				"x": float(o.get("x", 0.5)),
				"y": float(o.get("y", 0.5)),
				"size": float(o.get("size", _ITEM_DEFAULT_SIZE)),
				"actions": o.get("actions", {}),
			}
		scenes_out[String(sid)] = {
			"name": String(s.get("name", "")),
			"background": String(s.get("background", "")),
			"objects": objs_out,
		}
	# 助手是全局的，单列一个顶层 registry
	var assistants_out: Dictionary = {}
	for aid in _assistant_meta:
		var a: Dictionary = _assistant_meta[aid]
		assistants_out[String(aid)] = {
			"name": String(a.get("name", "")),
			"profession": String(a.get("profession", "")),
			"spritePath": String(a.get("spritePath", "")),
			"animationPath": String(a.get("animationPath", "")),
			"x": float(a.get("x", 0.5)),
			"y": float(a.get("y", 0.8)),
		}
	return {
		"scenes": scenes_out,
		"assistants": assistants_out,
		"currentScene": _current_scene,
	}


func restore(data: Dictionary) -> void:
	if data.is_empty():
		return

	# 1) 场景（只含背景 + 物件；助手是全局的，不在场景下）
	var scenes_in: Dictionary = data.get("scenes", {})
	for sid in scenes_in:
		var s: Dictionary = scenes_in[sid]
		var objs_in: Dictionary = s.get("objects", {})
		var objs: Dictionary = {}
		for oid in objs_in:
			var o: Dictionary = objs_in[oid]
			objs[String(oid)] = {
				"id": String(oid),
				"label": String(o.get("label", oid)),
				"image": String(o.get("image", "")),
				"x": float(o.get("x", 0.5)),
				"y": float(o.get("y", 0.5)),
				"size": float(o.get("size", _ITEM_DEFAULT_SIZE)),
				"actions": o.get("actions", {}),
			}
		_scenes[String(sid)] = {
			"id": String(sid),
			"name": String(s.get("name", "")),
			"background": String(s.get("background", "")),
			"objects": objs,
		}

	# 2) 助手（全局 registry）。优先读新格式顶层 assistants；
	#    否则从旧格式（每场景里的 assistants）迁移：按 aid 合并，spritePath 非空的优先保留。
	#    只恢复身份，不标记在场 —— 在场与否由 ws 连接决定（_connect_assistant / set_assistant_present）。
	_assistant_meta.clear()
	_present.clear()
	var assistants_in: Dictionary = data.get("assistants", {})
	if not assistants_in.is_empty():
		for aid in assistants_in:
			var a: Dictionary = assistants_in[aid]
			_assistant_meta[String(aid)] = {
				"id": String(aid),
				"name": String(a.get("name", "")),
				"profession": String(a.get("profession", "")),
				"spritePath": String(a.get("spritePath", "")),
				"animationPath": String(a.get("animationPath", "")),
				"x": float(a.get("x", 0.5)),
				"y": float(a.get("y", 0.8)),
			}
	else:
		for sid in scenes_in:
			var asis_in: Dictionary = scenes_in[sid].get("assistants", {})
			for aid in asis_in:
				var a: Dictionary = asis_in[aid]
				var existing: Dictionary = _assistant_meta.get(String(aid), {})
				var sp := String(a.get("spritePath", ""))
				# 这条是空、且已收集到非空形象 → 保留旧的（别用空覆盖头像）
				if sp.is_empty() and not String(existing.get("spritePath", "")).is_empty():
					continue
				_assistant_meta[String(aid)] = {
					"id": String(aid),
					"name": String(a.get("name", "")),
					"profession": String(a.get("profession", "")),
					"spritePath": sp,
					"animationPath": String(a.get("animationPath", "")),
					"x": float(a.get("x", 0.5)),
					"y": float(a.get("y", 0.8)),
				}

	# 兼容极旧 schema：顶层 character 单助手
	var char: Dictionary = data.get("character", {})
	var legacy_sprite := String(char.get("image", ""))
	if not legacy_sprite.is_empty() and not _assistant_meta.has("default"):
		_assistant_meta["default"] = {
			"id": "default",
			"name": String(char.get("name", "")),
			"spritePath": legacy_sprite,
			"animationPath": "",
			"x": 0.5, "y": 0.8,
		}

	var cur: String = String(data.get("currentScene", ""))
	if cur.is_empty() and not _scenes.is_empty():
		cur = String(_scenes.keys()[0])
	_current_scene = cur
	if not _current_scene.is_empty():
		_render_scene()


# ══════════════════════════════════════════════════════════════
#  图片加载（含路径校验）
# ══════════════════════════════════════════════════════════════

func _load_animation(path: String) -> Dictionary:
	if path.is_empty():
		return {"error": "动画文件路径为空"}
	if path.get_extension().to_lower() != "json" or not FileAccess.file_exists(path):
		return {"error": "动画文件不存在或不是 JSON: " + path}
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return {"error": "动画文件无法读取: " + path}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	if typeof(parsed) != TYPE_DICTIONARY:
		return {"error": "动画文件不是有效 JSON 对象: " + path}
	var manifest: Dictionary = parsed
	if String(manifest.get("type", "")) != "sprite-sheet":
		return {"error": "动画类型必须是 sprite-sheet"}
	var columns := int(manifest.get("columns", 0))
	var rows := int(manifest.get("rows", 0))
	var frame_width := int(manifest.get("frameWidth", 0))
	var frame_height := int(manifest.get("frameHeight", 0))
	if columns != 4 or rows != 4 or frame_width <= 0 or frame_height <= 0:
		return {"error": "NPC 动画必须是 4×4 有效序列帧"}
	var sheet_path := String(manifest.get("sheet", ""))
	var texture := _load(sheet_path)
	if texture == null:
		return {"error": "动画精灵表加载失败: " + sheet_path}
	var texture_size := texture.get_size()
	if int(texture_size.x) != frame_width * columns or int(texture_size.y) != frame_height * rows:
		return {"error": "精灵表尺寸与 animation.json 不一致"}
	var animations: Dictionary = manifest.get("animations", {})
	for required in ["walk_down", "walk_left", "walk_right", "walk_up", "idle_down", "idle_left", "idle_right", "idle_up"]:
		if not animations.has(required):
			return {"error": "动画缺少动作: " + required}
	return {"error": "", "manifest": manifest, "texture": texture}

## 无贴图时的占位：按 assistantId 生成稳定纯色块（与立绘框同宽高比 4:7），让助手始终可见。
func _placeholder_texture(assistant_id: String) -> Texture2D:
	var hue := float(posmod(hash(assistant_id), 360)) / 360.0
	var col := Color.from_hsv(hue, 0.5, 0.72, 0.9)
	var img := Image.create(48, 84, false, Image.FORMAT_RGBA8)
	img.fill(col)
	var border := Color(1, 1, 1, 0.35)
	for x in img.get_width():
		img.set_pixel(x, 0, border)
		img.set_pixel(x, img.get_height() - 1, border)
	for y in img.get_height():
		img.set_pixel(0, y, border)
		img.set_pixel(img.get_width() - 1, y, border)
	return ImageTexture.create_from_image(img)


func _load(path: String) -> Texture2D:
	if path.is_empty():
		return null
	# 工程内预制资产必须走导入后的 ResourceLoader，才能在导出包中使用。
	if path.begins_with("res://"):
		if not ResourceLoader.exists(path):
			push_warning("[Stage] 工程图片不存在: %s" % path)
			return null
		var resource := load(path)
		return resource as Texture2D
	var ext := path.get_extension().to_lower()
	if not (ext == "png" or ext == "jpg" or ext == "jpeg" or ext == "webp"):
		push_warning("[Stage] 不支持的图片类型: %s" % path)
		return null
	if not FileAccess.file_exists(path):
		push_warning("[Stage] 图片不存在: %s" % path)
		return null
	var img := Image.new()
	var err := img.load(path)
	if err != OK:
		push_warning("[Stage] 图片加载失败(%d): %s" % [err, path])
		return null
	return ImageTexture.create_from_image(img)
