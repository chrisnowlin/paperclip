import AppKit
import Foundation

@MainActor
final class LocalAgentSetupController: NSObject {
    enum Provider: Int, CaseIterable {
        case claude, codex, opencode, lmStudioSplash

        var title: String {
            switch self {
            case .claude: "Claude Code"
            case .codex: "Codex"
            case .opencode: "OpenCode"
            case .lmStudioSplash: "LM Studio Splash"
            }
        }

        var adapterType: String {
            switch self {
            case .claude: "claude_local"
            case .codex: "codex_local"
            case .opencode: "opencode_local"
            case .lmStudioSplash: "lmstudio_splash_local"
            }
        }

        var commandName: String {
            switch self {
            case .claude: "claude"
            case .codex: "codex"
            case .opencode: "opencode"
            case .lmStudioSplash: "LM Studio"
            }
        }

        var suggestedModel: String {
            switch self {
            case .claude, .codex: ""
            case .opencode: ""
            case .lmStudioSplash: LmStudioSplashReadiness.model
            }
        }
    }

    var onAgentCreated: (() -> Void)?
    var onOpenAgents: ((String) -> Void)?

    private var window: NSWindow!
    private var organizationPopup: NSPopUpButton!
    private var organizationName: NSTextField!
    private var organizationNameLabel: NSTextField!
    private var agentName: NSTextField!
    private var model: NSComboBox!
    private var modelHint: NSTextField!
    private var openCodeProviderHint: NSTextField!
    private var openCodeProviderPopup: NSPopUpButton!
    private var status: NSTextField!
    private var testButton: NSButton!
    private var createButton: NSButton!
    private var providerButtons: [NSButton] = []
    private var companies: [Company] = []
    private var selectedProvider: Provider = .claude
    private var preferredCompanyId: String?
    private var preferredNewOrganizationName: String?
    private var openCodeModelsByProvider: [String: [String]] = [:]
    private var modelDiscoveryToken = UUID()
    private var busy = false

    private struct Company: Decodable {
        let id: String
        let name: String
        let issuePrefix: String?
    }

    private struct AgentSummary: Decodable {
        let id: String
    }

    private struct AdapterCheck: Decodable {
        let code: String
        let level: String
        let message: String
        let hint: String?
    }

    private struct AdapterTestResult: Decodable {
        let checks: [AdapterCheck]
    }

    func show(provider: Provider? = nil, companyId: String? = nil,
              companyName: String? = nil, agentName suggestedAgentName: String? = nil) {
        if let provider { selectedProvider = provider }
        preferredCompanyId = companyId
        preferredNewOrganizationName = companyName
        if window == nil { makeWindow() }
        if let suggestedAgentName, !suggestedAgentName.isEmpty { agentName.stringValue = suggestedAgentName }
        if let companyName, !companyName.isEmpty { organizationName.stringValue = companyName }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task { await loadCompanies() }
        updateProvider()
    }

