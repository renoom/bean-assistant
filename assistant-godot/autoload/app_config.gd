extends Node
## 全局配置。user://config.json 读写 + 命令行覆盖。
##
## 命令行用法（注意 Godot 要求用户参数放在 -- 之后）：
##   Godot --path . -- --port=3101 --host=127.0.0.1 --session-id=... --assistant-name=...
##
## 助手地址的解析顺序（见 resolve_mode()）：
##   1. 命令行 --port=      → 直接用，不做发现
##   2. config.json 的 port → 直接用，不做发现
##   3. 都没有              → 问 console 要在线助手列表（推荐）
## 端口是 console 动态分配的，所以写死端口不靠谱，默认走自动发现。

const CONFIG_PATH := "user://config.json"

var host: String = "127.0.0.1"
## 平台 API Key，由 Console 生成后填入 config.json 或 --api-key= 传入
var api_key: String = ""
## 0 = 自动发现（问 console）。非 0 = 直连这个端口
var port: int = 0
## console 地址，自动发现用
var console_url: String = "http://127.0.0.1:3000"
## 多个助手在线时优先挑 sessionId / name 里带这个关键词的
var prefer_keyword: String = "vn"
## 当前选中助手的 sessionId（单选模式用，或 picker 选完后第一个）
var session_id: String = ""
## 当前选中助手的显示名（单选模式用）
var assistant_name: String = ""
## 多选模式：picker 多选后写入的 sessionId 列表；main.tscn 启动时按这里逐个连
var selected_sessions: PackedStringArray = PackedStringArray()
## 启动页选择的 Stage。场景先于助手确定，且不属于任何 assistant session。
var stage_id: String = ""
var stage_kind: String = ""
var stage_name: String = ""
## 当前用户名（互动事件里作为「操作人」上报）
var user_name: String = "用户"
## 内部：端口是否由命令行显式指定（是则跳过选择面板）
var _port_from_cli := false
## 打字机速度（字/秒）。0 = 瞬间显示
var text_cps: float = 38.0
## 对话框显示几行台词（按实际字体高度算，装不下就翻页）
var dialogue_lines: int = 3
## 助手忙碌超过这个秒数才显示「…」，避免短回答闪一下
var busy_hint_delay: float = 0.8
## Phase A 的临时手段：首次连接时发一条场景设定消息。
## 正式方案是 bridge 用 systemPrompt.section 注入（见 docs/design.md §7）
var send_scene_prompt: bool = false
var scene_prompt: String = ""
var font_size: int = 20
var debug_overlay: bool = false
## 开发用：不连助手，本地灌一段假台词，方便离线调样式（不花 token）
var demo_mode: bool = false
## 开发用：启动 N 秒后把自己的窗口内容存成 png 然后退出
var screenshot_path: String = ""
var screenshot_delay: float = 3.0
## 开发用：截图前模拟 N 次鼠标点击（验证翻页链路）
var simulate_clicks: int = 0
## 开发用：启动即弹出创建面板（截图用）
var show_create_on_start: bool = false

func _ready() -> void:
	_load()
	_apply_cmdline()
	if needs_discovery():
		print("[AppConfig] 未绑定助手；进入 Stage 后从 Console 邀请（%s）" % console_url)
	else:
		print("[AppConfig] 直连 %s" % base_url())

## 是否需要向 console 问助手地址
func needs_discovery() -> bool:
	return port <= 0

## 命令行显式给了端口 → 跳过选择面板直接进对话（调试方便）
func skip_picker() -> bool:
	return _port_from_cli and port > 0

func base_url() -> String:
	return "http://%s:%d" % [host, port]

func _load() -> void:
	if not FileAccess.file_exists(CONFIG_PATH):
		return
	var f := FileAccess.open(CONFIG_PATH, FileAccess.READ)
	if f == null:
		return
	var parsed: Variant = JSON.parse_string(f.get_as_text())
	f.close()
	if typeof(parsed) != TYPE_DICTIONARY:
		push_warning("[AppConfig] config.json 不是对象，忽略")
		return
	var d: Dictionary = parsed
	host = d.get("host", host)
	api_key = d.get("api_key", api_key)
	port = int(d.get("port", port))
	console_url = d.get("console_url", console_url)
	prefer_keyword = d.get("prefer_keyword", prefer_keyword)
	text_cps = float(d.get("text_cps", text_cps))
	dialogue_lines = int(d.get("dialogue_lines", dialogue_lines))
	busy_hint_delay = float(d.get("busy_hint_delay", busy_hint_delay))
	send_scene_prompt = bool(d.get("send_scene_prompt", send_scene_prompt))
	scene_prompt = d.get("scene_prompt", scene_prompt)
	font_size = int(d.get("font_size", font_size))
	debug_overlay = bool(d.get("debug_overlay", debug_overlay))
	user_name = d.get("user_name", user_name)

## 将当前配置写入 user://config.json。
## 返回 Error，调用方可以在失败时保持编辑界面和原内存配置不变。
func save() -> Error:
	var d := {
		"host": host,
		"api_key": api_key,
		"port": port,
		"console_url": console_url,
		"prefer_keyword": prefer_keyword,
		"text_cps": text_cps,
		"dialogue_lines": dialogue_lines,
		"busy_hint_delay": busy_hint_delay,
		"send_scene_prompt": send_scene_prompt,
		"scene_prompt": scene_prompt,
		"font_size": font_size,
		"debug_overlay": debug_overlay,
		"user_name": user_name,
	}
	var f := FileAccess.open(CONFIG_PATH, FileAccess.WRITE)
	if f == null:
		push_warning("[AppConfig] 无法写入 config.json")
		return ERR_CANT_OPEN
	f.store_string(JSON.stringify(d, "  "))
	var write_error := f.get_error()
	f.close()
	if write_error != OK:
		push_warning("[AppConfig] 写入 config.json 失败（%s）" % error_string(write_error))
		return write_error
	return OK

func _apply_cmdline() -> void:
	for arg in OS.get_cmdline_user_args():
		var s := String(arg)
		if s.begins_with("--api-key="):
			api_key = s.substr(10)
		elif s.begins_with("--port="):
			port = int(s.substr(7))
			_port_from_cli = true
		elif s.begins_with("--host="):
			host = s.substr(7)
		elif s.begins_with("--console-url="):
			console_url = s.substr(14).strip_edges().trim_suffix("/")
		elif s.begins_with("--session-id="):
			session_id = s.substr(13)
		elif s.begins_with("--assistant-name="):
			assistant_name = s.substr(17)
		elif s == "--debug-overlay":
			debug_overlay = true
		elif s == "--scene-prompt":
			send_scene_prompt = true
		elif s == "--demo":
			demo_mode = true
		elif s == "--show-create":
			show_create_on_start = true   # 开发用：截图创建面板
		elif s == "--picker":
			_port_from_cli = false   # 强制回到选择面板
		elif s.begins_with("--screenshot="):
			screenshot_path = s.substr(13)
		elif s.begins_with("--screenshot-delay="):
			screenshot_delay = float(s.substr(19))
		elif s.begins_with("--simulate-clicks="):
			simulate_clicks = int(s.substr(18))
