#if canImport(UIKit)
  import DailyDoListDomain
  import DailyDoListModels
  import SwiftUI

  enum SharedSettingsPage: CaseIterable {
    case appearance, notes, agent, machine
    var title: String {
      switch self {
      case .appearance: "Appearance and editor"
      case .notes: "Daily and weekly notes"
      case .agent: "Agent behavior and approvals"
      case .machine: "Shared always-on machine"
      }
    }
  }

  struct SharedSettingsForm: View {
    let store: MobileSettingsStore
    let page: SharedSettingsPage
    @State private var baseline: AppSettings
    @State private var draft: AppSettings
    @State private var confirmation: PolicyConsent?
    @State private var localError: String?

    init(store: MobileSettingsStore, initial: AppSettings, page: SharedSettingsPage) {
      self.store = store
      self.page = page
      _baseline = State(initialValue: initial)
      _draft = State(initialValue: initial)
    }

    var body: some View {
      Form {
        Section {
          Text("Shared vault settings on \(store.hostName). Changes apply after Save.").font(
            .footnote
          ).foregroundStyle(.secondary)
        }
        Group {
          switch page {
          case .appearance: appearance
          case .notes: notes
          case .agent: agent
          case .machine: machine
          }
        }.disabled(!store.actionsEnabled || !store.isCurrentSession() || !store.busy.isEmpty)
        Section {
          ForEach(SettingsDraft.problems(draft), id: \.self) { Text($0).foregroundStyle(.red) }
          if let localError { Text(localError).foregroundStyle(.red) }
          SettingsErrors(store: store, keys: ["save"])
          Button("Save changes") { prepareSave() }.disabled(!canSave)
          if !store.actionsEnabled {
            Text("Reconnect to change shared settings. Changes are never queued for later.").font(
              .footnote)
          }
        }
      }
      .navigationTitle(page.title)
      .alert(
        "Allow more agent actions on \(store.hostName)?",
        isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } })
      ) {
        if let consent = confirmation {
          Button("Apply policy", role: .destructive) {
            confirmation = nil
            save(consent: consent)
          }
        }
        Button("Cancel", role: .cancel) { confirmation = nil }
      } message: {
        if let confirmation {
          Text(
            "\(MobileApprovalPolicy.title(confirmation.from)) → \(MobileApprovalPolicy.title(confirmation.to)). \(MobileApprovalPolicy.detail(confirmation.to)) This applies to the vault's agents, including work already running. Hard-denied actions remain blocked."
          )
        }
      }
      .onChange(of: store.settings) { _, value in
        if let value, draft == baseline {
          baseline = value
          draft = value
        }
      }
      .onChange(of: store.actionsEnabled) { _, enabled in if !enabled { confirmation = nil } }
    }

    private var canSave: Bool {
      store.canMutate && draft != baseline && SettingsDraft.problems(draft).isEmpty
    }
    private func prepareSave() {
      guard canSave else { return }
      if let policy = try? SettingsDraft.patch(from: baseline, to: draft).agent?.approvalPolicy,
        let current = store.settings?.agent.approvalPolicy,
        MobileApprovalPolicy.widens(from: current, to: policy)
      {
        confirmation = PolicyConsent(from: current, to: policy)
      } else {
        save(consent: nil)
      }
    }
    private func save(consent: PolicyConsent?) {
      guard canSave else { return }
      do {
        let patch = try SettingsDraft.patch(from: baseline, to: draft)
        Task {
          if await store.save(patch, consent: consent), let saved = store.settings {
            baseline = saved
            draft = saved
            localError = nil
          }
        }
      } catch { localError = error.localizedDescription }
    }

    private var appearance: some View {
      Group {
        Section("Appearance") {
          Picker("Theme", selection: $draft.theme) {
            ForEach(ThemePreference.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
          }
          Stepper(
            "Font size: \(Int(draft.editor.fontSize))", value: $draft.editor.fontSize,
            in: SettingsRanges.fontSize)
          Toggle("Readable line length", isOn: $draft.editor.readableLineLength)
          Toggle("Live preview", isOn: $draft.editor.livePreview)
          Toggle("Spellcheck", isOn: $draft.editor.spellcheck)
          Toggle("Show line numbers", isOn: $draft.editor.showLineNumbers)
        }

      }
    }

    private var notes: some View {
      Group {
        Section("Daily notes") {
          text("Folder", value: $draft.dailyNotes.folder)
          text("Filename format", value: $draft.dailyNotes.format)
          text("Template note", value: $draft.dailyNotes.template)
          LabeledContent("Today", value: DailyNotes.path(for: .today(), settings: draft.dailyNotes))
        }
        Section("Weekly notes") {
          text("Folder", value: $draft.weeklyNotes.folder)
          text("Filename format", value: $draft.weeklyNotes.format)
          text("Template note", value: $draft.weeklyNotes.template)
          LabeledContent(
            "This week", value: DailyNotes.weeklyPath(for: .today(), settings: draft.weeklyNotes))
        }
        Section {
          Text(
            "Formats use Moment tokens, such as YYYY-MM-DD and gggg-[W]ww. A blank folder uses the vault root; a blank template creates an empty note. Templates are ordinary notes in the vault."
          ).font(.footnote)
        }
      }
    }

    private var agent: some View {
      Group {
        Section("Agent") {
          Toggle("Agent enabled", isOn: $draft.agent.enabled)
          Toggle("Act on existing tasks", isOn: $draft.agent.actOnExistingTasks)
          number("Settle delay (ms)", value: $draft.agent.settleMs)
          Stepper(
            "Concurrent subagents: \(draft.agent.maxConcurrentSubagents)",
            value: $draft.agent.maxConcurrentSubagents, in: SettingsRanges.maxConcurrentSubagents)
        }
        Section("Models") {
          Picker("Harness", selection: $draft.agent.harness) {
            Text("Pi · OpenRouter").tag(AgentHarnessKind.pi)
            Text("Cursor CLI").tag(AgentHarnessKind.cursor)
          }
          text("OpenRouter model", value: $draft.agent.model)
          text("Cursor model", value: $draft.agent.cursorModel)
          text("Safety judge model", value: $draft.agent.judgeModel)
          Text("Credentials and Cursor CLI sign-in must be configured on \(store.hostName).").font(
            .footnote)
        }
        Section("Approvals") {
          Picker("Approval policy", selection: $draft.agent.approvalPolicy) {
            ForEach(ApprovalPolicy.allCases, id: \.self) {
              Text(MobileApprovalPolicy.title($0)).tag($0)
            }
          }
          Text(MobileApprovalPolicy.detail(draft.agent.approvalPolicy)).font(.footnote)
          number("Timeout (milliseconds)", value: $draft.agent.approvalTimeoutMs)
          Text(
            "Unanswered approvals are denied after this timeout. Widening a policy requires confirmation when saving."
          ).font(.footnote)
        }
        Section("Watched daily notes") {
          number("Days before today", value: $draft.agent.watch.pastDays)
          number("Days after today", value: $draft.agent.watch.futureDays)
          Text("Days outside this window are not watched automatically.").font(.footnote)
        }
      }
    }

    private var machine: some View {
      Section {
        Toggle(
          "Configure an always-on machine",
          isOn: Binding(
            get: { draft.remote.alwaysOnMachine != nil },
            set: { enabled in
              draft.remote.alwaysOnMachine = enabled ? AlwaysOnMachine(name: "", url: "") : nil
            }))
        if draft.remote.alwaysOnMachine != nil {
          text(
            "Machine name",
            value: Binding(
              get: { draft.remote.alwaysOnMachine?.name ?? "" },
              set: { draft.remote.alwaysOnMachine?.name = $0 }))
          text(
            "HTTPS address",
            value: Binding(
              get: { draft.remote.alwaysOnMachine?.url ?? "" },
              set: {
                draft.remote.alwaysOnMachine?.url = RemoteAccess.normalizeMachineURL($0) ?? $0
              }))
        }
        Text(
          "This name and address are shared across the vault. Each daemon pairs separately. Use Always-on machine in host management to pair \(store.hostName), check readiness or forget its credential."
        ).font(.footnote)
      }
    }

    private func text(_ title: String, value: Binding<String>) -> some View {
      TextField(title, text: value).textInputAutocapitalization(.never).autocorrectionDisabled()
    }
    private func number(_ title: String, value: Binding<Int>) -> some View {
      LabeledContent(title) {
        TextField(title, value: value, format: .number).keyboardType(.numbersAndPunctuation)
          .multilineTextAlignment(.trailing)
      }
    }
  }
#endif