    private func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 650, height: 710),
                          styleMask: [.titled, .closable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "Local Agent Setup"
        window.center()
        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 16
        root.edgeInsets = NSEdgeInsets(top: 24, left: 28, bottom: 24, right: 28)
        root.translatesAutoresizingMaskIntoConstraints = false
        window.contentView = root

        let heading = NSTextField(labelWithString: "Set up a local agent")
        heading.font = .boldSystemFont(ofSize: 25)
        root.addArrangedSubview(heading)
        let intro = label("Choose an agent runtime, test it in Paperclip, then add an agent. LM Studio Splash uses the local loaded model without a provider sign-in.")
        intro.textColor = .secondaryLabelColor
        root.addArrangedSubview(intro)

        root.addArrangedSubview(section("Organization"))
        organizationPopup = NSPopUpButton(frame: .zero, pullsDown: false)
        organizationPopup.target = self
        organizationPopup.action = #selector(organizationChanged(_:))
        root.addArrangedSubview(organizationPopup)
        organizationNameLabel = label("New organization name")
        root.addArrangedSubview(organizationNameLabel)
        organizationName = NSTextField(string: "")
        organizationName.placeholderString = "e.g. My Agent Team"
        root.addArrangedSubview(organizationName)

        root.addArrangedSubview(section("Agent provider"))
        for provider in Provider.allCases {
            let button = NSButton(radioButtonWithTitle: provider.title,
                                  target: self, action: #selector(providerChanged(_:)))
            button.tag = provider.rawValue
            button.state = provider == .claude ? .on : .off
            providerButtons.append(button)
            root.addArrangedSubview(button)
        }

        root.addArrangedSubview(section("Agent details"))
        let nameLabel = label("Agent name")
        root.addArrangedSubview(nameLabel)
        agentName = NSTextField(string: "")
        agentName.placeholderString = "e.g. Researcher"
        root.addArrangedSubview(agentName)
        openCodeProviderHint = label("Connected OpenCode provider")
        openCodeProviderHint.textColor = .secondaryLabelColor
        root.addArrangedSubview(openCodeProviderHint)
        openCodeProviderPopup = NSPopUpButton(frame: .zero, pullsDown: false)
        openCodeProviderPopup.target = self
        openCodeProviderPopup.action = #selector(openCodeProviderChanged(_:))
        root.addArrangedSubview(openCodeProviderPopup)
        modelHint = label("Model (blank uses your CLI default)")
        modelHint.textColor = .secondaryLabelColor
        root.addArrangedSubview(modelHint)
        model = NSComboBox(frame: .zero)
        model.isEditable = true
        model.completes = true
        root.addArrangedSubview(model)

        status = label("Choose a provider, then test its connection.")
        status.textColor = .secondaryLabelColor
        root.addArrangedSubview(status)

        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 12
        testButton = NSButton(title: "Test Connection", target: self, action: #selector(testConnection(_:)))
        createButton = NSButton(title: "Create Agent", target: self, action: #selector(createAgent(_:)))
        createButton.keyEquivalent = "\r"
        actions.addArrangedSubview(testButton)
        actions.addArrangedSubview(createButton)
        actions.addArrangedSubview(NSButton(title: "Open Agents", target: self, action: #selector(openAgents(_:))))
        actions.addArrangedSubview(NSButton(title: "Close", target: self, action: #selector(closeWindow(_:))))
        root.addArrangedSubview(actions)

        let fullWidthViews: [NSView] = [intro, organizationPopup, organizationName,
                                        agentName, openCodeProviderPopup, model, status]
        for field in fullWidthViews {
            field.translatesAutoresizingMaskIntoConstraints = false
            field.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -56).isActive = true
        }
        updateOrganizationVisibility()
    }

    private func label(_ value: String) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: value)
        field.font = .systemFont(ofSize: 13)
        field.maximumNumberOfLines = 3
        return field
    }

    private func section(_ value: String) -> NSTextField {
        let field = label(value)
        field.font = .boldSystemFont(ofSize: 14)
        return field
    }

    private func updateOrganizationVisibility() {
        let needsName = companies.isEmpty || organizationPopup.indexOfSelectedItem >= companies.count
        organizationPopup.isHidden = companies.isEmpty
        organizationNameLabel.isHidden = !needsName
        organizationName.isHidden = !needsName
    }

    private func updateProvider() {
        for (index, button) in providerButtons.enumerated() {
            button.state = index == selectedProvider.rawValue ? .on : .off
        }
        let isOpenCode = selectedProvider == .opencode
        let isLmStudioSplash = selectedProvider == .lmStudioSplash
        openCodeProviderHint.isHidden = !isOpenCode
        openCodeProviderPopup.isHidden = !isOpenCode
        model.removeAllItems()
        model.stringValue = selectedProvider.suggestedModel
        model.isEditable = !isLmStudioSplash
        modelHint.stringValue = isLmStudioSplash ? "Fixed model — load Qwen3.8 27B Splash in LM Studio before testing"
            : selectedProvider == .opencode ? "Model (choose one or enter a provider/model ID)"
            : "Model (blank uses your CLI default)"
        let command = executable(for: selectedProvider)
        status.stringValue = command == nil
            ? "\(selectedProvider.commandName) was not found on this Mac."
            : isOpenCode ? "Loading your connected OpenCode providers…"
                : isLmStudioSplash ? "Checking whether LM Studio has the Splash model loaded…"
                : "\(selectedProvider.commandName) found. Test the connection in Paperclip."
        status.textColor = command == nil ? .systemRed : .secondaryLabelColor
        testButton.isEnabled = command != nil && !busy && !isOpenCode
        createButton.isEnabled = command != nil && !busy && !isOpenCode
        if isOpenCode, let command { discoverOpenCodeProviders(command: command) }
        if isLmStudioSplash {
            Task {
                let readiness = await LmStudioSplashReadiness.check()
                guard selectedProvider == .lmStudioSplash else { return }
                switch readiness {
                case .loaded:
                    status.stringValue = "LM Studio Splash is loaded. Test its Paperclip route."
                    status.textColor = .secondaryLabelColor
                case .unloaded:
                    status.stringValue = "Splash is available but not loaded in LM Studio. Load it before running the agent."
                    status.textColor = .systemOrange
                case .missing:
                    status.stringValue = "The exact Qwen3.8 27B Splash model is missing from LM Studio."
                    status.textColor = .systemOrange
                case .wrongFormat:
                    status.stringValue = "The matching LM Studio model is not in Splash format."
                    status.textColor = .systemRed
                case .unavailable:
                    status.stringValue = "LM Studio is unavailable at 127.0.0.1:1234. Start its local server, then test again."
                    status.textColor = .systemRed
                }
            }
        }
    }

    private func discoverOpenCodeProviders(command: String) {
        let token = UUID()
        modelDiscoveryToken = token
        Task {
            do {
                let found = try await Task.detached {
                    try Self.readOpenCodeModels(command: command)
                }.value
                guard selectedProvider == .opencode, modelDiscoveryToken == token else { return }
                openCodeModelsByProvider = found
                openCodeProviderPopup.removeAllItems()
                for providerId in found.keys.sorted(by: { Self.providerLabel($0) < Self.providerLabel($1) }) {
                    openCodeProviderPopup.addItem(withTitle: Self.providerLabel(providerId))
                    openCodeProviderPopup.lastItem?.representedObject = providerId
                }
                if let preferred = openCodeProviderPopup.itemArray.first(where: {
                    $0.representedObject as? String == "zai-coding-plan"
                }) {
                    openCodeProviderPopup.select(preferred)
                }
                refreshModelChoices()
                status.stringValue = found.isEmpty
                    ? "No stored OpenCode providers with models were found."
                    : "\(found.count) connected OpenCode providers found. Choose a provider and model."
                status.textColor = found.isEmpty ? .systemOrange : .secondaryLabelColor
                testButton.isEnabled = !found.isEmpty && !busy
                createButton.isEnabled = !found.isEmpty && !busy
            } catch {
                guard selectedProvider == .opencode, modelDiscoveryToken == token else { return }
                status.stringValue = "Could not load OpenCode providers: \(error.localizedDescription)"
                status.textColor = .systemRed
            }
        }
    }

    private nonisolated static func readOpenCodeModels(command: String) throws -> [String: [String]] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let authFile = home.appendingPathComponent(".local/share/opencode/auth.json")
        let authData = try Data(contentsOf: authFile)
        guard let auth = try JSONSerialization.jsonObject(with: authData) as? [String: Any] else {
            throw NSError(domain: "LocalAgentSetup", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "OpenCode sign-ins could not be read."])
        }
        let connectedIds = Set(auth.keys)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command)
        process.arguments = ["models"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "LocalAgentSetup", code: 4,
                          userInfo: [NSLocalizedDescriptionKey: "OpenCode could not list models."])
        }
        var result: [String: [String]] = [:]
        for rawLine in String(decoding: data, as: UTF8.self).split(separator: "\n") {
            let id = String(rawLine).trimmingCharacters(in: .whitespacesAndNewlines)
            guard let provider = id.split(separator: "/", maxSplits: 1).first.map(String.init),
                  connectedIds.contains(provider), id.contains("/") else { continue }
            result[provider, default: []].append(id)
        }
        return result.mapValues { $0.sorted() }
    }

    private nonisolated static func providerLabel(_ id: String) -> String {
        switch id {
        case "zai-coding-plan": "Z.ai Coding Plan"
        case "opencode": "OpenCode Zen"
        case "openai": "OpenAI"
        case "openrouter": "OpenRouter"
        default: id.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    @objc private func openCodeProviderChanged(_ sender: NSPopUpButton) {
        refreshModelChoices()
        status.stringValue = "Choose a model, then test the connection in Paperclip."
        status.textColor = .secondaryLabelColor
    }

    private func refreshModelChoices() {
        let providerId = openCodeProviderPopup.selectedItem?.representedObject as? String
        let choices = providerId.flatMap { openCodeModelsByProvider[$0] } ?? []
        model.removeAllItems()
        model.addItems(withObjectValues: choices)
        let preferred = providerId == "zai-coding-plan"
            ? choices.first(where: { $0 == "zai-coding-plan/glm-5.3-flash" })
            : nil
        model.stringValue = preferred ?? choices.first ?? ""
    }

    private func executable(for provider: Provider) -> String? {
        if provider == .lmStudioSplash { return "LM Studio" }
        let home = FileManager.default.homeDirectoryForCurrentUser
        var dirs = [home.appendingPathComponent(".local/bin"),
                    home.appendingPathComponent(".opencode/bin"),
                    URL(fileURLWithPath: "/opt/homebrew/bin"),
                    URL(fileURLWithPath: "/usr/local/bin")]
        let nvm = home.appendingPathComponent(".nvm/versions/node")
        if let versions = try? FileManager.default.contentsOfDirectory(at: nvm, includingPropertiesForKeys: nil) {
            dirs.insert(contentsOf: versions.sorted { $0.lastPathComponent > $1.lastPathComponent }
                .map { $0.appendingPathComponent("bin") }, at: 2)
        }
        return dirs.map { $0.appendingPathComponent(provider.commandName).path }
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    @objc private func providerChanged(_ sender: NSButton) {
        guard let provider = Provider(rawValue: sender.tag) else { return }
        selectedProvider = provider
        updateProvider()
    }

    @objc private func organizationChanged(_ sender: NSPopUpButton) {
        updateOrganizationVisibility()
        status.stringValue = "Ready to test this organization."
        status.textColor = .secondaryLabelColor
    }

    @objc private func openAgents(_ sender: Any?) {
        guard !companies.isEmpty, organizationPopup.indexOfSelectedItem < companies.count else {
            status.stringValue = "Create an organization and agent first."
            status.textColor = .systemOrange
            return
        }
        let company = companies[max(0, organizationPopup.indexOfSelectedItem)]
        guard let prefix = company.issuePrefix else { return }
        onOpenAgents?(prefix)
        window.orderOut(nil)
    }

    @objc private func closeWindow(_ sender: Any?) { window.orderOut(nil) }

    private func setBusy(_ value: Bool, message: String) {
        busy = value
        let available = executable(for: selectedProvider) != nil &&
            (selectedProvider != .opencode || !openCodeModelsByProvider.isEmpty)
        testButton.isEnabled = !value && available
        createButton.isEnabled = !value && available
        status.stringValue = message
        if value { status.textColor = .secondaryLabelColor }
    }

    @objc private func testConnection(_ sender: Any?) {
        let provider = selectedProvider
        guard let command = executable(for: provider) else { return }
        setBusy(true, message: "Testing \(provider.title)…")
        Task {
            defer { setBusy(false, message: status.stringValue) }
            do {
                let config = try adapterConfig(provider: provider, command: command)
                let companyId = try await ensureCompany()
                let result: AdapterTestResult = try await api(
                    path: "/companies/\(companyId)/adapters/\(provider.adapterType)/test-environment",
                    method: "POST", body: ["adapterConfig": config])
                if let error = result.checks.first(where: { $0.level == "error" }) {
                    status.stringValue = "\(provider.title): \(error.message)"
                    status.textColor = .systemRed
                } else if let warning = result.checks.first(where: { $0.level == "warn" }) {
                    status.stringValue = "\(provider.title): \(warning.message)"
                    status.textColor = .systemOrange
                } else {
                    status.stringValue = "\(provider.title): connection test passed."
                    status.textColor = .systemGreen
                }
            } catch {
                status.stringValue = "Connection test failed: \(error.localizedDescription)"
                status.textColor = .systemRed
            }
        }
    }

    @objc private func createAgent(_ sender: Any?) {
        let provider = selectedProvider
        guard let command = executable(for: provider) else { return }
        let name = agentName.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            status.stringValue = "Enter an agent name first."
            status.textColor = .systemOrange
            return
        }
        setBusy(true, message: "Creating \(name)…")
        Task {
            defer { setBusy(false, message: status.stringValue) }
            do {
                let config = try adapterConfig(provider: provider, command: command)
                let companyId = try await ensureCompany()
                let existing: [AgentSummary] = try await api(path: "/companies/\(companyId)/agents")
                let body: [String: Any] = ["name": name,
                                           "role": existing.isEmpty ? "ceo" : "general",
                                           "adapterType": provider.adapterType,
                                           "adapterConfig": config]
                let _: AgentSummary = try await api(path: "/companies/\(companyId)/agents",
                                                    method: "POST", body: body)
                status.stringValue = "\(name) was created. Open Paperclip’s Agents page to configure tasks."
                status.textColor = .systemGreen
                onAgentCreated?()
            } catch {
                status.stringValue = "Could not create agent: \(error.localizedDescription)"
                status.textColor = .systemRed
            }
        }
    }

    private func adapterConfig(provider: Provider, command: String) throws -> [String: Any] {
        let name = agentName.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let safeName = (name.isEmpty ? provider.commandName : name)
            .lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }
        let dataDirectoryName = (Bundle.main.object(forInfoDictionaryKey: "PaperclipDataDirectoryName") as? String)
            ?? "Paperclip Standalone V2"
        let workspace = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("\(dataDirectoryName)/agent-workspaces/\(String(safeName))")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        var config: [String: Any] = ["cwd": workspace.path]
        if provider == .lmStudioSplash {
            config["model"] = LmStudioSplashReadiness.model
            return config
        }
        config["timeoutSec"] = 180
        config["command"] = command
        if provider != .opencode { config["engine"] = "cli" }
        let chosenModel = model.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if provider == .opencode {
            guard let providerId = openCodeProviderPopup.selectedItem?.representedObject as? String else {
                throw NSError(domain: "LocalAgentSetup", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "Choose a connected OpenCode provider."])
            }
            guard chosenModel.hasPrefix(providerId + "/"), chosenModel.count > providerId.count + 1 else {
                throw NSError(domain: "LocalAgentSetup", code: 2,
                              userInfo: [NSLocalizedDescriptionKey: "Choose a model for \(Self.providerLabel(providerId)) in provider/model format."])
            }
        }
        if !chosenModel.isEmpty { config["model"] = chosenModel }
        return config
    }

    private func loadCompanies() async {
        do {
            companies = try await api(path: "/companies")
            organizationPopup.removeAllItems()
            for company in companies { organizationPopup.addItem(withTitle: company.name) }
            organizationPopup.addItem(withTitle: "Create new organization…")
            if let preferredNewOrganizationName, !preferredNewOrganizationName.isEmpty {
                if let preferredCompanyId,
                   let index = companies.firstIndex(where: {
                       $0.id == preferredCompanyId && $0.name == preferredNewOrganizationName
                   }) {
                    organizationPopup.selectItem(at: index)
                } else {
                    organizationPopup.selectItem(at: companies.count)
                    organizationName.stringValue = preferredNewOrganizationName
                }
            } else if let preferredCompanyId,
                      let index = companies.firstIndex(where: { $0.id == preferredCompanyId }) {
                organizationPopup.selectItem(at: index)
            }
            updateOrganizationVisibility()
        } catch {
            status.stringValue = "Could not load organizations: \(error.localizedDescription)"
            status.textColor = .systemRed
        }
    }

    private func ensureCompany() async throws -> String {
        let selectedIndex = organizationPopup.indexOfSelectedItem
        if !companies.isEmpty && selectedIndex >= 0 && selectedIndex < companies.count {
            return companies[selectedIndex].id
        }
        let name = organizationName.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            throw NSError(domain: "LocalAgentSetup", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Enter an organization name first."])
        }
        let created: Company = try await api(path: "/companies", method: "POST", body: ["name": name])
        companies.append(created)
        organizationPopup.removeAllItems()
        for company in companies { organizationPopup.addItem(withTitle: company.name) }
        organizationPopup.addItem(withTitle: "Create new organization…")
        organizationPopup.selectItem(at: companies.count - 1)
        updateOrganizationVisibility()
        return created.id
    }

    private func api<T: Decodable>(path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(ServerManager.port)/api\(path)")!)
        request.httpMethod = method
        request.timeoutInterval = 90
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let errorMessage = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw NSError(domain: "Paperclip API", code: (response as? HTTPURLResponse)?.statusCode ?? 0,
                          userInfo: [NSLocalizedDescriptionKey: errorMessage ?? "Paperclip did not accept the request."])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
