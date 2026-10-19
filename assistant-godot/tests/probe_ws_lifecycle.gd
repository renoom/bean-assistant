extends Node
## Local-only StageChannel probe. A sibling Node test owns the loopback server, so this
## never discovers or contacts a real assistant.

const EXPECTED_LARGE_TEXT_BYTES := 128 * 1024
const EXPECTED_BURST_EVENTS := 256
const StageChannelClientScript = preload("res://core/transport/stage_channel.gd")

var client: Node
var _connected := false
var _large_received := false
var _burst_received := 0
var _expected_close_code := 0
var _expect_oversize := false


func _ready() -> void:
	var args := _arguments()
	var port := int(args.get("port", "0"))
	_expected_close_code = int(args.get("close-code", "0"))
	_expect_oversize = args.get("expect-oversize", "false") == "true"
	if port <= 0:
		_fail("missing --port")
		return

	var defaults := WebSocketPeer.new()
	print("[ws-probe] defaults inbound=%d outbound=%d queued=%d" % [
		defaults.inbound_buffer_size,
		defaults.outbound_buffer_size,
		defaults.max_queued_packets,
	])

	client = StageChannelClientScript.new()
	add_child(client)
	client.connected.connect(func():
		_connected = true
		print("[ws-probe] handshake complete")
	)
	client.llm_event_received.connect(_on_llm_event)
	client.disconnected.connect(_on_disconnected)
	client.open("127.0.0.1", port, "godot-probe-instance", [{"name": "probe"}],
		"assistant", "probe-participant", "Lifecycle probe", "", "town:probe", "town",
		{"text": "isolated loopback probe"})
	if args.get("legacy-buffer", "false") == "true":
		client._peer.inbound_buffer_size = 65535
		client._peer.outbound_buffer_size = 65535

	print("[ws-probe] configured inbound=%d outbound=%d queued=%d" % [
		client._peer.inbound_buffer_size,
		client._peer.outbound_buffer_size,
		client._peer.max_queued_packets,
	])

	await get_tree().create_timer(12.0).timeout
	_fail("timeout connected=%s large=%s burst=%d" % [_connected, _large_received, _burst_received])


func _process(_delta: float) -> void:
	if client != null:
		client.poll()


func _on_llm_event(event: Dictionary) -> void:
	var kind := String(event.get("type", ""))
	if kind == "large":
		var text := String(event.get("data", {}).get("text", ""))
		_large_received = text.to_utf8_buffer().size() == EXPECTED_LARGE_TEXT_BYTES
	elif kind == "burst":
		_burst_received += 1
	if _large_received and _burst_received == EXPECTED_BURST_EVENTS:
		print("[ws-probe] complete large_bytes=%d burst=%d" % [EXPECTED_LARGE_TEXT_BYTES, _burst_received])


func _on_disconnected(reason: String) -> void:
	print("[ws-probe] disconnected " + reason)
	if _expect_oversize:
		if not _connected or _large_received:
			_fail("legacy limit did not reject oversized frame")
			return
		print("[ws-probe] legacy oversized frame reproduced")
		get_tree().quit(0)
	elif _expected_close_code > 0:
		if not reason.contains("code=%d" % _expected_close_code) or not reason.contains("probe shutdown"):
			_fail("close detail missing: " + reason)
			return
		if not _connected or not _large_received or _burst_received != EXPECTED_BURST_EVENTS:
			_fail("closed before payload complete")
			return
		get_tree().quit(0)
	elif not _connected:
		# Connection failures before STATE_OPEN must still surface immediately.
		get_tree().quit(0)
	else:
		_fail("unexpected disconnect: " + reason)


func _arguments() -> Dictionary:
	var parsed := {}
	for arg in OS.get_cmdline_user_args():
		var value := String(arg)
		if not value.begins_with("--") or not value.contains("="):
			continue
		var separator := value.find("=")
		parsed[value.substr(2, separator - 2)] = value.substr(separator + 1)
	return parsed


func _fail(message: String) -> void:
	printerr("[ws-probe] FAIL " + message)
	get_tree().quit(1)
