extends Node
## 无网络单元测试。跑法：
##   Godot --headless --path client res://tests/run_tests.tscn
##
## 覆盖的都是最容易静默出错的地方：
##  · SSE 分片跨 UTF-8 字符边界（中文乱码）
##  · 思考/工具事件是否真的被丢掉
##  · 内联标记跨 delta 截断
##  · 分页边界是否稳定（不会回跳重排）

var _pass := 0
var _fail := 0

class RecordingTownClient extends StageChannelClient:
	var sent: Array[Dictionary] = []
	func _send(frame: Dictionary) -> void:
		sent.append(frame)

func _ready() -> void:
	print("\n════ assistant-vn 单元测试 ════\n")
	_test_sse_utf8_split()
	_test_sse_multi_frame()
	_test_filter_hides_thinking_and_tools()
	_test_assembler_marker_split()
	_test_assembler_plain()
	_test_height_paginator()
	_test_sanitizer()
	_test_stage_multi_assistant()
	_test_stage_catalog()
	_test_event_bus_routes()
	_test_stage_handshake()
	_test_console_targets()
	print("\n════ %d 通过 / %d 失败 ════\n" % [_pass, _fail])
	quit_with_code()

func quit_with_code() -> void:
	var code := 0 if _fail == 0 else 1
	get_tree().quit(code)


func _test_console_targets() -> void:
	var main = load("res://scenes/main.gd").new()
	var old_url := AppConfig.console_url
	AppConfig.console_url = "https://[::1]:3443/console"
	var target: Dictionary = main._resolve_ws_target({"gatewayWsPath": "/a/test/ws", "host": "127.0.0.1", "port": 3001})
	_check("IPv6 网关使用正确主机和端口", target.get("host") == "[::1]" and target.get("port") == 3443)
	_check("网关保留 HTTPS 与反向代理路径前缀", target.get("secure") == true and target.get("wsPath") == "/console/a/test/ws")
	target = main._resolve_ws_target({"host": "127.0.0.1", "port": 3001, "channelEndpoints": [{"id": "stage", "protocol": "ws", "host": "127.0.0.1", "port": 4321, "path": "/ws"}]})
	_check("直连使用 Stage 端点而非管理端口", target.get("port") == 4321 and target.get("wsPath") == "/ws")
	AppConfig.console_url = old_url
	main.free()


func _test_stage_handshake() -> void:
	var client := RecordingTownClient.new()
	var ready: Array = []
	client.connected.connect(func(): ready.append(true))
	client._environment = StageCatalog.environment_for(StageCatalog.default_stage())
	client._handle(JSON.stringify({"type": "hello_ack"}))
	_check("通信握手不直接宣告场景就绪", ready.is_empty())
	_check("连接后独立注册客户端环境", client.sent.size() == 1 and client.sent[0].type == "stage_register")
	_check("环境包含客户端场景说明", client.sent[0].stage.environment.text.contains("萤火镇"))
	client._handle(JSON.stringify({"type": "stage_register_result", "requestId": "other", "result": {"kind": "registered"}}))
	_check("忽略无关注册回执", client.sent.size() == 1)
	client._handle(JSON.stringify({"type": "stage_register_result", "requestId": "initial-register", "result": {"kind": "registered"}}))
	_check("注册成功后才请求激活", client.sent.size() == 2 and client.sent[1].type == "stage_activate" and ready.is_empty())
	var activated := JSON.stringify({"type": "stage_activate_result", "requestId": "initial-activate", "result": {"kind": "changed"}})
	client._handle(activated)
	client._handle(activated)
	_check("激活回执只触发一次就绪", ready.size() == 1)
	client.send_event({"kind": "user_said", "text": "你好"})
	_check("场景事件携带路由 Stage ID", client.sent.back().stageId == client._stage_id)
	client._handle(JSON.stringify({"type": "command", "commandId": "stale", "stageId": "another-town", "command": "say", "args": {}}))
	_check("拒绝发给其他场景的动作", client.sent.back().type == "command_result" and client.sent.back().ok == false)
	_check("助手列表识别 Stage Channel", ConsoleApi.has_ws({"channels": ["http", "stage"]}))
	_check("HTTP Channel 不代表可进入舞台", not ConsoleApi.has_ws({"channels": ["http"]}))
	_check("端点元数据优先判断 Stage", ConsoleApi.has_ws({"channelEndpoints": [{"id": "stage", "protocol": "ws", "host": "127.0.0.1", "port": 3002, "path": "/ws"}]}))
	_check("空端点元数据表示 Stage 禁用", not ConsoleApi.has_ws({"channels": ["stage"], "channelEndpoints": []}))
	client.free()

	var failed := RecordingTownClient.new()
	var errors: Array = []
	failed.disconnected.connect(func(reason): errors.append(reason))
	failed._handle(JSON.stringify({"type": "hello_ack"}))
	failed._handle(JSON.stringify({"type": "stage_register_result", "requestId": "initial-register", "result": {"kind": "rejected", "reason": "conflict"}}))
	_check("注册被拒不激活并报告失败", failed.sent.size() == 1 and errors.size() == 1 and not failed._acknowledged)
	failed.free()

	var observer := RecordingTownClient.new()
	observer._role = "user"
	observer._handle(JSON.stringify({"type": "hello_ack"}))
	observer._handle(JSON.stringify({"type": "stage_register_result", "requestId": "initial-register", "result": {"kind": "registered"}}))
	_check("玩家观察连接不自动切换助手场景", observer._acknowledged and observer.sent.size() == 1)
	observer.free()


