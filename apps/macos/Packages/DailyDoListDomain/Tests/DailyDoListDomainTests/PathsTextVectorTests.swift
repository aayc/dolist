import DailyDoListDomain
import Foundation
import Testing

extension DomainTests {
  /// paths.json, text.json and wikilinks.json.
  struct PathsTextVectorTests {
    struct NormalizeCase: Decodable {
      let input: String
      let output: String?
      let error: String?
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        input = try t.next()
        output = try t.optional()
        error = try t.optional()
      }
    }

    struct Helpers: Decodable {
      let path: String
      let isSafe: Bool
      let dirname: String
      let basename: String
      let extname: String
      let stem: String
      let isMarkdown: Bool
      let ensureMarkdown: String
      let isHidden: Bool
      let isSidecar: Bool
      let ancestors: [String]
    }

    struct JoinCase: Decodable {
      let parts: [String]
      let output: String?
      let error: String?
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        parts = try t.next()
        output = try t.optional()
        error = try t.optional()
      }
    }

    struct CompareCase: Decodable {
      let a: String
      let b: String
      let sign: Int
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        a = try t.next()
        b = try t.next()
        sign = try t.next()
      }
    }

    struct PathFile: Decodable {
      let sidecarDir: String
      let normalize: [NormalizeCase]
      let helpers: [Helpers]
      let join: [JoinCase]
      let locale: String
      let compare: [CompareCase]
    }

    private static func reason(_ error: InvalidPathError) -> String {
      error.reason == .nulByte ? "nul" : "escape"
    }

    @Test func paths() throws {
      let file = try Vectors.load("paths.json", as: PathFile.self)
      #expect(file.sidecarDir == VaultPath.sidecarDirectory)
      var check = VectorCheck("paths.json")
      for c in file.normalize {
        let result = attempt { () throws(InvalidPathError) in try VaultPath.validated(c.input) }
        switch result {
        case .success(let output):
          check.expect(
            same(output, c.output),
            "validated(\(c.input.debug)) = \(output.debug) ≠ \(String(describing: c.output))")
          check.expect(
            same(VaultPath.normalize(c.input), output),
            "normalize(\(c.input.debug)) differs from validated")
        case .failure(let error):
          check.expect(
            Self.reason(error) == c.error,
            "validated(\(c.input.debug)) threw \(error), expected \(String(describing: c.error))")
          let lenient = VaultPath.normalize(c.input)
          check.expect(
            error.reason == .nulByte || same(try? VaultPath.validated(lenient), lenient),
            "lenient normalize(\(c.input.debug)) = \(lenient.debug) is not canonical")
        }
      }
      for h in file.helpers {
        let p = h.path
        check.expect(VaultPath.isSafe(p) == h.isSafe, "isSafe(\(p.debug))")
        check.expect(
          same(VaultPath.dirname(p), h.dirname),
          "dirname(\(p.debug)) = \(VaultPath.dirname(p).debug)")
        check.expect(
          same(VaultPath.basename(p), h.basename),
          "basename(\(p.debug)) = \(VaultPath.basename(p).debug)")
        check.expect(
          same(VaultPath.extname(p), h.extname),
          "extname(\(p.debug)) = \(VaultPath.extname(p).debug)")
        check.expect(
          same(VaultPath.stem(p), h.stem), "stem(\(p.debug)) = \(VaultPath.stem(p).debug)")
        check.expect(VaultPath.isMarkdown(p) == h.isMarkdown, "isMarkdown(\(p.debug))")
        check.expect(
          same(VaultPath.ensureMarkdownExtension(p), h.ensureMarkdown),
          "ensureMarkdownExtension(\(p.debug))")
        check.expect(VaultPath.isHidden(p) == h.isHidden, "isHidden(\(p.debug))")
        check.expect(VaultPath.isSidecar(p) == h.isSidecar, "isSidecar(\(p.debug))")
        check.expect(
          same(VaultPath.ancestorFolders(p), h.ancestors),
          "ancestorFolders(\(p.debug)) = \(VaultPath.ancestorFolders(p))")
      }
      for c in file.join {
        let result = attempt { () throws(InvalidPathError) in try VaultPath.validatedJoin(c.parts) }
        switch result {
        case .success(let output):
          check.expect(same(output, c.output), "validatedJoin(\(c.parts)) = \(output.debug)")
          check.expect(same(VaultPath.join(c.parts), output), "join(\(c.parts)) differs")
        case .failure(let error):
          check.expect(Self.reason(error) == c.error, "validatedJoin(\(c.parts)) threw \(error)")
        }
      }
      check.verify(atLeast: 500)
    }

    @Test func naturalOrder() throws {
      let file = try Vectors.load("paths.json", as: PathFile.self)
      let locale = Locale(identifier: file.locale)
      var check = VectorCheck("paths.json compare")
      for c in file.compare {
        let actual = VaultPath.compare(c.a, c.b, locale: locale)
        check.expect(
          actual == c.sign, "compare(\(c.a.debug), \(c.b.debug)) = \(actual) ≠ \(c.sign)")
      }
      check.verify(atLeast: 1000)
    }

    struct StringPair: Decodable {
      let a: String
      let b: String
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        a = try t.next()
        b = try t.next()
      }
    }

    struct DiceCase: Decodable {
      let a: String
      let b: String
      let score: Double
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        a = try t.next()
        b = try t.next()
        score = try t.next()
      }
    }

    struct PrefixCase: Decodable {
      let a: String
      let b: String
      let min: Int
      let result: Bool
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        a = try t.next()
        b = try t.next()
        min = try t.next()
        result = try t.next()
      }
    }

    struct TruncateCase: Decodable {
      let text: String
      let max: Int
      let output: String
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        text = try t.next()
        max = try t.next()
        output = try t.next()
      }
    }

    struct SplitCase: Decodable {
      let text: String
      let lines: [String]
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        text = try t.next()
        lines = try t.next()
      }
    }

    struct TextFile: Decodable {
      let normalize: [StringPair]
      let dice: [DiceCase]
      let prefix: [PrefixCase]
      let truncate: [TruncateCase]
      let hash: [TruncateCase]
      let splitLines: [SplitCase]
    }

    @Test func text() throws {
      let file = try Vectors.load("text.json", as: TextFile.self)
      var check = VectorCheck("text.json")
      for c in file.normalize {
        let actual = TextTools.normalize(c.a)
        check.expect(same(actual, c.b), "normalize(\(c.a.debug)) = \(actual.debug) ≠ \(c.b.debug)")
      }
      for c in file.dice {
        let actual = TextTools.diceSimilarity(c.a, c.b)
        check.expect(actual == c.score, "dice(\(c.a.debug), \(c.b.debug)) = \(actual) ≠ \(c.score)")
      }
      for c in file.prefix {
        let actual = TextTools.isPrefixExtension(c.a, c.b, minLength: c.min)
        check.expect(actual == c.result, "isPrefixExtension(\(c.a.debug), \(c.b.debug), \(c.min))")
      }
      for c in file.truncate {
        let actual = TextTools.truncate(c.text, max: c.max)
        check.expect(
          same(actual, c.output),
          "truncate(\(c.text.debug), \(c.max)) = \(actual.debug) ≠ \(c.output.debug)")
      }
      for c in file.hash {
        let actual = TextTools.hash(c.text, seed: c.max)
        check.expect(
          actual == c.output, "hash(\(c.text.debug), \(c.max)) = \(actual) ≠ \(c.output)")
      }
      for c in file.splitLines {
        let actual = TextTools.splitLines(c.text)
        check.expect(same(actual, c.lines), "splitLines(\(c.text.debug)) = \(actual)")
      }
      check.verify(atLeast: 500)
    }

    struct Link: Decodable {
      let target: String
      let subpath: String?
      let alias: String?
      let embed: Bool
      let from: Int
      let to: Int
    }

    struct LinkCase: Decodable {
      let text: String
      let links: [Link]
    }

    struct ResolveCase: Decodable {
      let target: String
      let paths: [String]
      let result: String?
    }

    struct LinkFile: Decodable {
      let parse: [LinkCase]
      let resolve: [ResolveCase]
    }

    @Test func wikiLinks() throws {
      let file = try Vectors.load("wikilinks.json", as: LinkFile.self)
      var check = VectorCheck("wikilinks.json")
      for c in file.parse {
        let actual = WikiLinks.parse(c.text)
        let ok =
          actual.count == c.links.count
          && zip(actual, c.links).allSatisfy { a, e in
            same(a.target, e.target) && same(a.subpath, e.subpath) && same(a.alias, e.alias)
              && a.embed == e.embed
              && a.from == e.from && a.to == e.to
          }
        check.expect(ok, "parse(\(c.text.debug)) = \(actual) ≠ \(c.links)")
      }
      for c in file.resolve {
        let actual = WikiLinks.resolve(c.target, in: c.paths)
        check.expect(
          same(actual, c.result),
          "resolve(\(c.target.debug), \(c.paths)) = \(String(describing: actual))")
      }
      check.verify(atLeast: 200)
    }
  }
}
