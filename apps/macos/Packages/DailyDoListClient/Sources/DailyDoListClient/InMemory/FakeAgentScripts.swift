import DailyDoListModels
import Foundation

/// What the simulated agent does for one task (same scripts as the web app's mock agent, with
/// synthetic content only).
struct AgentScript: Sendable {
  struct ToolStep: Sendable {
    var toolName: String
    var label: String
    var input: JSONValue
    var resultPreview: String
    var durationMs: Double
    /// Browser page shown while the step runs (streams `surface.frame`s to subscribers).
    var page: BrowserPage?
  }

  struct BrowserPage: Sendable {
    var url: String
    var title: String
    var action: String
  }

  struct Artifact: Sendable {
    var title: String
    var content: String
  }

  struct RiskyAction: Sendable {
    var toolName: String
    var toolLabel: String
    var input: JSONValue
    var summary: String
    var risk: RiskLevel
    var categories: [ActionCategory]
    var reason: String
    var approvedText: String
    var approvedSummary: String
    var deniedText: String
    var deniedSummary: String
  }

  var subagent: String
  var workingSummary: String
  var intro: String
  var steps: [ToolStep]
  var artifact: Artifact
  var risky: RiskyAction?
  var finalText: String
  var doneSummary: String

  var author: MessageAuthor { "subagent:\(subagent)" }

  /// Whole-word verbs that need approval (the web mock's `RISKY_TASK_RE`).
  static let riskyVerbs = ["buy", "order", "book", "reserve", "email", "send", "pay"]

  /// The first risky verb in `text`, if any.
  static func riskyVerb(in text: String) -> String? {
    let words = text.lowercased().split { !$0.isLetter && !$0.isNumber && $0 != "_" }
    return words.first { riskyVerbs.contains(String($0)) }.map(String.init)
  }

  static func mentionsBrowsing(_ text: String) -> Bool {
    text.range(of: "browse", options: .caseInsensitive) != nil
  }

  static func forTask(_ text: String) -> AgentScript {
    let topic = topicOf(text)
    let browse = mentionsBrowsing(text)
    switch riskyVerb(in: text) {
    case "buy", "order", "pay": return purchase(topic, browse: browse)
    case "book", "reserve": return booking(topic, browse: browse)
    case "email", "send": return message(topic)
    default: return research(topic, browse: browse)
    }
  }

  /// The task text without wikilink brackets, collapsed, at most 70 characters.
  static func topicOf(_ text: String) -> String {
    let clean = text.replacingOccurrences(of: "[[", with: "").replacingOccurrences(of: "]]", with: "")
      .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return clean.count > 70 ? String(clean.prefix(69)) + "…" : clean
  }

  private static func slug(_ text: String) -> String {
    APIRoute.encodeURIComponent(String(text.lowercased().prefix(40)))
  }

  private static func research(_ topic: String, browse: Bool) -> AgentScript {
    let url = "https://guide.example/search?q=\(slug(topic))"
    var steps = [
      ToolStep(
        toolName: "web_search", label: "Web search", input: ["query": .string(topic), "maxResults": 8],
        resultPreview: "8 results · 3 look relevant", durationMs: 800)
    ]
    if browse {
      steps += [
        ToolStep(
          toolName: "browser_navigate", label: "Open page", input: ["url": .string(url)],
          resultPreview: "Loaded guide.example (200)", durationMs: 1300,
          page: BrowserPage(url: url, title: "\(topic) — Guide", action: "navigate")),
        ToolStep(
          toolName: "browser_extract_text", label: "Read page", input: ["maxChars": 4000],
          resultPreview: "Extracted 3 candidate options with prices and ratings", durationMs: 1000,
          page: BrowserPage(url: url, title: "\(topic) — Guide", action: "scroll")),
      ]
    } else {
      steps.append(
        ToolStep(
          toolName: "web_fetch", label: "Read page", input: ["url": .string(url)],
          resultPreview: "Extracted 3 candidate options with prices and ratings", durationMs: 1000))
    }
    return AgentScript(
      subagent: "research", workingSummary: "Researching…",
      intro: "On it. I'll research **\(topic)**, compare the strongest options and write up a short summary.",
      steps: steps,
      artifact: Artifact(
        title: "Comparison — \(topic)",
        content: """
          # \(topic)

          | Option | Price | Rating | Why pick it |
          | --- | --- | --- | --- |
          | **A — all-rounder** | $129 | 4.7 ★ | Best balance of price and quality |
          | B — premium | $189 | 4.8 ★ | Sturdiest build, longest warranty |
          | C — budget | $79 | 4.4 ★ | Cheapest option that still reviews well |

          ## Recommendation
          Go with **Option A** unless build quality matters more than price.

          _Sources: guide.example, reviews.example (synthetic demo data)._
          """),
      risky: nil,
      finalText: """
        Done! I compared three options for **\(topic)**:

        - **Option A** ($129) — best overall value
        - **Option B** ($189) — premium build
        - **Option C** ($79) — budget pick

        The full comparison is in the artifact.
        """,
      doneSummary: "3 options")
  }

