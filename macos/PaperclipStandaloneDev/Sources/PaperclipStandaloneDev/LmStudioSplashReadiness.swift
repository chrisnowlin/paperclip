import Foundation

enum LmStudioSplashReadiness {
    static let model = "qwen3.8-27b-splash"

    enum Status: Equatable {
        case loaded, unloaded, missing, wrongFormat, unavailable
    }

    static func status(_ data: Data) -> Status {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = object["models"] as? [[String: Any]] else { return .unavailable }
        guard let selected = models.first(where: { $0["key"] as? String == model }) else { return .missing }
        guard selected["format"] as? String == "splash" else { return .wrongFormat }
        return ((selected["loaded_instances"] as? [Any])?.isEmpty == false) ? .loaded : .unloaded
    }

    static func check() async -> Status {
        guard let url = URL(string: "http://127.0.0.1:1234/api/v1/models") else { return .unavailable }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return .unavailable }
            return status(data)
        } catch { return .unavailable }
    }
}