# ── SSE：最高风险区 ─────────────────────────────────────────

func _test_sse_utf8_split() -> void:
	# 「你好世界」的 UTF-8 是 12 字节。故意把一个汉字劈成两半分两次投喂。
	var sse := SseClient.new()
	var got: Array[Dictionary] = []
	sse.frame_received.connect(func(f): got.append(f))

	var payload := 'data: {"type":"chunk","data":{"kind":"text-delta","text":"你好世界"}}' + "\n\n"
	var all := payload.to_utf8_buffer()
	# 在第 40 字节处切断 —— 大概率落在某个汉字中间
	var cut := 40
	sse._bytes = all.slice(0, cut)
	sse._drain()
	_check("UTF-8 半包时不应产出帧", got.size() == 0)

	sse._bytes.append_array(all.slice(cut))
	sse._drain()
	_check("补齐后应产出 1 帧", got.size() == 1)
	if got.size() == 1:
		var txt := String(got[0]["data"]["text"])
		_check("中文未乱码（得到 '%s'）" % txt, txt == "你好世界")

func _test_sse_multi_frame() -> void:
	var sse := SseClient.new()
	var got: Array[Dictionary] = []
	sse.frame_received.connect(func(f): got.append(f))
	var s := ""
	s += 'data: {"type":"turn_start","data":{"turn":1}}' + "\n\n"
	s += 'data: {"type":"chunk","data":{"kind":"text-delta","text":"嗯"}}' + "\n\n"
	s += 'data: {"type":"turn_end","data":{"turn":1}}' + "\n\n"
	sse._bytes = s.to_utf8_buffer()
	sse._drain()
	_check("一次投喂应切出 3 帧", got.size() == 3)
	_check("缓冲应被清空", sse._bytes.size() == 0)


# ── 过滤：核心需求 ──────────────────────────────────────────

func _test_filter_hides_thinking_and_tools() -> void:
	var reasoning := PresentationFilter.judge({
		"type": "chunk",
		"data": {"kind": "reasoning-delta", "text": "让我想想用户到底要什么…"},
	})
	_check("reasoning 不产生台词", reasoning["verdict"] == PresentationFilter.Verdict.BUSY_THINKING)
	_check("reasoning 的文本被丢弃", String(reasoning["text"]).is_empty())

	var tc := PresentationFilter.judge({
		"type": "tool_call",
		"data": {"name": "read_file", "arguments": {"path": "/etc/passwd"}},
	})
	_check("tool_call 不产生台词", tc["verdict"] == PresentationFilter.Verdict.BUSY_WORKING)
	_check("tool_call 的文本被丢弃", String(tc["text"]).is_empty())

	var tr := PresentationFilter.judge({"type": "tool_result", "data": {"name": "read_file"}})
	_check("tool_result 不产生台词", String(tr["text"]).is_empty())

	var spoke := PresentationFilter.judge({
		"type": "chunk",
		"data": {"kind": "text-delta", "text": "好了"},
	})
	_check("text-delta 才上屏", spoke["verdict"] == PresentationFilter.Verdict.SPEAK)
	_check("text-delta 内容保留", String(spoke["text"]) == "好了")

	var unknown := PresentationFilter.judge({"type": "some_future_event", "data": {}})
	_check("未知帧被忽略而不是兜底显示", unknown["verdict"] == PresentationFilter.Verdict.DISCARD)


