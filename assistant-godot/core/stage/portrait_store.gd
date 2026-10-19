extends RefCounted
class_name PortraitStore
## 每个助手的形象立绘路径。**按 sessionId 存**，不按端口 ——
## 端口是 console 动态分配的，重启就变；sessionId 才是稳定身份。
##
## 现在只读：Phase A 还没有 vn_set_character 工具，所以选择面板右侧
## 基本都是空的（这是设计里的合法状态，见 docs/design.md §10.4）。
## bridge 做好之后，助手调工具注册的立绘会写进这里，选择面板就有图了。

const DIR := "user://portraits"

## 返回 neutral 立绘的路径，没有则返回空字符串
static func neutral_path(session_id: String) -> String:
	var d := load_for(session_id)
	var sprites: Dictionary = d.get("sprites", {})
	var p := String(sprites.get("neutral", ""))
	if p.is_empty():
		return ""
	if not FileAccess.file_exists(p):
		return ""   # 路径失效（图被删了）
	return p

static func load_for(session_id: String) -> Dictionary:
	var f := FileAccess.open(_path(session_id), FileAccess.READ)
	if f == null:
		return {}
	var parsed: Variant = JSON.parse_string(f.get_as_text())
	f.close()
	if typeof(parsed) == TYPE_DICTIONARY:
		return parsed
	return {}

static func save_for(session_id: String, data: Dictionary) -> void:
	DirAccess.make_dir_recursive_absolute(DIR)
	var f := FileAccess.open(_path(session_id), FileAccess.WRITE)
	if f == null:
		push_warning("[PortraitStore] 无法写入 %s" % session_id)
		return
	f.store_string(JSON.stringify(data, "  "))
	f.close()

static func _path(session_id: String) -> String:
	return "%s/%s.json" % [DIR, _safe(session_id)]

## sessionId 理论上是安全的，但它来自网络，仍然要过一遍 ——
## 否则 "../../x" 这种会写到目录外面去
static func _safe(s: String) -> String:
	var out := ""
	for i in s.length():
		var c := s[i]
		if c.is_valid_identifier() or c == "-" or c == "_" or c.is_valid_int():
			out += c
		elif (c >= "a" and c <= "z") or (c >= "A" and c <= "Z") or (c >= "0" and c <= "9"):
			out += c
		else:
			out += "_"
	if out.is_empty():
		out = "unknown"
	return out
