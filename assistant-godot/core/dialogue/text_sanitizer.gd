extends RefCounted
class_name TextSanitizer
## Markdown → 视觉小说台词。
##
## 提示词里已经要求模型不要用 Markdown（docs/design.md §7.2），
## 这里是兜底 —— 模型难免会犯。
##
## 代码块整块摘掉：对话框里贴代码毫无意义，而且会把分页撑爆。

static func to_speech(md: String) -> String:
	var src := md.replace("\r\n", "\n").replace("\r", "\n")
	var out_lines: PackedStringArray = []
	var in_fence := false
	var fence_had_content := false

	for raw in src.split("\n"):
		var line := String(raw)
		var trimmed := line.strip_edges()

		# 代码块围栏
		if trimmed.begins_with("```"):
			if in_fence:
				in_fence = false
				if fence_had_content:
					out_lines.append("（代码略）")
				fence_had_content = false
			else:
				in_fence = true
				fence_had_content = false
			continue
		if in_fence:
			if not trimmed.is_empty():
				fence_had_content = true
			continue

		# 水平分割线 → 丢
		if trimmed == "---" or trimmed == "***" or trimmed == "___":
			continue

		# 标题：去掉井号
		while trimmed.begins_with("#"):
			trimmed = trimmed.substr(1)
		trimmed = trimmed.strip_edges()

		# 引用
		if trimmed.begins_with(">"):
			trimmed = trimmed.substr(1).strip_edges()

		# 项目符号 / 有序列表
		if trimmed.begins_with("- ") or trimmed.begins_with("* ") or trimmed.begins_with("+ "):
			trimmed = trimmed.substr(2).strip_edges()
		else:
			var dot := trimmed.find(". ")
			if dot > 0 and dot <= 2 and trimmed.substr(0, dot).is_valid_int():
				trimmed = trimmed.substr(dot + 2).strip_edges()

		if trimmed.is_empty():
			continue
		out_lines.append(trimmed)

	if in_fence and fence_had_content:
		out_lines.append("（代码略）")

	var joined := ""
	for i in out_lines.size():
		var l := out_lines[i]
		if joined.is_empty():
			joined = l
		elif _ends_sentence(joined):
			joined += l
		else:
			joined += "，" + l

	return _strip_emphasis(joined).strip_edges()

static func _ends_sentence(s: String) -> bool:
	if s.is_empty():
		return true
	var c := s.substr(s.length() - 1, 1)
	return c in ["。", "！", "？", "…", "”", "）", ".", "!", "?", ":", "：", "、", "，"]

static func _strip_emphasis(s: String) -> String:
	# 去掉强调标记，保留文字本身
	var r := s
	r = r.replace("***", "")
	r = r.replace("**", "")
	r = r.replace("`", "")
	r = r.replace("~~", "")
	return r
