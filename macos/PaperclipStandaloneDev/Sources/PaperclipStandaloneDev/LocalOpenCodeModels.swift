enum LocalOpenCodeModels {
    static let splashModel = "splash/incoai/Qwen3.8-27B-Splash"

    static func merging(_ signedIn: [String: [String]]?) -> [String: [String]] {
        var models = signedIn ?? [:]
        models["splash"] = [splashModel]
        return models
    }
}
