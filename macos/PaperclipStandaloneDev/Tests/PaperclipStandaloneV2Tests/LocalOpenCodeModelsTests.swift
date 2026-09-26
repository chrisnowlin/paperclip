import XCTest
@testable import PaperclipStandaloneV2

final class LocalOpenCodeModelsTests: XCTestCase {
    func testSplashRemainsAvailableWhenPaidProviderDiscoveryFails() {
        let models = LocalOpenCodeModels.merging(nil)
        XCTAssertEqual(models["splash"], ["splash/incoai/Qwen3.8-27B-Splash"])
    }

    func testSplashIsAddedAlongsideSignedInProviders() {
        let models = LocalOpenCodeModels.merging(["openrouter": ["openrouter/example"]])
        XCTAssertEqual(models["splash"], ["splash/incoai/Qwen3.8-27B-Splash"])
        XCTAssertEqual(models["openrouter"], ["openrouter/example"])
    }
}
