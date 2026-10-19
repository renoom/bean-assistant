extends RefCounted
class_name StreamAssembler
## 把 text-delta 拼成台词，并就地剥离内联情绪标记。
##
## 内联标记（如 [[happy]]）的设计理由见 docs/design.md §9.3：
## 情绪切换是最高频操作，走工具的话每次都是一个完整 LLM 往返，
## 而且只能在整句前后变。走标记则零延迟、能在句子中间变脸。
##
## 难点是**跨 delta 截断**：「[[hap」和「py]]」可能落在两个 chunk 里。
## 处理办法是「未闭合缓冲」—— 结尾出现可能是标记前缀的片段就先扣住
## 不上屏，等下一个 delta 拼上来再判定。

signal emotion_marked(name: String)

const OPEN := "[["
const CLOSE := "]]"
## 标记名的长度上限，超过就认定不是标记（防止一个孤立的 [[ 把后面全扣住）
const MAX_MARKER := 24

## 已确认可以上屏的完整台词
var text: String = ""
## 扣住待定的尾巴（可能是半个标记）
var _pending: String = ""

func reset() -> void:
	text = ""
	_pending = ""

## 喂一段增量，返回**本次新增的可上屏文本**
func push(delta: String) -> String:
	_pending += delta
	var emitted := ""

	while true:
		var open_at := _pending.find(OPEN)
		if open_at < 0:
			# 没有标记开头。但结尾可能是「[」，那要留着等下一段
			var safe := _pending
			var hold := ""
			if _pending.ends_with("["):
				safe = _pending.substr(0, _pending.length() - 1)
				hold = "["
			emitted += safe
			_pending = hold
			break

		# 标记之前的文本可以放行
		if open_at > 0:
			emitted += _pending.substr(0, open_at)
			_pending = _pending.substr(open_at)
			continue

		# _pending 以 "[[" 开头，找闭合
		var close_at := _pending.find(CLOSE, OPEN.length())
		if close_at < 0:
			# 还没闭合。如果已经攒得太长，判定它不是标记，原样放行
			if _pending.length() > OPEN.length() + MAX_MARKER:
				emitted += _pending
				_pending = ""
			break

		var name := _pending.substr(OPEN.length(), close_at - OPEN.length()).strip_edges()
		_pending = _pending.substr(close_at + CLOSE.length())
		if not name.is_empty():
			emotion_marked.emit(name)
		# 标记本身不上屏，继续处理剩下的

	text += emitted
	return emitted

## turn 结束时调用：把仍然扣住的尾巴按普通文本吐出来
func flush() -> String:
	var rest := _pending
	_pending = ""
	text += rest
	return rest
