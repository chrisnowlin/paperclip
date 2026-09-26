// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PaperclipStandaloneV2",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "PaperclipStandaloneV2", targets: ["PaperclipStandaloneV2"])],
    targets: [.executableTarget(name: "PaperclipStandaloneV2", path: "Sources/PaperclipStandaloneDev")]
)