# ── 内联标记 ───────────────────────────────────────────────

func _test_assembler_marker_split() -> void:
	var a := StreamAssembler.new()
	var emotions: Array[String] = []
	a.emotion_marked.connect(func(n): emotions.append(n))

	# 标记被劈成三段投喂
	var out := ""
	out += a.push("今天也")
	out += a.push("辛苦了[[")
	out += a.push("hap")
	out += a.push("py]]呀")
	out += a.flush()

	_check("标记不上屏（得到 '%s'）" % out, out == "今天也辛苦了呀")
	_check("情绪被识别", emotions.size() == 1 and emotions[0] == "happy")
	_check("累积文本正确", a.text == "今天也辛苦了呀")

func _test_assembler_plain() -> void:
	var a := StreamAssembler.new()
	var out := a.push("普通文本") + a.push("没有标记") + a.flush()
	_check("无标记时原样通过", out == "普通文本没有标记")

	# 孤立的 [ 不应该把后面的字永久扣住
	var b := StreamAssembler.new()
	var o2 := b.push("数组 [1, 2, 3] 就这样") + b.flush()
	_check("孤立方括号不吞字（得到 '%s'）" % o2, o2 == "数组 [1, 2, 3] 就这样")


# ── 分页（按实际渲染高度）───────────────────────────────────

func _font() -> Font:
	return ThemeDB.fallback_font

## 换行必须是硬分页点。
## 这个 bug 真实发生过：模型回「…比如：\n- 写代码\n- 查资料」，
## 换行后的内容挤在同一页超出对话框高度，被**静默裁掉**，
## 用户完全不知道有内容没显示。
func _test_height_paginator() -> void:
	var f := _font()
	_check("拿到字体（度量的前提）", f != null)
	if f == null:
		return

	# 一行的高度：必须用 HeightPaginator 的度量，不能用 font.get_height()
	var line_h := HeightPaginator.line_height(f, 20)
	var three_lines := HeightPaginator.height_for_lines(f, 20, 3)
	_check("行高与 get_height 的差异被处理（%.1f vs %.1f）" % [line_h, f.get_height(20)],
		line_h >= f.get_height(20))
	_check("三行高度 = 3 × 行高", is_equal_approx(three_lines, line_h * 3.0))

	var reply := "你好！我是 AI 助手，可以帮你完成各种任务，比如：\n- 写代码\n- 查资料"
	var pages := HeightPaginator.paginate(reply, f, 20, 600.0, three_lines)
	_check("换行被切成 3 页（得到 %d 页）" % pages.size(), pages.size() == 3)
	_check("第一页只到冒号", pages.size() > 0 and pages[0].ends_with("比如："))
	var no_nl := true
	for p in pages:
		if p.contains("\n"):
			no_nl = false
	_check("每页内部不含换行", no_nl)

	# 空行不产生空页
	_check("空行不产生空页",
		HeightPaginator.paginate("第一段\n\n\n第二段", f, 20, 600.0, three_lines).size() == 2)

	# 每一页都必须真的放得下
	var long_text := "这是一段很长的话，".repeat(40)
	var lp := HeightPaginator.paginate(long_text, f, 20, 400.0, three_lines)
	_check("长文本被切成多页（得到 %d 页）" % lp.size(), lp.size() >= 2)
	var all_fit := true
	for p in lp:
		if f.get_multiline_string_size(p, HORIZONTAL_ALIGNMENT_LEFT, 400.0, 20).y > three_lines:
			all_fit = false
	_check("每一页都真的放得下（不会被裁）", all_fit)

	var joined := ""
	for p in lp:
		joined += p
	_check("分页不丢字", joined.replace(" ", "") == long_text.replace(" ", ""))

	# 窄窗口该切得更碎 —— 这正是字数预算做不到的
	var narrow := HeightPaginator.paginate(long_text, f, 20, 200.0, three_lines)
	_check("窄窗口页数更多（%d > %d）" % [narrow.size(), lp.size()], narrow.size() > lp.size())

	# 宽窗口一页能装更多
	var wide := HeightPaginator.paginate(long_text, f, 20, 900.0, three_lines)
	_check("宽窗口页数更少（%d < %d）" % [wide.size(), lp.size()], wide.size() < lp.size())

	# 行数配置生效。**一行必须真的能放下一整行的字**，
	# 而不是退化成每页一个字（这曾经真的发生过：360 页）
	var one_line := HeightPaginator.paginate(long_text, f, 20, 400.0, line_h)
	_check("只给一行时页数更多（%d > %d）" % [one_line.size(), lp.size()],
		one_line.size() > lp.size())
	_check("一行页数约为三行的 3 倍（%d vs %d）—— 不是退化成每页一字" % [one_line.size(), lp.size()],
		one_line.size() <= lp.size() * 4)
	_check("单行页不止一个字（第一页 %d 字）" % one_line[0].length(), one_line[0].length() > 3)

	_check("空文本不产生页", HeightPaginator.paginate("   ", f, 20, 400.0, three_lines).is_empty())
	_check("宽度无效时安全返回空",
		HeightPaginator.paginate("有内容", f, 20, 0.0, three_lines).is_empty())


