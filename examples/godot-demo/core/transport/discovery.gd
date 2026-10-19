extends Node
class_name Discovery
## 通过 console 的注册表找助手，而不是硬编码端口。
##
## 端口是 console 的 spawner 动态分配的（sessionId 长这样：assistant-3101-c4908fa8），
## 重启一次就可能变，所以写死端口本质上不靠谱。

signal resolved(host: String, port: int, info: Dictionary)
signal failed(reason: String)

var _req: HTTPRequest

func _ready() -> void:
	_req = HTTPRequest.new()
	_req.timeout = 6.0
	add_child(_req)
	_req.request_completed.connect(_on_done)

## GET {console}/api/assistants
func _auth_headers() -> PackedStringArray:
	var headers := PackedStringArray()
	if not AppConfig.api_key.is_empty():
		headers.append("Authorization: Bearer " + AppConfig.api_key)
	return headers

func discover() -> void:
	var url := AppConfig.console_url + "/api/assistants"
	var err := _req.request(url, _auth_headers())
	if err != OK:
		failed.emit("请求 console 失败：%d" % err)

func _on_done(_r: int, code: int, _h: PackedStringArray, body: PackedByteArray) -> void:
	if code != 200:
		failed.emit("console 返回 HTTP %d（它在跑吗？%s）" % [code, AppConfig.console_url])
		return
	var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
	if typeof(parsed) != TYPE_ARRAY:
		failed.emit("console 返回的不是数组")
		return

	var online: Array[Dictionary] = []
	for item in parsed:
		if typeof(item) != TYPE_DICTIONARY:
			continue
		var d: Dictionary = item
		if String(d.get("status", "")) == "online" and ConsoleApi.has_ws(d):
			online.append(d)

	if online.is_empty():
		failed.emit("console 上没有支持 ws 的在线助手")
		return

	var pick := _prefer(online)
	# 把候选都打出来，方便你知道还有哪些可选
	print("[Discovery] 找到 %d 个在线助手：" % online.size())
	for d in online:
		var mark := "→" if d == pick else " "
		print("  %s %s  :%d  model=%s  session=%s" % [
			mark, d.get("name", "?"), int(d.get("port", 0)),
			d.get("model", "?"), d.get("sessionId", "?")])

	var endpoint := ConsoleApi.stage_endpoint(pick)
	resolved.emit(String(endpoint.get("host", "127.0.0.1")), int(endpoint.get("port", 0)), pick)

## 挑选规则：优先 sessionId/name 里带关键词的（默认 "vn"），否则取第一个在线的
func _prefer(list: Array[Dictionary]) -> Dictionary:
	var kw := AppConfig.prefer_keyword.strip_edges().to_lower()
	if not kw.is_empty():
		for d in list:
			var sid := String(d.get("sessionId", "")).to_lower()
			var nm := String(d.get("name", "")).to_lower()
			if sid.contains(kw) or nm.contains(kw):
				return d
	return list[0]
