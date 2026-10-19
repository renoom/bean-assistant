extends RefCounted
class_name PresentationFilter
## 决定每个 SSE 帧在 VN 界面上该产生什么效果。
##
## 这是「完全不展示工具与思考」这条需求的落点。纯函数，无副作用，
## 不引用任何 Node —— 所以可以在 --headless 下直接单测。
##
## Phase A 里过滤全在客户端做。正式方案里 bridge 会在服务端就丢掉
## reasoning（推理内容在 r1 类模型上可能是正文的数倍，白占带宽），
## 客户端这一层保留为防御性二次过滤。

enum Verdict {
	DISCARD,        ## 丢弃，不产生任何界面变化
	CONNECTED,      ## 握手成功
	TURN_START,     ## 一轮开始 → 进「思考」态
	SPEAK,          ## 台词增量
	BUSY_THINKING,  ## 在想（reasoning）
	BUSY_WORKING,   ## 在干活（工具）
	MESSAGE_END,    ## 一条完整助手消息结束
	TURN_END,       ## 一轮结束
	ERROR,          ## 出错 → 系统吐司，**不当台词**
}

## 返回 { verdict: Verdict, text: String, data: Dictionary }
static func judge(frame: Dictionary) -> Dictionary:
	var t := String(frame.get("type", ""))
	var data: Dictionary = frame.get("data", {}) if typeof(frame.get("data")) == TYPE_DICTIONARY else {}

	match t:
		"connected":
			return _v(Verdict.CONNECTED, "", data)

		"turn_start":
			return _v(Verdict.TURN_START, "", data)

		"chunk":
			var kind := String(data.get("kind", ""))
			match kind:
				"text-delta":
					var txt := String(data.get("text", ""))
					if txt.is_empty():
						return _v(Verdict.DISCARD, "", data)
					return _v(Verdict.SPEAK, txt, data)
				"reasoning-delta":
					# 思考内容在此丢弃。只保留「还在动」这个信号。
					return _v(Verdict.BUSY_THINKING, "", data)
				"tool-call-request":
					return _v(Verdict.BUSY_WORKING, "", data)
				_:
					# usage / finish 之类的元信息
					return _v(Verdict.DISCARD, "", data)

		"tool_call", "tool_result":
			# 工具名、参数、结果一律不上屏
			return _v(Verdict.BUSY_WORKING, "", data)

		"assistant_message":
			return _v(Verdict.MESSAGE_END, "", data)

		"turn_end":
			return _v(Verdict.TURN_END, "", data)

		"error":
			return _v(Verdict.ERROR, String(data.get("message", "未知错误")), data)

		"step_start", "step_end", "status":
			return _v(Verdict.DISCARD, "", data)

		_:
			# 未知帧：忽略，绝不「兜底显示」
			return _v(Verdict.DISCARD, "", data)

static func _v(verdict: int, text: String, data: Dictionary) -> Dictionary:
	return {"verdict": verdict, "text": text, "data": data}