# ── Markdown 清理 ──────────────────────────────────────────

func _test_sanitizer() -> void:
	var md := "## 标题\n\n- 第一点\n- 第二点\n\n```py\nprint(1)\n```\n\n**结束**了"
	var out := TextSanitizer.to_speech(md)
	_check("井号被去掉", not out.contains("#"))
	_check("项目符号被去掉", not out.contains("- "))
	_check("代码块被摘掉", not out.contains("print(1)"))
	_check("代码块留下提示", out.contains("代码略"))
	_check("强调标记被去掉", not out.contains("**"))


# ── Stage 多助手 ───────────────────────────────────────────

func _test_stage_multi_assistant() -> void:
	var st := Stage.new()
	add_child(st)
	st.create_scene("s", "S", "")
	st.switch_scene("s")
	_check("默认空助手列表", st.list_assistants().is_empty())

	st.add_assistant("s", "a1", "甲", "", 0.3, 0.8, "木匠")
	st.add_assistant("s", "a2", "乙", "", 0.7, 0.8)
	_check("添加两个助手后列表长度=2", st.list_assistants().size() == 2)

	var m1 := st.get_assistant_meta("s", "a1")
	_check("助手甲位置 x=0.30", is_equal_approx(float(m1.get("x", -1)), 0.3))
	_check("NPC 职业保存在 Stage 中", String(m1.get("profession", "")) == "木匠")

	st.move_assistant("s", "a1", 0.5, 0.5)
	m1 = st.get_assistant_meta("s", "a1")
	_check("move_assistant 更新 x", is_equal_approx(float(m1.get("x", -1)), 0.5))
	_check("move_assistant 更新 y", is_equal_approx(float(m1.get("y", -1)), 0.5))

	st.remove_assistant("s", "a2")
	_check("移除后剩 1 个", st.list_assistants().size() == 1)

	# 物件 API 不变
	st.add_object("s", "obj1", "", 0.5, 0.5, 100.0, {})
	_check("add_object 成功", not st.get_object("s", "obj1").is_empty())
	st.remove_object("s", "obj1")
	_check("remove_object 成功", st.get_object("s", "obj1").is_empty())

	# 持久化往返
	st.add_assistant("s", "a3", "丙", "", 0.2, 0.7)
	var sheet_path := ProjectSettings.globalize_path("user://test-sprite-sheet.png")
	var animation_path := ProjectSettings.globalize_path("user://test-sprite-animation.json")
	var sheet := Image.create(32, 32, false, Image.FORMAT_RGBA8)
	sheet.fill(Color(0.9, 0.3, 0.1, 0.8))
	var save_error := sheet.save_png(sheet_path)
	var manifest := {
		"version": 1, "type": "sprite-sheet", "sheet": sheet_path,
		"columns": 4, "rows": 4, "frameWidth": 8, "frameHeight": 8,
		"defaultAnimation": "idle_down",
		"animations": {
			"walk_down": {"row": 0, "frames": [0, 1, 2, 3], "fps": 8},
			"walk_left": {"row": 1, "frames": [0, 1, 2, 3], "fps": 8},
			"walk_right": {"row": 2, "frames": [0, 1, 2, 3], "fps": 8},
			"walk_up": {"row": 3, "frames": [0, 1, 2, 3], "fps": 8},
			"idle_down": {"row": 0, "frames": [0], "fps": 1},
			"idle_left": {"row": 1, "frames": [0], "fps": 1},
			"idle_right": {"row": 2, "frames": [0], "fps": 1},
			"idle_up": {"row": 3, "frames": [0], "fps": 1},
		},
	}
	var manifest_file := FileAccess.open(animation_path, FileAccess.WRITE)
	if manifest_file != null:
		manifest_file.store_string(JSON.stringify(manifest))
		manifest_file.close()
	var animation_error := st.set_assistant_animation("s", "a3", animation_path)
	_check("Stage 可加载固定 4×4 NPC 序列帧", save_error == OK and animation_error.is_empty())
	_check("动画路径写入助手身份", String(st.get_assistant_meta("s", "a3").get("animationPath", "")) == animation_path)
	var snap := st.snapshot()
	var st2 := Stage.new()
	add_child(st2)
	st2.restore(snap)
	_check("restore 后 a3 存在", st2.get_assistant_meta("", "a3").size() > 0)
	_check("restore 保留 NPC 动画路径", String(st2.get_assistant_meta("", "a3").get("animationPath", "")) == animation_path)
	DirAccess.remove_absolute(sheet_path)
	DirAccess.remove_absolute(animation_path)
	st2.queue_free()
	st.queue_free()


