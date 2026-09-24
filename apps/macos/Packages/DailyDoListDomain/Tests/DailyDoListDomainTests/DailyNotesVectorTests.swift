import DailyDoListDomain
import DailyDoListModels
import Foundation
import Testing

extension DomainTests {
  /// daily-notes.json and template.json.
  struct DailyNotesVectorTests {
    struct PathCase: Decodable {
      let settings: Int
      let date: LocalDate
      let path: String?
      let error: String?
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        settings = try t.next()
        date = try t.date()
        path = try t.optional()
        error = try t.optional()
      }
    }

    struct ParseCase: Decodable {
      let settings: Int
      let path: String
      let date: LocalDate?
      let error: String?
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        settings = try t.next()
        path = try t.next()
        date = try t.optionalDate()
        error = try t.optional()
      }
    }

    struct Ref: Decodable {
      let path: String
      let date: String
    }

    struct AdjacentCase: Decodable {
      let settings: Int
      let paths: [String]
      let from: String
      let direction: Int
      let result: Ref?
    }

    struct ListCase: Decodable {
      let settings: Int
      let paths: [String]
      let result: [Ref]
    }

    struct NavigationCase: Decodable {
      let settings: Int
      let activePath: String?
      let now: Int
      let date: String
    }

    struct TemplatePathCase: Decodable {
      let template: String
      let path: String?
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        template = try t.next()
        path = try t.optional()
      }
    }

    struct WeeklyCase: Decodable {
      let settings: WeeklyNoteSettings
      let date: String
      let path: String
    }

    struct WindowCase: Decodable {
      let date: LocalDate
      let from: LocalDate
      let past: Int
      let future: Int
      let inside: Bool
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        date = try t.date()
        from = try t.date()
        past = try t.next()
        future = try t.next()
        inside = try t.next()
      }
    }

    struct File: Decodable {
      let timeZone: String
      let settings: [DailyNoteSettings]
      let paths: [PathCase]
      let parse: [ParseCase]
      let adjacent: [AdjacentCase]
      let list: [ListCase]
      let navigation: [NavigationCase]
      let templatePath: [TemplatePathCase]
      let weekly: [WeeklyCase]
      let window: [WindowCase]
    }

    let tz = Vectors.timeZone

    @Test func paths() throws {
      let file = try Vectors.load("daily-notes.json", as: File.self)
      var check = VectorCheck("daily-notes.json paths")
      for c in file.paths {
        let settings = file.settings[c.settings]
        let checked = Result {
          try DailyNotes.checkedPath(for: c.date, settings: settings, timeZone: tz)
        }
        let lenient = DailyNotes.path(for: c.date, settings: settings, timeZone: tz)
        if let expected = c.path {
          check.expect(
            same(try? checked.get(), expected),
            "checkedPath \(settings) \(c.date): \(checked) ≠ \(expected)")
          check.expect(
            same(lenient, expected), "path \(settings) \(c.date): \(lenient) ≠ \(expected)")
        } else {
          check.expect(
            c.error == "InvalidPathError", "unexpected error \(String(describing: c.error))")
          check.expect(
            (try? checked.get()) == nil, "checkedPath \(settings) \(c.date) should throw")
          check.expect(
            VaultPath.isSafe(lenient), "lenient path \(lenient.debug) must stay in the vault")
        }
      }
      check.verify(atLeast: 500)
    }

    @Test func parse() throws {
      let file = try Vectors.load("daily-notes.json", as: File.self)
      var check = VectorCheck("daily-notes.json parse")
      for c in file.parse {
        let settings = file.settings[c.settings]
        let checked = Result { try DailyNotes.checkedDate(forPath: c.path, settings: settings) }
        if c.error != nil {
          check.expect(
            (try? checked.get()) == nil, "checkedDate(\(c.path.debug)) should throw for \(settings)"
          )
          continue
        }
        let actual = DailyNotes.date(forPath: c.path, settings: settings)
        check.expect(
          (try? checked.get()) == c.date,
          "checkedDate(\(c.path.debug), \(settings)) ≠ \(String(describing: c.date))")
        check.expect(
          actual == c.date,
          "date(forPath: \(c.path.debug), \(settings)) = \(String(describing: actual))")
        check.expect(
          DailyNotes.isDailyNote(c.path, settings: settings) == (c.date != nil),
          "isDailyNote \(c.path.debug)")
      }
      check.verify(atLeast: 500)
    }

    @Test func navigation() throws {
      let file = try Vectors.load("daily-notes.json", as: File.self)
      var check = VectorCheck("daily-notes.json navigation")
      for c in file.adjacent {
        let direction: DailyNotes.Direction = c.direction < 0 ? .previous : .next
        let actual = DailyNotes.adjacent(
          paths: c.paths, from: Vectors.date(c.from), direction: direction,
          settings: file.settings[c.settings])
        let ok =
          same(actual?.path, c.result?.path)
          && actual?.date == c.result.map { Vectors.date($0.date) }
        check.expect(
          ok, "adjacent \(c.paths) from \(c.from) \(direction): \(String(describing: actual))")
      }
      for c in file.list {
        let actual = DailyNotes.list(paths: c.paths, settings: file.settings[c.settings])
        let ok =
          actual.count == c.result.count
          && zip(actual, c.result).allSatisfy {
            same($0.path, $1.path) && $0.date == Vectors.date($1.date)
          }
        check.expect(ok, "list \(c.paths): \(actual)")
      }
      for c in file.navigation {
        let actual = DailyNotes.navigationAnchor(
          activePath: c.activePath, settings: file.settings[c.settings],
          now: Vectors.date(ms: c.now), timeZone: tz)
        check.expect(
          actual == Vectors.date(c.date),
          "navigationAnchor(\(String(describing: c.activePath)), \(c.now)) = \(actual)")
      }
      for c in file.templatePath {
        let actual = DailyNotes.templatePath(c.template)
        check.expect(
          same(actual, c.path), "templatePath(\(c.template.debug)) = \(String(describing: actual))")
      }
      for c in file.weekly {
        let actual = DailyNotes.weeklyPath(
          for: Vectors.date(c.date), settings: c.settings, timeZone: tz)
        check.expect(
          same(actual, c.path), "weeklyPath(\(c.date), \(c.settings)) = \(actual) ≠ \(c.path)")
      }
      for c in file.window {
        let actual = DailyNotes.isWithinWindow(
          c.date, from: c.from, pastDays: c.past, futureDays: c.future)
        check.expect(
          actual == c.inside, "isWithinWindow(\(c.date), \(c.from), \(c.past), \(c.future))")
      }
      check.verify(atLeast: 300)
    }

    struct TemplateCase: Decodable {
      let template: String
      let title: String
      let date: String
      let now: Int
      let dateFormat: String?
      let timeFormat: String?
      let output: String
    }

    struct TemplateFile: Decodable {
      let timeZone: String
      let cases: [TemplateCase]
    }

    @Test func templates() throws {
      let file = try Vectors.load("template.json", as: TemplateFile.self)
      var check = VectorCheck("template.json")
      for c in file.cases {
        let context = NoteTemplate.Context(
          title: c.title, date: Vectors.date(c.date), now: Vectors.date(ms: c.now),
          dateFormat: c.dateFormat,
          timeFormat: c.timeFormat)
        let actual = NoteTemplate.render(c.template, context: context, timeZone: tz)
        check.expect(
          same(actual, c.output),
          "\(c.template.debug) with \(c.title.debug): \(actual.debug) ≠ \(c.output.debug)")
      }
      check.verify(atLeast: 200)
    }
  }
}
