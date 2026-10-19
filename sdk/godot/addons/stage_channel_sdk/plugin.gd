@tool
extends EditorPlugin
## StageChannelSdk 的最小 EditorPlugin 实现。
##
## SDK 本身只是普通 class_name 脚本（StageChannelProtocol / StageChannelClient /
## StageChannelDiscovery），不需要编辑器钩子；启用插件只是为了在 Godot 编辑器里
## 显示项目设置面板中的插件条目。

const ADDON_NAME := "StageChannelSdk"


func _enter_tree() -> void:
	# 没有要注册的单例 / 导入插件：脚本通过 class_name 全局可用。
	pass


func _exit_tree() -> void:
	pass
