// swift-tools-version:6.0
import PackageDescription

// StageChannelSdk —— StageChannel 协议的 Swift 客户端实现。
//
// 协议唯一源：../spec/protocol.md 与 ../spec/fixtures/（只读）。
// 本包没有任何第三方依赖；默认传输层使用 Foundation 的 URLSessionWebSocketTask。
let package = Package(
    name: "StageChannelSdk",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "StageChannelSdk", targets: ["StageChannelSdk"]),
    ],
    targets: [
        .target(name: "StageChannelSdk"),
        .testTarget(
            name: "StageChannelSdkTests",
            dependencies: ["StageChannelSdk"]
        ),
    ]
)
