extends Node
class_name SessionClient
## 门面：对上层只暴露「助手开始说话 / 说了什么 / 在忙 / 说完了」。
## 上层完全看不到 turn、step、chunk、callId 这些协议概念。

signal connected(info: Dictionary)
signal disconnected(reason: String)
signal speak_started()
signal speak_delta(text: String)
signal speak_finished(full_text: String)
signal busy_changed(busy: bool, phase: String)
signal emotion_marked(name: String)
signal failed(message: String)
signal accepted(turn: int)
## 调试用：未经过滤的原始帧。只给 DebugOverlay（F3）看，默认不订阅
signal raw_frame(frame: Dictionary)

var _sse := SseClient.new()
var _api: HttpApi
var _asm := StreamAssembler.new()
var _speaking := false
var _busy := false
var _busy_phase := ""
var _status: Dictionary = {}
## connected 只发一次：SSE 进入 STREAMING 和服务端的 connected 帧
## 是两个独立信号源，都能证明连上了，但上层只该收到一次
var _announced := false

func _ready() -> void:
	# 不传 base：让 HttpApi 每次请求时再从 AppConfig 取，
	# 否则自动发现还没返回端口就被缓存成 0 了
	_api = HttpApi.new()
	add_child(_api)
	_api.message_accepted.connect(func(t): accepted.emit(t))
	_api.message_failed.connect(func(r): failed.emit("发送失败：" + r))
	_api.status_received.connect(_on_status)

	_sse.frame_received.connect(_on_frame)
	_sse.state_changed.connect(_on_sse_state)
	_asm.emotion_marked.connect(func(n): emotion_marked.emit(n))

func open() -> void:
	_announced = false
	_api.fetch_status()
	_sse.open(AppConfig.host, AppConfig.port)

func _process(_dt: float) -> void:
	_sse.poll()

func say(text: String) -> void:
	_api.send_message(text)

func cancel() -> void:
	_api.cancel()

func assistant_name() -> String:
	return String(_status.get("name", "助手"))

func _on_status(s: Dictionary) -> void:
	_status = s

func _on_sse_state(state: int, detail: String) -> void:
	match state:
		SseClient.State.STREAMING:
			_announce()
		SseClient.State.ERROR:
			_announced = false
			disconnected.emit(detail)
		SseClient.State.CLOSED:
			_announced = false
			disconnected.emit(detail if not detail.is_empty() else "连接已关闭")

func _announce() -> void:
	if _announced:
		return
	_announced = true
	connected.emit(_status)

func _on_frame(frame: Dictionary) -> void:
	raw_frame.emit(frame)
	var r := PresentationFilter.judge(frame)
	var v: int = r["verdict"]

	match v:
		PresentationFilter.Verdict.CONNECTED:
			var d: Dictionary = r["data"]
			if not d.is_empty():
				_status.merge(d, true)
			_announce()

		PresentationFilter.Verdict.TURN_START:
			_asm.reset()
			_speaking = false
			_set_busy(true, "thinking")

		PresentationFilter.Verdict.BUSY_THINKING:
			_set_busy(true, "thinking")

		PresentationFilter.Verdict.BUSY_WORKING:
			_set_busy(true, "working")

		PresentationFilter.Verdict.SPEAK:
			if not _speaking:
				_speaking = true
				_set_busy(false, "")
				speak_started.emit()
			var shown: String = _asm.push(String(r["text"]))
			if not shown.is_empty():
				speak_delta.emit(shown)

		PresentationFilter.Verdict.MESSAGE_END:
			_finish_speaking()

		PresentationFilter.Verdict.TURN_END:
			_finish_speaking()
			_set_busy(false, "")

		PresentationFilter.Verdict.ERROR:
			_set_busy(false, "")
			failed.emit(String(r["text"]))

		_:
			pass

func _finish_speaking() -> void:
	if not _speaking:
		return
	var tail := _asm.flush()
	if not tail.is_empty():
		speak_delta.emit(tail)
	_speaking = false
	speak_finished.emit(_asm.text)

func _set_busy(b: bool, phase: String) -> void:
	if _busy == b and _busy_phase == phase:
		return
	_busy = b
	_busy_phase = phase
	busy_changed.emit(b, phase)
