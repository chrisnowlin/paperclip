import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler {
    private let server = ServerManager.shared
    private let setupController = LocalAgentSetupController()
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var statusMenu: NSMenu!
    private var statusLine: NSMenuItem!
    private var startItem: NSMenuItem!
    private var stopItem: NSMenuItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        makeMainMenu()
        makeWindow()
        makeStatusMenu()
        setupController.onAgentCreated = { [weak self] in
            self?.webView.evaluateJavaScript("try { localStorage.removeItem('paperclip-onboarding-state'); } catch (e) {}") { _, _ in
                self?.webView.load(URLRequest(url: ServerManager.dashboard))
            }
        }
        setupController.onOpenAgents = { [weak self] prefix in
            guard let self, let url = URL(string: "http://127.0.0.1:\(ServerManager.port)/\(prefix)/agents/all") else { return }
            self.webView.load(URLRequest(url: url))
            self.window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        server.onStateChange = { [weak self] state in self?.update(for: state) }
        update(for: server.state)
        server.start()
        showDashboard(nil)
    }

    private func makeMainMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "Paperclip Standalone")
        let openItem = NSMenuItem(title: "Open Dashboard", action: #selector(showDashboard(_:)), keyEquivalent: "o")
        openItem.target = self
        appMenu.addItem(openItem)
        let setupItem = NSMenuItem(title: "Local Agent Setup…", action: #selector(showLocalAgentSetup(_:)), keyEquivalent: "n")
        setupItem.target = self
        appMenu.addItem(setupItem)
        appMenu.addItem(.separator())
        let quitItem = NSMenuItem(title: "Quit Paperclip Completely", action: #selector(quitCompletely(_:)), keyEquivalent: "q")
        quitItem.target = self
        appMenu.addItem(quitItem)
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)
        NSApp.mainMenu = mainMenu
    }

    private func makeWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "localAgentSetup")
        configuration.userContentController.addUserScript(WKUserScript(
            source: Self.openCodeOnboardingScript,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        webView = view
        let frame = NSRect(x: 0, y: 0, width: 1180, height: 760)
        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Paperclip Standalone"
        window.center()
        window.minSize = NSSize(width: 760, height: 520)
        window.contentView = view
        window.delegate = self
        showWaitingPage("Starting Paperclip…")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "localAgentSetup",
              let body = message.body as? [String: Any],
              body["provider"] as? String == "opencode" else { return }
        setupController.show(provider: .opencode,
                             companyId: body["companyId"] as? String,
                             companyName: body["companyName"] as? String,
                             agentName: body["agentName"] as? String)
    }

    private static let openCodeOnboardingScript = #"""
    (() => {
      const marker = 'data-paperclip-native-opencode';
      function render() {
        const wizard = document.querySelector('[data-testid="onboarding-wizard"]');
        const group = wizard?.querySelector('[role="radiogroup"][aria-label="Model source"]');
        if (!group) return;
        const radios = [...group.querySelectorAll('button[role="radio"]')];
        const existing = group.querySelector('[' + marker + ']');
        if (radios.length < 2) {
          existing?.parentElement?.remove();
          return;
        }
        if (existing) return;
        const first = radios[0];
        const wrapper = first.parentElement.cloneNode(false);
        const button = first.cloneNode(false);
        button.setAttribute(marker, 'true');
        button.setAttribute('role', 'button');
        button.removeAttribute('aria-checked');
        button.setAttribute('aria-label', 'OpenCode — choose a connected provider and model');
        button.type = 'button';
        for (const [index, value] of ['OC', 'OpenCode', 'Your providers'].entries()) {
          const part = first.children[index]?.cloneNode(false) || document.createElement('span');
          part.textContent = value;
          if (index === 0) part.style.fontWeight = '700';
          button.appendChild(part);
        }
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          let companyId = null;
          let companyName = null;
          let agentName = null;
          try {
            const draft = JSON.parse(localStorage.getItem('paperclip-onboarding-state') || '{}');
            companyId = typeof draft.createdCompanyId === 'string' ? draft.createdCompanyId : null;
            companyName = typeof draft.companyName === 'string' ? draft.companyName : null;
            agentName = typeof draft.agentName === 'string' ? draft.agentName : null;
          } catch (_) {}
          window.webkit.messageHandlers.localAgentSetup.postMessage({provider: 'opencode', companyId, companyName, agentName});
        });
        wrapper.appendChild(button);
        group.appendChild(wrapper);
      }
      let queued = false;
      const observer = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; render(); });
      });
      observer.observe(document.documentElement, {childList: true, subtree: true});
      render();
    })();
    """#

    private func makeStatusMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "paperclip", accessibilityDescription: "Paperclip Standalone")
        statusItem.button?.toolTip = "Paperclip Standalone"
        let menu = NSMenu()
        statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Open Dashboard", action: #selector(showDashboard(_:)), keyEquivalent: "o"))
        menu.addItem(NSMenuItem(title: "Local Agent Setup…", action: #selector(showLocalAgentSetup(_:)), keyEquivalent: ""))
        startItem = NSMenuItem(title: "Start Server", action: #selector(startServer(_:)), keyEquivalent: "")
        stopItem = NSMenuItem(title: "Stop Server", action: #selector(stopServer(_:)), keyEquivalent: "")
        menu.addItem(startItem)
        menu.addItem(stopItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Paperclip Completely", action: #selector(quitCompletely(_:)), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        statusMenu = menu
        statusItem.menu = menu
    }

    private func update(for state: ServerManager.State) {
        switch state {
        case .stopped:
            statusLine.title = "Server stopped"
            startItem.isEnabled = true
            stopItem.isEnabled = false
            showWaitingPage("Paperclip is stopped. Use the menu bar icon to start it.")
        case .starting:
            statusLine.title = "Starting server…"
            startItem.isEnabled = false
            stopItem.isEnabled = true
            showWaitingPage("Starting Paperclip…")
        case .running:
            statusLine.title = "Running in background · localhost:\(ServerManager.port)"
            startItem.isEnabled = false
            stopItem.isEnabled = true
            webView.load(URLRequest(url: ServerManager.dashboard))
            if !UserDefaults.standard.bool(forKey: "didShowLocalAgentSetup") {
                UserDefaults.standard.set(true, forKey: "didShowLocalAgentSetup")
                setupController.show()
            }
        case .failed(let message):
            statusLine.title = "Server error"
            startItem.isEnabled = true
            stopItem.isEnabled = true
            showWaitingPage("Paperclip could not start. \(message)")
        }
    }

    private func showWaitingPage(_ message: String) {
        let safe = message.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        webView.loadHTMLString("""
        <html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        body{font:16px -apple-system,BlinkMacSystemFont,sans-serif;background:#f7f7f5;color:#222;display:grid;place-items:center;height:100vh;margin:0}
        main{text-align:center;max-width:520px;padding:24px}h1{font-size:23px;font-weight:600}p{line-height:1.5;color:#666}
        </style></head><body><main><h1>Paperclip Standalone</h1><p>\(safe)</p></main></body></html>
        """, baseURL: nil)
    }

    @objc private func showDashboard(_ sender: Any?) {
        if server.state == .stopped { server.start() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func startServer(_ sender: Any?) { server.start() }
    @objc private func stopServer(_ sender: Any?) { server.stop() }
    @objc private func showLocalAgentSetup(_ sender: Any?) { setupController.show() }
    @objc private func quitCompletely(_ sender: Any?) { NSApp.terminate(nil) }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        server.stopAndWait()
        return .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showDashboard(nil) }
        return true
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
