extends Node
## Confirms transport clientId is unique per Godot manager while participant identity
## remains the same semantic assistantId in the StageChannel hello.

const EventBusScript = preload("res://core/scene/event_bus.gd")
const ManagerScript = preload("res://core/scene/vn_client_manager.gd")


func _ready() -> void:
	var bus_a = EventBusScript.new()
	var bus_b = EventBusScript.new()
	var manager_a = ManagerScript.new()
	var manager_b = ManagerScript.new()
	add_child(bus_a)
	add_child(bus_b)
	add_child(manager_a)
	add_child(manager_b)
	manager_a.setup("127.0.0.1", 1, bus_a, "town:probe", "town")
	manager_b.setup("127.0.0.1", 1, bus_b, "town:probe", "town")
	var id_a: String = manager_a._transport_client_id("assistant", "same-assistant")
	var id_b: String = manager_b._transport_client_id("assistant", "same-assistant")
	if id_a == id_b:
		_fail("two Godot managers reused transport clientId " + id_a)
		return
	if not id_a.ends_with(":assistant:same-assistant") or not id_b.ends_with(":assistant:same-assistant"):
		_fail("transport role/participant suffix missing")
		return
	if manager_a._transport_client_id("assistant", "same-assistant") != id_a:
		_fail("transport identity changed within one manager")
		return
	print("[identity-probe] PASS a=%s b=%s participant=same-assistant" % [id_a, id_b])
	get_tree().quit(0)


func _fail(message: String) -> void:
	printerr("[identity-probe] FAIL " + message)
	get_tree().quit(1)
