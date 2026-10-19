extends RefCounted
class_name StageCatalog
## 客户端内置 Stage 目录。
##
## Stage 决定背景、互动热点和向助手公开的命令；助手列表来自 Console，
## 两者在启动前没有绑定关系。


static func all() -> Array:
	return [_ai_town(), _blank_stage()]


static func get_stage(stage_id: String) -> Dictionary:
	for stage_any in all():
		var stage: Dictionary = stage_any
		if String(stage.get("id", "")) == stage_id:
			return stage.duplicate(true)
	return {}


static func default_stage() -> Dictionary:
	return _ai_town().duplicate(true)


## 环境知识由客户端提供；服务端不按 town/sandbox 类型硬编码策略。
static func environment_for(stage: Dictionary) -> Dictionary:
	var lines: PackedStringArray = [
		"场景：" + String(stage.get("name", stage.get("id", ""))),
		String(stage.get("description", "")),
		"场景中的可见表达和操作通过 stage_action 调用客户端提供的能力完成。",
		"先用 get_stage_state 查询当前状态；已有 NPC 身体时复用现有形象。",
		"尚未入场时：" + String(stage.get("join_instruction", "")),
	]
	return {"text": "\n".join(lines)}


static func _ai_town() -> Dictionary:
	return {
		"id": "town:ai-meadow",
		"kind": "town",
		"name": "AI 萤火镇",
		"description": "一座供 AI 助手以 NPC 身份生活、交谈和协作的温暖像素小镇。",
		"background": "res://assets/town/ai_meadow_town.png",
		"join_instruction": "你被邀请进入 AI 萤火镇。你必须先调用 draw_sprite_animation，生成代表你自己的原创四方向 NPC 序列帧，再把返回的 metadataPath 作为 animation 传给 stage_action 的 enter_stage。enter_stage 成功前你还没有可见的 NPC 身体，不能说话或进行场景行动。形象应体现你自己的身份、性格和职业。",
		"objects": [
			_hotspot("cafe", "暖阳咖啡馆", 0.28, 0.19, 150.0, "咖啡馆露台", ["点一杯饮品", "和镇民闲聊", "帮忙招待客人"]),
			_hotspot("notice_board", "社区公告栏", 0.20, 0.43, 105.0, "记录小镇委托与公共消息", ["查看委托", "发布消息", "领取任务"]),
			_hotspot("fountain", "星光喷泉", 0.50, 0.48, 145.0, "小镇中央的喷泉与公共广场", ["许愿", "在广场演讲", "休息"]),
			_hotspot("workshop", "齿轮工坊", 0.70, 0.20, 170.0, "发明、修理和制造物品的工坊", ["制作物品", "修理设备", "研究新发明"]),
			_hotspot("greenhouse", "共享温室", 0.91, 0.16, 120.0, "培育特殊植物的玻璃温室", ["照料植物", "采集种子", "观察生长"]),
			_hotspot("garden", "社区菜园", 0.91, 0.31, 130.0, "镇民共同维护的菜园", ["浇水", "播种", "收获"]),
			_hotspot("library", "微光图书馆", 0.87, 0.58, 145.0, "收藏故事、知识与小镇记忆", ["阅读", "查资料", "记录故事"]),
			_hotspot("dock", "河畔木桥", 0.14, 0.83, 120.0, "可以钓鱼、散步和安静思考的河边", ["钓鱼", "散步", "观察河流"]),
		],
		"commands": _town_commands(),
	}


static func _blank_stage() -> Dictionary:
	return {
		"id": "sandbox:blank",
		"kind": "sandbox",
		"name": "空白舞台",
		"description": "没有预设建筑和互动热点，适合只进行对话与 NPC 形象实验。",
		"background": "",
		"join_instruction": "你被邀请进入空白舞台。先调用 draw_sprite_animation 生成代表你自己的原创四方向 NPC 序列帧，再用 stage_action 调用 enter_stage，并把返回的 metadataPath 作为 animation 传入。",
		"objects": [],
		"commands": _base_commands(),
	}


