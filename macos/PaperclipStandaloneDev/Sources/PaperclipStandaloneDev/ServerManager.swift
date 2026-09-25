import Foundation

@MainActor
final class ServerManager {
    enum State: Equatable {
        case stopped
        case starting
        case running
        case failed(String)
    }

    static let shared = ServerManager()
    nonisolated static let port = (Bundle.main.object(forInfoDictionaryKey: "PaperclipPort") as? Int) ?? 3318
    nonisolated static let databasePort = (Bundle.main.object(forInfoDictionaryKey: "PaperclipDatabasePort") as? Int) ?? 54332
    nonisolated static let dashboard = URL(string: "http://127.0.0.1:\(port)/")!

    var onStateChange: ((State) -> Void)?
    private(set) var state: State = .stopped {
        didSet { onStateChange?(state) }
    }
    private var process: Process?
    private var stopping = false

    private var dataDirectory: URL {
        let name = (Bundle.main.object(forInfoDictionaryKey: "PaperclipDataDirectoryName") as? String)
            ?? "Paperclip Standalone Dev"
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(name, isDirectory: true)
    }

    private var resources: URL { Bundle.main.resourceURL! }
    private var node: URL { resources.appendingPathComponent("bin/node") }
    private var cli: URL { resources.appendingPathComponent("runtime/node_modules/paperclipai/dist/index.js") }

    func start() {
        guard process == nil, state != .starting else { return }
        state = .starting
        Task.detached { [dataDirectory, node, cli] in
            do {
                try Self.prepare(dataDirectory: dataDirectory, node: node, cli: cli)
                await MainActor.run {
                    guard self.state == .starting else { return }
                    do {
                        let child = try Self.launchServer(dataDirectory: dataDirectory, node: node, cli: cli)
                        self.process = child
                        self.watch(child)
                    } catch {
                        self.state = .failed(error.localizedDescription)
                    }
                }
            } catch {
                await MainActor.run { self.state = .failed(error.localizedDescription) }
            }
        }
    }

    private nonisolated static func prepare(dataDirectory: URL, node: URL, cli: URL) throws {
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: node.path), fm.fileExists(atPath: cli.path) else {
            throw NSError(domain: "PaperclipStandalone", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "The bundled Paperclip runtime is missing."])
        }
        try fm.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        let config = dataDirectory.appendingPathComponent("instances/default/config.json")
        if !fm.fileExists(atPath: config.path) {
            let setup = Process()
            setup.executableURL = node
            setup.arguments = [cli.path, "onboard", "--yes", "--no-install-service", "--data-dir", dataDirectory.path]
            setup.environment = environment(for: node)
            setup.standardOutput = FileHandle.nullDevice
            setup.standardError = FileHandle.nullDevice
            try setup.run()
            let envFile = dataDirectory.appendingPathComponent("instances/default/.env")
            let keyFile = dataDirectory.appendingPathComponent("instances/default/secrets/master.key")
            let deadline = Date().addingTimeInterval(45)
            while Date() < deadline && setup.isRunning {
                if fm.fileExists(atPath: config.path) && fm.fileExists(atPath: envFile.path)
                    && fm.fileExists(atPath: keyFile.path) { break }
                Thread.sleep(forTimeInterval: 0.1)
            }
            let ready = fm.fileExists(atPath: config.path) && fm.fileExists(atPath: envFile.path)
                && fm.fileExists(atPath: keyFile.path)
            if setup.isRunning { setup.terminate() }
            setup.waitUntilExit()
            guard ready else {
                throw NSError(domain: "PaperclipStandalone", code: 2,
                              userInfo: [NSLocalizedDescriptionKey: "Paperclip setup failed before creating its config and secrets."])
            }
        }
        guard let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as? [String: Any] else {
            throw NSError(domain: "PaperclipStandalone", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "Paperclip configuration could not be read."])
        }
        var updated = raw
        var server = updated["server"] as? [String: Any] ?? [:]
        server["port"] = port
        server["host"] = "127.0.0.1"
        updated["server"] = server
        var database = updated["database"] as? [String: Any] ?? [:]
        database["embeddedPostgresPort"] = databasePort
        updated["database"] = database
        if (raw["server"] as? [String: Any])?["port"] as? Int != port
            || (raw["database"] as? [String: Any])?["embeddedPostgresPort"] as? Int != databasePort {
            let data = try JSONSerialization.data(withJSONObject: updated, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: config, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
        }
    }

    private nonisolated static func environment(for node: URL) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser
        let nvmRoot = home.appendingPathComponent(".nvm/versions/node")
        let nvmBins = (try? FileManager.default.contentsOfDirectory(at: nvmRoot, includingPropertiesForKeys: nil))?
            .map { $0.appendingPathComponent("bin").path }
            .sorted() ?? []
        let searchPaths = [
            node.deletingLastPathComponent().path,
            home.appendingPathComponent(".local/bin").path,
            home.appendingPathComponent(".opencode/bin").path
        ] + nvmBins + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        env["PATH"] = (searchPaths + [env["PATH"] ?? ""]).joined(separator: ":")
        env["PORT"] = String(port)
        return env
    }

    private nonisolated static func launchServer(dataDirectory: URL, node: URL, cli: URL) throws -> Process {
        let child = Process()
        child.executableURL = node
        child.arguments = [cli.path, "run", "--data-dir", dataDirectory.path]
        child.environment = environment(for: node)
        let logURL = dataDirectory.appendingPathComponent("standalone.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        let log = try FileHandle(forWritingTo: logURL)
        try log.seekToEnd()
        child.standardOutput = log
        child.standardError = log
        try child.run()
        return child
    }

    private func watch(_ child: Process) {
        child.terminationHandler = { [weak self] finished in
            Task { @MainActor in
                guard let self, self.process === finished else { return }
                self.process = nil
                self.state = self.stopping ? .stopped : .failed("Server exited (\(finished.terminationStatus)). See standalone.log.")
                self.stopping = false
            }
        }
        Task {
            for _ in 0..<120 {
                if state != .starting { return }
                if await Self.healthCheck() {
                    state = .running
                    return
                }
                try? await Task.sleep(for: .seconds(1))
            }
            if state == .starting { state = .failed("Server did not become ready. See standalone.log.") }
        }
    }

    private nonisolated static func healthCheck() async -> Bool {
        var request = URLRequest(url: dashboard)
        request.timeoutInterval = 2
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse).map { (200..<500).contains($0.statusCode) } ?? false
        } catch { return false }
    }

    func stop() {
        guard let child = process else { state = .stopped; return }
        stopping = true
        if child.isRunning { child.terminate() }
    }

    func stopAndWait() {
        guard let child = process else { return }
        stopping = true
        if child.isRunning { child.terminate() }
        let deadline = Date().addingTimeInterval(12)
        while child.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        process = nil
        state = .stopped
    }
}
