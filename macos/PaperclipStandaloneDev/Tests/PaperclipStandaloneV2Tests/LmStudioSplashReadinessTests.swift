import Foundation
import XCTest
@testable import PaperclipStandaloneV2

final class LmStudioSplashReadinessTests: XCTestCase {
    func testOnlyAnExactLoadedSplashModelIsReady() throws {
        let ready = Data("""
        {"models":[{"key":"qwen3.8-27b-splash","format":"splash","loaded_instances":[{"id":"loaded"}]}]}
        """.utf8)
        XCTAssertEqual(LmStudioSplashReadiness.status(ready), .loaded)
        let unloaded = Data("""
        {"models":[{"key":"qwen3.8-27b-splash","format":"splash","loaded_instances":[]}]}
        """.utf8)
        XCTAssertEqual(LmStudioSplashReadiness.status(unloaded), .unloaded)
        let wrongFormat = Data("""
        {"models":[{"key":"qwen3.8-27b-splash","format":"gguf","loaded_instances":[{"id":"loaded"}]}]}
        """.utf8)
        XCTAssertEqual(LmStudioSplashReadiness.status(wrongFormat), .wrongFormat)
        XCTAssertEqual(LmStudioSplashReadiness.status(Data(#"{"models":[]}"#.utf8)), .missing)
        XCTAssertEqual(LmStudioSplashReadiness.status(Data("invalid".utf8)), .unavailable)
    }
}
