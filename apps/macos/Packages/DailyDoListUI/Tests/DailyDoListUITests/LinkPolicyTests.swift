import Foundation
import Testing

@testable import DailyDoListUI

@Suite("Link policy")
struct LinkPolicyTests {
  @Test(arguments: [
    "https://example.com/path?q=1", "http://example.com", "HTTPS://EXAMPLE.COM",
    "http://127.0.0.1:7331", "mailto:sam@example.com", "MAILTO:sam@example.com",
    "mailto:?subject=Hi", "tel:+15550100", "tel:555-0100",
  ])
  func webMailAndPhoneLinksOpen(_ link: String) throws {
    #expect(LinkPolicy.isAllowed(try #require(URL(string: link))))
  }

  @Test(arguments: [
    "javascript:alert(1)", "JavaScript:alert(1)", "file:///etc/hosts", "data:text/html,hi",
    "ftp://example.com", "sms:+15550100", "x-apple.systempreferences:com.apple.preference",
    "ddl-note:Ideas", "ddl://open", "about:blank", "vbscript:msgbox",
  ])
  func otherSchemesNeverOpen(_ link: String) throws {
    #expect(!LinkPolicy.isAllowed(try #require(URL(string: link))))
  }

  @Test(arguments: ["http:relative", "https:", "https://", "http:/path", "https:///path"])
  func webLinksNeedAHost(_ link: String) throws {
    #expect(!LinkPolicy.isAllowed(try #require(URL(string: link))))
  }

  @Test(arguments: ["mailto:", "tel:", "MAILTO:"])
  func mailAndPhoneLinksNeedAnAddress(_ link: String) throws {
    #expect(!LinkPolicy.isAllowed(try #require(URL(string: link))))
  }

  @Test func relativeLinksNeverOpen() throws {
    for link in ["Notes/Plan.md", "#heading", "//example.com", "example.com"] {
      #expect(!LinkPolicy.isAllowed(try #require(URL(string: link))), "\(link)")
    }
  }

  @Test func onlyAllowedLinksAreHandedOn() throws {
    var opened: [URL] = []
    let refused = ["javascript:alert(1)", "file:///etc/hosts", "http:relative", "mailto:"]
    for link in refused {
      #expect(!LinkPolicy.handle(try #require(URL(string: link))) { opened.append($0) })
    }
    let allowed = try #require(URL(string: "tel:+15550100"))
    #expect(LinkPolicy.handle(allowed) { opened.append($0) })
    #expect(opened == [allowed])
  }
}