# ── Stage 目录与能力隔离 ───────────────────────────────────

func _test_stage_catalog() -> void:
	var town := StageCatalog.get_stage("town:ai-meadow")
	_check("AI 小镇可从 StageCatalog 选择", not town.is_empty())
	_check("AI 小镇有独立背景", String(town.get("background", "")).ends_with("ai_meadow_town.png"))
	_check("AI 小镇声明 8 个互动地点", town.get("objects", []).size() == 8)
	var names: Array[String] = []
	for command_any in town.get("commands", []):
		var command: Dictionary = command_any
		names.append(String(command.get("name", "")))
	_check("场景要求助手先 enter_stage", names.has("enter_stage"))
	_check("小镇提供地点互动能力", names.has("interact_at"))
	_check("场景不把 create_scene 暴露给助手", not names.has("create_scene"))


# ── SceneEventBus 路由 ─────────────────────────────────────

func _test_event_bus_routes() -> void:
	var bus := SceneEventBus.new()
	add_child(bus)
	var got := []
	bus.user_said.connect(func(t, tg): got.append(["user", t, tg]))
	bus.assistant_joined.connect(func(m): got.append(["join", m]))
	bus.assistant_left.connect(func(a): got.append(["left", a]))
	bus.llm_event_received.connect(func(ev, from_id): got.append(["llm", ev, from_id]))

	bus.emit_user_said("hello", "a1")
	bus.dispatch_assistant_joined({"assistantId": "a2"})
	bus.dispatch_assistant_left("a2")
	bus.dispatch_llm_event({"type": "chunk"}, "a1")

	_check("事件总线触发 4 次", got.size() == 4)
	_check("user_said 触发", got[0][0] == "user" and got[0][2] == "a1")
	_check("joined 触发", got[1][0] == "join")
	_check("left 触发", got[2][0] == "left")
	_check("llm_event 触发", got[3][0] == "llm" and got[3][2] == "a1")
	bus.queue_free()


# ── 断言 ───────────────────────────────────────────────────

func _check(what: String, ok: bool) -> void:
	if ok:
		_pass += 1
		print("  ✓ %s" % what)
	else:
		_fail += 1
		printerr("  ✗ %s" % what)