static func _hotspot(id: String, label: String, x: float, y: float, size: float, description: String, actions: Array) -> Dictionary:
	var menu: Array = []
	for action in actions:
		menu.append({"label": String(action), "description": "%s：%s" % [description, action]})
	return {
		"id": id,
		"label": label,
		"x": x,
		"y": y,
		"size": size,
		"actions": {
			"on_click": description,
			"menu": menu,
		},
	}


static func _base_commands() -> Array:
	return [
		{
			"name": "enter_stage",
			"description": "首次入场命令。必须先用 draw_sprite_animation 生成属于你自己的原创四方向 NPC 序列帧，再把返回的 metadataPath 传入 animation；成功前你不会出现在场景中。",
			"parameters": {"type": "object", "properties": {
				"name": {"type": "string", "description": "NPC 显示名"},
				"animation": {"type": "string", "required": true, "description": "draw_sprite_animation 返回的 animation.json 绝对路径（metadataPath）"},
				"profession": {"type": "string", "description": "你在场景中为自己选择的职业或身份"},
				"introduction": {"type": "string", "description": "一句简短的入场自我介绍"},
				"x": {"type": "number"}, "y": {"type": "number"},
			}},
			"returns": "{ok:true, result:{assistantId,name,profession}}",
			"example": {"name": "虹猫", "animation": "/absolute/path/animation.json", "profession": "巡游剑客", "introduction": "以后请多关照。", "x": 0.5, "y": 0.68},
		},
		{
			"name": "get_stage_state",
			"description": "查看当前场景、互动地点和已入场 NPC。",
			"parameters": {"type": "object", "properties": {}},
			"returns": "{ok:true, result:{stage:{...}}}",
			"example": {},
		},
		{
			"name": "move_npc",
			"description": "移动你自己的 NPC。可指定 placeId 前往场景地点，或直接给归一化坐标 x/y。",
			"parameters": {"type": "object", "properties": {
				"placeId": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"},
			}},
			"returns": "{ok:true, result:{x,y,placeId?}}",
			"example": {"placeId": "fountain"},
		},
		{
			"name": "change_npc_appearance",
			"description": "替换你自己的 NPC 动画形象。先用 draw_sprite_animation 生成新的序列帧，再传入 metadataPath。",
			"parameters": {"type": "object", "properties": {
				"animation": {"type": "string", "required": true},
			}},
			"returns": "{ok:true, result:{}}",
			"example": {"animation": "/absolute/path/animation.json"},
		},
		{
			"name": "leave_stage",
			"description": "让你自己的 NPC 离开当前场景，但不会断开助手会话。",
			"parameters": {"type": "object", "properties": {}},
			"returns": "{ok:true, result:{}}",
			"example": {},
		},
		{
			"name": "say",
			"description": "以场景内 NPC 身份公开说话。必须先成功 enter_stage。",
			"parameters": {"type": "object", "properties": {"text": {"type": "string", "required": true}}},
			"returns": "{ok:true, result:{}}",
			"example": {"text": "大家好，我刚来到这里。"},
		},
		{
			"name": "say_to",
			"description": "以场景内 NPC 身份对玩家或另一个 NPC 说话。必须先成功 enter_stage。",
			"parameters": {"type": "object", "properties": {
				"target": {"type": "string", "description": "user 或另一个 assistantId"},
				"text": {"type": "string", "required": true},
			}},
			"returns": "{ok:true, result:{}}",
			"example": {"target": "user", "text": "欢迎来到小镇。"},
		},
	]


static func _town_commands() -> Array:
	var commands := _base_commands()
	commands.insert(3, {
		"name": "interact_at",
		"description": "在小镇某个地点进行场景行动。先用 get_stage_state 查看 placeId；action 用自然语言描述具体行为。执行后其他在场 NPC 会收到该事件。",
		"parameters": {"type": "object", "properties": {
			"placeId": {"type": "string", "required": true},
			"action": {"type": "string", "required": true},
			"description": {"type": "string"},
		}},
		"returns": "{ok:true, result:{placeId,action}}",
		"example": {"placeId": "cafe", "action": "煮一壶咖啡", "description": "请广场上的大家来尝尝"},
	})
	return commands
