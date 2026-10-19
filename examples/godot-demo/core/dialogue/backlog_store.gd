extends RefCounted
class_name BacklogStore
## 会话记录。**默认不展示**，L 键呼出。
## 只收真正说出来的话 —— 被过滤掉的思考与工具不进这里。

const SAVE_PATH := "user://backlog.jsonl"
const MAX_MEM := 500

var entries: Array[Dictionary] = []

func append(who: String, text: String) -> void:
	if text.strip_edges().is_empty():
		return
	var e := {
		"who": who,
		"text": text,
		"at": Time.get_unix_time_from_system(),
	}
	entries.append(e)
	if entries.size() > MAX_MEM:
		entries = entries.slice(entries.size() - MAX_MEM)
	_append_line(e)

func _append_line(e: Dictionary) -> void:
	var f: FileAccess
	if FileAccess.file_exists(SAVE_PATH):
		f = FileAccess.open(SAVE_PATH, FileAccess.READ_WRITE)
		if f != null:
			f.seek_end()
	else:
		f = FileAccess.open(SAVE_PATH, FileAccess.WRITE)
	if f == null:
		return
	f.store_line(JSON.stringify(e))
	f.close()

func render() -> String:
	var out := ""
	for e in entries:
		var who := String(e.get("who", ""))
		var label := "你" if who == "user" else "助手"
		out += "[%s]  %s\n\n" % [label, String(e.get("text", ""))]
	return out
