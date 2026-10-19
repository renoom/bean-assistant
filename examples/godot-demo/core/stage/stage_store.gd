extends RefCounted
class_name StageStore
## 每个 Stage 的状态（背景/角色/道具）持久化。按 stageId 存，和助手 session 无关。
##
## 语义（docs/design.md §10.4）：AI 布置好之后关掉重开还在，
## 只有 AI 再次调用 Stage 能力替换才会变。

const DIR := "user://stage"

static func load_for(stage_id: String) -> Dictionary:
	var f := FileAccess.open(_path(stage_id), FileAccess.READ)
	if f == null:
		return {}
	var parsed: Variant = JSON.parse_string(f.get_as_text())
	f.close()
	if typeof(parsed) == TYPE_DICTIONARY:
		return parsed
	return {}

static func save_for(stage_id: String, data: Dictionary) -> void:
	DirAccess.make_dir_recursive_absolute(DIR)
	var f := FileAccess.open(_path(stage_id), FileAccess.WRITE)
	if f == null:
		push_warning("[StageStore] 无法写入 %s" % stage_id)
		return
	f.store_string(JSON.stringify(data, "  "))
	f.close()

static func _path(stage_id: String) -> String:
	return "%s/%s.json" % [DIR, _safe(stage_id)]

## stageId 仍要过一遍，防 "../../x" 写出目录。
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
