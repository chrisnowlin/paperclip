// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PaperclipStandaloneDev",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "PaperclipStandaloneDev", targets: ["PaperclipStandaloneDev"])],
    targets: [.executableTarget(name: "PaperclipStandaloneDev")]
)
