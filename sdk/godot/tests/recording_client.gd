extends "res://addons/stage_channel_sdk/stage_channel_client.gd"
## 无网络单测用：记录所有出站帧，不真正写 WebSocket。

var sent: Array = []


func _send(frame: Dictionary) -> void:
	sent.append(frame)
