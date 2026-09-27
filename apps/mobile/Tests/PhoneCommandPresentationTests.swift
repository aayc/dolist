import SwiftUI
import Testing
import UIKit

@testable import DailyDoList

@MainActor @Suite(.serialized)
struct PhoneCommandPresentationTests {
  @Test func localSheetsBlockCommandsButOwnedPaletteRemainsUsableUntilANestedSheetOpens() async {
    let root = UIViewController()
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 800))
    window.rootViewController = root
    window.isHidden = false
    defer { window.isHidden = true }
    let rootProbe = probe(in: root)
    let gate = PhoneCommandPresentationGate()
    gate.rootProbe = rootProbe
    #expect(gate.permitsActions)
    let backlinks = UIViewController()
    await present(backlinks, from: root)
    #expect(!gate.permitsActions)
    await dismiss(backlinks)
    #expect(gate.permitsActions)
    let palette = UIViewController()
    palette.modalPresentationStyle = .fullScreen
    let ownedProbe = probe(in: palette)
    gate.ownedProbe = ownedProbe
    gate.ownedPresentationIsActive = { true }
    await present(palette, from: root)
    #expect(gate.permitsActions)
    let picker = UIViewController()
    await present(picker, from: palette)
    #expect(!gate.permitsActions)
    await dismiss(picker)
    #expect(gate.permitsActions)
    gate.ownedPresentationIsActive = { false }
    #expect(!gate.permitsActions)
    await dismiss(palette)
    #expect(gate.permitsActions)
    gate.rootProbe = nil
    #expect(!gate.permitsActions)
  }

  private func probe(in parent: UIViewController) -> UIViewController {
    let probe = UIViewController()
    parent.addChild(probe)
    parent.view.addSubview(probe.view)
    probe.didMove(toParent: parent)
    return probe
  }
  private func present(_ child: UIViewController, from parent: UIViewController) async {
    await withCheckedContinuation { continuation in
      parent.present(child, animated: false) { continuation.resume() }
    }
  }
  private func dismiss(_ child: UIViewController) async {
    await withCheckedContinuation { continuation in
      child.dismiss(animated: false) { continuation.resume() }
    }
  }
}
