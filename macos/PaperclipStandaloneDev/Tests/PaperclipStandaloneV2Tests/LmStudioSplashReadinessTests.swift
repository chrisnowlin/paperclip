import Foundation
import XCTest
@testable import PaperclipStandaloneV2

final class LmStudioSplashReadinessTests: XCTestCase {
    func testOnlyAnExactLoadedSplashModelIsReady() throws {
        let ready = Data("""
        {"instance":{"model":"incoai/Qwen3.8-27B-Splash","host":"127.0.0.1","port":3321}}
        """.utf8)
        XCTAssertEqual(LmStudioSplashReadiness.status(ready), .loaded)
        let wrongModel = Data("""
        {"instance":{"model":"other/model","host":"127.0.0.1","port":3321}}
        """.utf8)
        XCTAssertEqual(LmStudioSplashReadiness.status(wrongModel), .wrongModel)
        XCTAssertEqual(LmStudioSplashReadiness.status(Data("invalid".utf8)), .unavailable)
    }
}
