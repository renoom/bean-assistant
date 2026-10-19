extends Node
class_name SceneEventBus
## Godot 内部事件总线。
##
## 把「场景里发生的事」「玩家做的事」「助手加入/离开」「LLM 事件流」聚合成信号，
## 让 main.gd / Stage 等订阅方专心做渲染和路由，避免在多处互相连线。
##
## 路由规则（在 Godot 端判定，不依赖服务端）：
##   - 场景级事件（scene_event）：物件/助手操作，玩家本地感知 + 广播给所有助手 ws
##   - user_said：玩家输入栏送出；target=null = 广播；target=某 assistantId = 仅定向该助手
##   - llm_event：服务端推来的 LLM 完整事件流，只进调试面板，不渲染
##   - assistant_joined / left：助手上线/下线的 UI 提示

## 场景级事件（物件/助手操作）。payload = Stage.interaction 的 data + actor + operator。
signal scene_event(scene_id: String, kind: String, payload: Dictionary)
## 玩家说话事件。target=null/"" = 广播；target=<assistantId> = 仅定向该助手。
signal user_said(text: String, target: String)
## 助手入场景（VnClientManager 成功连上一个 assistant ws 后发）。meta = {assistantId, name, spritePath}
signal assistant_joined(meta: Dictionary)
## 助手离场（ws 断开）。assistant_id 为空 = 用户 ws 断了；非空 = 某助手 ws 断了。
signal assistant_left(assistant_id: String)
## 来自某 ws 的 command（已带上 fromWsId）。cmd = {commandId, command, args, fromWsId}
signal command_received(cmd: Dictionary)
## 来自某 ws 的 LLM 完整事件流（调试面板用）。ev = {type, data}，from_ws_id 标识来源助手。
signal llm_event_received(ev: Dictionary, from_ws_id: String)


# ══════════════════════════════════════════════════════════════
#  出站（main.gd 把事件投递进来，由 VnClientManager 监听并分发到 ws）
# ══════════════════════════════════════════════════════════════

func emit_scene_event(scene_id: String, kind: String, payload: Dictionary) -> void:
	scene_event.emit(scene_id, kind, payload)


func emit_user_said(text: String, target: String) -> void:
	user_said.emit(text, target)


# ══════════════════════════════════════════════════════════════
#  入站（VnClientManager 收到 ws 推送后回填到 EventBus，让 main.gd 渲染）
# ══════════════════════════════════════════════════════════════

func dispatch_scene_event(scene_id: String, kind: String, payload: Dictionary) -> void:
	scene_event.emit(scene_id, kind, payload)


func dispatch_assistant_joined(meta: Dictionary) -> void:
	assistant_joined.emit(meta)


func dispatch_assistant_left(assistant_id: String) -> void:
	assistant_left.emit(assistant_id)


func dispatch_command(cmd: Dictionary) -> void:
	command_received.emit(cmd)


func dispatch_llm_event(ev: Dictionary, from_ws_id: String) -> void:
	llm_event_received.emit(ev, from_ws_id)