  private static func purchase(_ topic: String, browse: Bool) -> AgentScript {
    let url = "https://shop.example/p/\(slug(topic))"
    return AgentScript(
      subagent: "shopper", workingSummary: "Shopping…",
      intro: "I'll find a good match for **\(topic)** and get it ready to order. I'll ask before anything is paid for.",
      steps: [
        ToolStep(
          toolName: "web_search", label: "Web search", input: ["query": .string(topic)],
          resultPreview: "Best match on shop.example ($24.99, 4.6 ★)", durationMs: 800),
        ToolStep(
          toolName: "browser_click", label: "Click in browser", input: ["element": "Add to cart button", "ref": "e31"],
          resultPreview: "Added to cart — subtotal $24.99", durationMs: 900,
          page: browse ? BrowserPage(url: url, title: "\(topic) — Shop", action: "click") : nil),
      ],
      artifact: Artifact(
        title: "Order summary",
        content: """
          # Order summary

          | Item | Merchant | Price | Shipping | Total |
          | --- | --- | --- | --- | --- |
          | \(topic) | shop.example | $24.99 | free | **$24.99** |

          Delivery in 2 days. _(Synthetic demo data.)_
          """),
      risky: RiskyAction(
        toolName: "browser_click", toolLabel: "Click in browser", input: ["element": "Place order button", "ref": "e57"],
        summary: "Place order for “\(topic)” — $24.99 with the saved card", risk: .high,
        categories: [.payment, .formSubmission], reason: "This spends money on your behalf.",
        approvedText: "Order placed ✅ Confirmation **#DDL-4821**, arriving in 2 days.",
        approvedSummary: "Ordered · arrives in 2 days",
        deniedText: "Okay — I did **not** place the order. The item is still in the cart if you want to finish it yourself.",
        deniedSummary: "Not ordered"),
      finalText: "", doneSummary: "")
  }

  private static func booking(_ topic: String, browse: Bool) -> AgentScript {
    let url = "https://booking.example/availability?q=\(slug(topic))"
    return AgentScript(
      subagent: "booker", workingSummary: "Checking availability…",
      intro: "Looking for availability for **\(topic)**. I'll pick the earliest good slot and check with you before confirming.",
      steps: [
        ToolStep(
          toolName: "browser_navigate", label: "Open page", input: ["url": .string(url)],
          resultPreview: "3 open slots this week", durationMs: 1200,
          page: browse ? BrowserPage(url: url, title: "Availability — booking.example", action: "navigate") : nil),
        ToolStep(
          toolName: "browser_select_option", label: "Select option", input: ["element": "Time slot", "values": ["Tue 9:30 AM"]],
          resultPreview: "Selected Tue 9:30 AM", durationMs: 900),
      ],
      artifact: Artifact(
        title: "Available slots",
        content: """
          # Available slots — \(topic)

          - **Tue 9:30 AM** · 45 min (earliest)
          - Wed 1:00 PM · 45 min
          - Thu 4:15 PM · waitlist

          _(Synthetic demo data.)_
          """),
      risky: RiskyAction(
        toolName: "browser_click", toolLabel: "Click in browser", input: ["element": "Confirm booking button", "ref": "e12"],
        summary: "Book “\(topic)” for Tue 9:30 AM", risk: .medium, categories: [.booking, .formSubmission],
        reason: "This makes a reservation in your name.",
        approvedText: "Booked for **Tue 9:30 AM** ✅ A confirmation was sent to your inbox.",
        approvedSummary: "Booked · Tue 9:30 AM",
        deniedText: "No problem — nothing was booked. Tue 9:30 AM was the earliest open slot.",
        deniedSummary: "Not booked"),
      finalText: "", doneSummary: "")
  }

  private static func message(_ topic: String) -> AgentScript {
    let body = "Hi Sam,\n\nQuick update on “\(topic)”: everything is on track and I'll share details by Friday.\n\nThanks!"
    return AgentScript(
      subagent: "writer", workingSummary: "Drafting…",
      intro: "I'll draft a message for **\(topic)** using your notes, then check with you before sending.",
      steps: [
        ToolStep(
          toolName: "search_notes", label: "Search notes", input: ["query": .string(topic), "limit": 5],
          resultPreview: "2 related notes", durationMs: 700),
        ToolStep(
          toolName: "create_artifact", label: "Create artifact", input: ["title": "Draft email", "kind": "markdown"],
          resultPreview: "Draft ready (24 words)", durationMs: 700),
      ],
      artifact: Artifact(title: "Draft email", content: "**To:** sam@example.com\n**Subject:** Quick update\n\n\(body)"),
      risky: RiskyAction(
        toolName: "mcp__mail__send_message", toolLabel: "Send email",
        input: ["to": "sam@example.com", "subject": "Quick update", "body": .string(body)],
        summary: "Send email to sam@example.com — “Quick update”", risk: .medium, categories: [.communication],
        reason: "This sends a message to another person on your behalf.",
        approvedText: "Sent ✅ The email to **sam@example.com** is on its way.",
        approvedSummary: "Sent",
        deniedText: "Understood — I didn't send it. The draft is saved as an artifact if you want to reuse it.",
        deniedSummary: "Draft ready · not sent"),
      finalText: "", doneSummary: "")
  }

  /// A 16×10 PNG of a stylized web page, the image of every simulated `surface.frame`.
  static let framePNGBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAIAAAAy3EnLAAAAKElEQVR42mOI9r1GEmIgWcMvEgFUw5MnzwkiyjSQ7KQrV24QR"
    + "IPWBgCs1ZaYle3XrwAAAABJRU5ErkJggg=="
  static let frameSize = (width: 16, height: 10)
}

extension String {
  /// Splits after every whitespace character, like `text.split(/(?<=\s)/)`: the chunks a
  /// streamed message arrives in.
  var streamingChunks: [String] {
    var chunks: [String] = []
    var current = ""
    for character in self {
      current.append(character)
      if character.isWhitespace {
        chunks.append(current)
        current = ""
      }
    }
    if !current.isEmpty || chunks.isEmpty { chunks.append(current) }
    return chunks
  }
}
