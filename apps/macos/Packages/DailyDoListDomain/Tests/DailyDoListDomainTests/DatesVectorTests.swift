import DailyDoListDomain
import Foundation
import Testing

extension DomainTests {
  /// dates-format.json and dates-parse.json: Moment tokens, week numbering, calendar math and strict
  /// parsing must match @ddl/core exactly.
  struct DatesVectorTests {
    struct FormatCase: Decodable {
      let date: LocalDate
      let format: String
      let expected: String
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        date = try t.date()
        format = try t.next()
        expected = try t.next()
      }
    }

    struct InstantCase: Decodable {
      let ms: Int
      let format: String
      let expected: String
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        ms = try t.next()
        format = try t.next()
        expected = try t.next()
      }
    }

    struct StartOfDay: Decodable {
      let date: LocalDate
      let ms: Int
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        date = try t.date()
        ms = try t.next()
      }
    }

    struct ToLocal: Decodable {
      let ms: Int
      let date: LocalDate
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        ms = try t.next()
        date = try t.date()
      }
    }

    struct Zone: Decodable {
      let timeZone: String
      let localDate: [FormatCase]
      let instant: [InstantCase]
      let startOfDay: [StartOfDay]
      let toLocalDate: [ToLocal]
    }

    struct WeekCase: Decodable {
      let date: LocalDate
      let dow: Int
      let doy: Int
      let week: Int
      let year: Int
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        date = try t.date()
        dow = try t.next()
        doy = try t.next()
        week = try t.next()
        year = try t.next()
      }
    }

    struct DateInt: Decodable {
      let date: LocalDate
      let n: Int
      let result: LocalDate
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        date = try t.date()
        n = try t.next()
        result = try t.date()
      }
    }

    struct Pair: Decodable {
      let a: LocalDate
      let b: LocalDate
      let n: Int
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        a = try t.date()
        b = try t.date()
        n = try t.next()
      }
    }

    struct Valid: Decodable {
      let date: LocalDate
      let valid: Bool
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        date = try t.date()
        valid = try t.next()
      }
    }

    struct ISO: Decodable {
      let date: LocalDate
      let text: String
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        date = try t.date()
        text = try t.next()
      }
    }

    struct Calendar: Decodable {
      let addDays: [DateInt]
      let daysBetween: [Pair]
      let compare: [Pair]
      let isValid: [Valid]
      let toISODate: [ISO]
    }

    struct FormatFile: Decodable {
      let timeZone: String
      let localDate: [FormatCase]
      let instant: [InstantCase]
      let zoned: [Zone]
      let weekOfYear: [WeekCase]
      let calendar: Calendar
    }

    @Test func formatLocalDate() throws {
      let file = try Vectors.load("dates-format.json", as: FormatFile.self)
      #expect(file.timeZone == Vectors.timeZone.identifier)
      var check = VectorCheck("dates-format.json localDate")
      for c in file.localDate {
        let actual = MomentFormat.format(c.date, c.format, timeZone: Vectors.timeZone)
        check.expect(same(actual, c.expected), "\(c.date) \(c.format.debug): \(actual.debug) ≠ \(c.expected.debug)")
      }
      check.verify(atLeast: 1000)
    }

    @Test func formatInstant() throws {
      let file = try Vectors.load("dates-format.json", as: FormatFile.self)
      var check = VectorCheck("dates-format.json instant")
      for c in file.instant {
        let actual = MomentFormat.format(instant: Vectors.date(ms: c.ms), c.format, timeZone: Vectors.timeZone)
        check.expect(same(actual, c.expected), "\(c.ms) \(c.format.debug): \(actual.debug) ≠ \(c.expected.debug)")
      }
      check.verify(atLeast: 100)
    }

    @Test func timeZones() throws {
      let file = try Vectors.load("dates-format.json", as: FormatFile.self)
      var check = VectorCheck("dates-format.json zoned")
      for zone in file.zoned {
        let tz = try #require(TimeZone(identifier: zone.timeZone))
        for c in zone.localDate {
          let actual = MomentFormat.format(c.date, c.format, timeZone: tz)
          check.expect(same(actual, c.expected), "\(zone.timeZone) \(c.date): \(actual.debug) ≠ \(c.expected.debug)")
        }
        for c in zone.instant {
          let actual = MomentFormat.format(instant: Vectors.date(ms: c.ms), c.format, timeZone: tz)
          check.expect(same(actual, c.expected), "\(zone.timeZone) \(c.ms): \(actual.debug) ≠ \(c.expected.debug)")
        }
        for c in zone.startOfDay {
          let actual = Int((c.date.startOfDay(in: tz).timeIntervalSince1970 * 1000).rounded())
          check.expect(actual == c.ms, "\(zone.timeZone) startOfDay \(c.date): \(actual) ≠ \(c.ms)")
        }
        for c in zone.toLocalDate {
          let actual = LocalDate(date: Vectors.date(ms: c.ms), timeZone: tz)
          check.expect(actual == c.date, "\(zone.timeZone) toLocalDate \(c.ms): \(actual) ≠ \(c.date)")
        }
      }
      check.verify(atLeast: 100)
    }

    @Test func weekOfYear() throws {
      let file = try Vectors.load("dates-format.json", as: FormatFile.self)
      var check = VectorCheck("dates-format.json weekOfYear")
      for c in file.weekOfYear {
        let actual = MomentFormat.weekOfYear(c.date, dow: c.dow, doy: c.doy)
        check.expect(
          actual == WeekOfYear(week: c.week, year: c.year),
          "\(c.date) dow \(c.dow) doy \(c.doy): \(actual) ≠ W\(c.week) \(c.year)")
      }
      check.verify(atLeast: 500)
    }

    @Test func calendarArithmetic() throws {
      let calendar = try Vectors.load("dates-format.json", as: FormatFile.self).calendar
      var check = VectorCheck("dates-format.json calendar")
      for c in calendar.addDays {
        let actual = c.date.adding(days: c.n)
        check.expect(actual == c.result, "addDays(\(c.date), \(c.n)) = \(actual) ≠ \(c.result)")
      }
      for c in calendar.daysBetween {
        let actual = LocalDate.daysBetween(c.a, c.b)
        check.expect(actual == c.n, "daysBetween(\(c.a), \(c.b)) = \(actual) ≠ \(c.n)")
        check.expect(c.a.days(to: c.b) == c.n, "\(c.a).days(to: \(c.b))")
      }
      for c in calendar.compare {
        let actual = LocalDate.compare(c.a, c.b)
        check.expect(actual == c.n, "compare(\(c.a), \(c.b)) = \(actual) ≠ \(c.n)")
        check.expect((c.a < c.b) == (c.n < 0), "\(c.a) < \(c.b)")
      }
      for c in calendar.isValid {
        check.expect(c.date.isValid == c.valid, "isValid(\(c.date)) ≠ \(c.valid)")
      }
      for c in calendar.toISODate {
        check.expect(same(c.date.isoString, c.text), "toISODate(\(c.date)) = \(c.date.isoString) ≠ \(c.text)")
      }
      check.verify(atLeast: 500)
    }

    struct ParseCase: Decodable {
      let input: String
      let format: String
      let expected: LocalDate?
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        input = try t.next()
        format = try t.next()
        expected = try t.optionalDate()
      }
    }

    struct ISOCase: Decodable {
      let input: String
      let expected: LocalDate?
      init(from decoder: Decoder) throws {
        var t = try Tuple(decoder)
        input = try t.next()
        expected = try t.optionalDate()
      }
    }

    struct ParseFile: Decodable {
      let referenceYear: Int
      let cases: [ParseCase]
      let iso: [ISOCase]
    }

    @Test func parse() throws {
      let file = try Vectors.load("dates-parse.json", as: ParseFile.self)
      var check = VectorCheck("dates-parse.json")
      var accepted = 0
      for c in file.cases {
        let actual = MomentFormat.parse(c.input, format: c.format, referenceYear: file.referenceYear)
        if actual != nil { accepted += 1 }
        check.expect(
          actual == c.expected,
          "parse(\(c.input.debug), \(c.format.debug)) = \(actual.map(\.description) ?? "nil") ≠ \(c.expected.map(\.description) ?? "nil")")
      }
      for c in file.iso {
        let actual = LocalDate(iso: c.input)
        check.expect(actual == c.expected, "LocalDate(iso: \(c.input.debug)) = \(String(describing: actual))")
      }
      check.verify(atLeast: 1000)
      // Both outcomes are well represented.
      #expect(accepted > 500)
      #expect(file.cases.count - accepted > 500)
    }
  }
}
