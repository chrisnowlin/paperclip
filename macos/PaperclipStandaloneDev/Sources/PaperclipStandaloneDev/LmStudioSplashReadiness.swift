import Foundation

enum LmStudioSplashReadiness {
    static let model = "qwen3.8-27b-splash"
    static let package = "incoai/Qwen3.8-27B-Splash"

    enum Status: Equatable {
        case loaded, wrongModel, unavailable
    }

    static func status(_ data: Data) -> Status {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let instance = object["instance"] as? [String: Any] else { return .unavailable }
        guard instance["model"] as? String == package,
              instance["host"] as? String == "127.0.0.1",
              instance["port"] as? Int == 3321 else { return .wrongModel }
        return .loaded
    }

    static func check() async -> Status {
        guard let url = URL(string: "http://127.0.0.1:3321/status") else { return .unavailable }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return .unavailable }
            return status(data)
        } catch { return .unavailable }
    }
}
