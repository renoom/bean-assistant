extends RefCounted
class_name HeightPaginator
## 按**实际渲染高度**分页，而不是按固定字数。
##
## 为什么不能用字数预算：一行能放多少字取决于窗口宽度和字号。
## 同一个 78 字预算，在宽窗口下只占半屏（显得很空），
## 在窄窗口下又会溢出被裁掉。
##
## 翻页的两个标准（用户定的）：
##   1. **装不下** —— 按字体度量算出的高度超过可视高度
##   2. **原文有换行** —— \n 是硬分页点，一个自然段一页
##
## 用 Font.get_multiline_string_size() 做度量：纯字体度量，同步返回，
## 不依赖节点是否已经布局完成，也不用等下一帧。

## 找不到断点时，允许从上限往前回退的最大字符数
const BACKTRACK := 12

## 量行高用的样本：**必须同时含中文和拉丁字母**。
## 实测（Godot 4.7 fallback 字体，size=20）：
##   font.get_height(20)                    = 28.00
##   get_multiline_string_size("X").y       = 28.00
##   get_multiline_string_size("测试").y    = 29.00   ← 中文回退字体高 1px
## 用 get_height() 算「3 行的高度」会得到 84，而三行中文实际要 87，
## 结果就是只放得下 2 行（内容显得很空）；
## 如果可视高度恰好等于 28，一个中文字都放不下，会退化成每页一个字。
const LINE_SAMPLE := "中A"

const BREAKERS := ["。", "！", "？", "…", "；", ".", "!", "?", ";"]
const SOFT_BREAKERS := ["，", "、", ",", "：", ":", " ", ")", "）"]

## 一行的实际高度。和分页用的是同一个度量 API，两者不会打架。
static func line_height(font: Font, font_size: int) -> float:
	if font == null:
		return float(font_size) * 1.4
	return font.get_multiline_string_size(
		LINE_SAMPLE, HORIZONTAL_ALIGNMENT_LEFT, 99999.0, font_size
	).y

## n 行需要多高
static func height_for_lines(font: Font, font_size: int, lines: int) -> float:
	return line_height(font, font_size) * float(maxi(1, lines))


static func paginate(
	text: String,
	font: Font,
	font_size: int,
	width: float,
	max_height: float,
) -> PackedStringArray:
	var pages: PackedStringArray = []
	if text.strip_edges().is_empty() or font == null or width <= 1.0 or max_height <= 1.0:
		return pages

	for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
		var para := String(raw).strip_edges()
		if para.is_empty():
			continue
		for p in _split_paragraph(para, font, font_size, width, max_height):
			pages.append(p)
	return pages

static func _split_paragraph(
	para: String, font: Font, font_size: int, width: float, max_height: float
) -> PackedStringArray:
	var out: PackedStringArray = []
	var rest := para

	while not rest.is_empty():
		if _fits(rest, font, font_size, width, max_height):
			out.append(rest)
			break

		var n := _max_fitting(rest, font, font_size, width, max_height)
		if n <= 0:
			# 连一个字都放不下（高度配得太小）——强行切一个，避免死循环
			n = 1
		else:
			n = _adjust_to_break(rest, n)

		out.append(rest.substr(0, n).strip_edges())
		rest = rest.substr(n).strip_edges()

	return out

static func _fits(
	s: String, font: Font, font_size: int, width: float, max_height: float
) -> bool:
	var h := font.get_multiline_string_size(
		s, HORIZONTAL_ALIGNMENT_LEFT, width, font_size
	).y
	# 留 0.5 的容差，避免浮点噪声让恰好一行放不下
	return h <= max_height + 0.5

## 二分找「最长的能放下的前缀」长度
static func _max_fitting(
	s: String, font: Font, font_size: int, width: float, max_height: float
) -> int:
	var lo := 0
	var hi := s.length()
	while lo < hi:
		var mid := (lo + hi + 1) / 2
		if _fits(s.substr(0, mid), font, font_size, width, max_height):
			lo = mid
		else:
			hi = mid - 1
	return lo

## 把切点往前挪到标点处，避免把词句切得太难看
static func _adjust_to_break(s: String, n: int) -> int:
	var floor_n := maxi(1, n - BACKTRACK)
	for i in range(n, floor_n - 1, -1):
		if i <= 0 or i > s.length():
			continue
		if s.substr(i - 1, 1) in BREAKERS:
			return i
	for i in range(n, floor_n - 1, -1):
		if i <= 0 or i > s.length():
			continue
		if s.substr(i - 1, 1) in SOFT_BREAKERS:
			return i
	return n
