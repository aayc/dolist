extension MomentFormat {
  /// `parseDateWithFormat`: strict parse, like Moment's strict mode; nil unless `string` matches
  /// `format` exactly. Names, ordinals and literals match case-insensitively. A week without a
  /// month or day resolves to its first day (or to the weekday given with it), in
  /// `referenceYear` when the format has no year (default: the current year, like the core).
  /// A weekday contradicting the date, a week the year doesn't have, or an `X`/`x` token → nil.
  public static func parse(_ string: String, format: String, referenceYear: Int? = nil)
    -> LocalDate?
  {
    let formatUnits = UTF16Buffer(format)
    guard let pattern = formatUnits.withPointer({ p, n in ParsePattern(p, n) }) else { return nil }
    let input = UTF16Buffer(string)
    guard let spans = input.withPointer({ p, n in pattern.match(p, n) }) else { return nil }
    return input.withPointer { p, _ in
      resolve(pattern: pattern, spans: spans, input: p, referenceYear: referenceYear)
    }
  }

  private static func resolve(
    pattern: ParsePattern, spans: [Range<Int>], input p: UnsafePointer<UInt16>, referenceYear: Int?
  ) -> LocalDate? {
    var year: Int?
    var month: Int?
    var day: Int?
    var yearDay: Int?
    var weekYear: Int?
    var week: Int?
    var isoWeeks: Bool?
    var isoWeekYear: Bool?
    var weekday: Int?  // 0 = Sunday
    for (token, element) in pattern.groups {
      let span = spans[element]
      let number = { () -> Int in
        var value = 0
        for i in span where isASCIIDigit(p[i]) { value = value * 10 + Int(p[i] - 0x30) }
        return value
      }
      let named = { (names: [String]) -> Int in
        let value = JSCase.lowercase(p, span)
        return names.firstIndex { Array($0.lowercased().utf16).starts(with: value) } ?? -1
      }
      switch token {
      case .YYYY: year = number()
      case .YY: year = 2000 + number()
      case .gggg, .GGGG:
        weekYear = number()
        isoWeekYear = token == .GGGG
      case .gg, .GG:
        weekYear = 2000 + number()
        isoWeekYear = token == .GG
      case .MMMM, .MMM: month = named(MomentNames.months) + 1
      case .MM, .M: month = number()
      case .DD, .D, .Do: day = number()  // `Do`: the digits before the suffix, like parseInt
      case .DDDD, .DDD: yearDay = number()
      case .ww, .w:
        week = number()
        isoWeeks = false
      case .WW, .W:
        week = number()
        isoWeeks = true
      case .dddd, .ddd, .dd: weekday = named(MomentNames.weekdays)
      case .d, .e: weekday = number()
      case .E: weekday = number() % 7
      default: break  // times are informational only
      }
    }

    let date: LocalDate?
    if let week, month == nil, day == nil, yearDay == nil {
      // Like Moment, a week only decides the date when no month/day does.
      let iso = isoWeeks ?? isoWeekYear ?? false
      let resolvedYear = weekYear ?? year ?? referenceYear ?? LocalDate.today().year
      date = weekDate(weekYear: resolvedYear, week: week, iso: iso, weekday: weekday)
    } else if let year {
      if let yearDay {
        guard yearDay >= 1, yearDay <= CivilCalendar.daysInYear(year) else { return nil }
        let resolved = LocalDate(year: year, month: 1, day: 1).adding(days: yearDay - 1)
        guard (month ?? resolved.month) == resolved.month, (day ?? resolved.day) == resolved.day
        else {
          return nil
        }
        date = resolved
      } else {
        let candidate = LocalDate(year: year, month: month ?? 1, day: day ?? 1)
        date = candidate.isValid ? candidate : nil
      }
    } else {
      return nil
    }
    guard let date, weekday.map({ date.weekday == $0 }) ?? true else { return nil }
    return date
  }
}

/// The regular expression the core builds from a format (`^…$`, case-insensitive), as a sequence
/// of elements matched with the same backtracking order (greedy digit runs, alternatives in order)
/// so that the first match — and therefore the captured values — are identical.
struct ParsePattern {
  enum Element {
    /// One code unit, compared after regex case canonicalization.
    case literal(UInt16)
    /// `\d{min,max}`, greedy.
    case digits(min: Int, max: Int)
    /// A single character class like `[0-6]`.
    case digitRange(UInt16, UInt16)
    /// An alternation of fixed words (month and weekday names, AM/PM), canonicalized.
    case words([[UInt16]])
    /// `\d{1,2}(?:st|nd|rd|th)`
    case ordinal
  }

  var elements: [Element] = []
  /// The capturing groups: which token each is, and its element index.
  var groups: [(MomentToken, Int)] = []

  /// Nil when the format contains a token that can't be parsed (`X`, `x`).
  init?(_ p: UnsafePointer<UInt16>, _ n: Int) {
    for segment in MomentTokenizer.tokenize(p, n) {
      switch segment {
      case .literal(let range):
        for i in range { elements.append(.literal(JSCase.canonicalize(p[i]))) }
      case .token(let token):
        guard let element = ParsePattern.element(for: token) else { return nil }
        groups.append((token, elements.count))
        elements.append(element)
      }
    }
  }

  private static func element(for token: MomentToken) -> Element? {
    func words(_ list: [String]) -> Element {
      .words(list.map { word in word.utf16.map(JSCase.canonicalize) })
    }
    switch token {
    case .YYYY, .gggg, .GGGG: return .digits(min: 4, max: 4)
    case .YY, .gg, .GG, .MM, .DD, .ww, .WW, .HH, .hh, .mm, .ss: return .digits(min: 2, max: 2)
    case .M, .D, .w, .W, .H, .h, .m, .s: return .digits(min: 1, max: 2)
    case .DDDD: return .digits(min: 3, max: 3)
    case .DDD: return .digits(min: 1, max: 3)
    case .Do: return .ordinal
    case .MMMM: return words(MomentNames.months)
    case .MMM: return words(MomentNames.months.map { String($0.prefix(3)) })
    case .dddd: return words(MomentNames.weekdays)
    case .ddd: return words(MomentNames.weekdays.map { String($0.prefix(3)) })
    case .dd: return words(MomentNames.weekdays.map { String($0.prefix(2)) })
    case .d, .e: return .digitRange(0x30, 0x36)
    case .E: return .digitRange(0x31, 0x37)
    case .A: return words(["AM", "PM"])
    case .a: return words(["am", "pm"])
    case .X, .x: return nil
    }
  }

  private static let suffixes: [[UInt16]] = ["st", "nd", "rd", "th"].map {
    $0.utf16.map(JSCase.canonicalize)
  }

  /// The span of every element in the first match of the whole input, or nil.
  func match(_ p: UnsafePointer<UInt16>, _ n: Int) -> [Range<Int>]? {
    var spans = [Range<Int>](repeating: 0..<0, count: elements.count)
    // Failed (element, position) states: the continuation can't match from there, whatever came
    // before, so pruning them keeps the search linear without changing which match is found.
    var failed = Set<Int>()
    let width = n + 1

    func unit(_ i: Int) -> UInt16 { JSCase.canonicalize(p[i]) }
    func matches(_ word: [UInt16], at i: Int) -> Bool {
      guard i + word.count <= n else { return false }
      for (k, u) in word.enumerated() where unit(i + k) != u { return false }
      return true
    }
    func step(_ e: Int, _ pos: Int) -> Bool {
      if e == elements.count { return pos == n }
      if failed.contains(e * width + pos) { return false }
      switch elements[e] {
      case .literal(let u):
        if pos < n, unit(pos) == u, step(e + 1, pos + 1) { return true }
      case .digits(let min, let max):
        var run = 0
        while run < max && pos + run < n && isASCIIDigit(p[pos + run]) { run += 1 }
        var length = run
        while length >= min {
          spans[e] = pos..<(pos + length)
          if step(e + 1, pos + length) { return true }
          length -= 1
        }
      case .digitRange(let lo, let hi):
        if pos < n, p[pos] >= lo, p[pos] <= hi {
          spans[e] = pos..<(pos + 1)
          if step(e + 1, pos + 1) { return true }
        }
      case .words(let words):
        for word in words where matches(word, at: pos) {
          spans[e] = pos..<(pos + word.count)
          if step(e + 1, pos + word.count) { return true }
        }
      case .ordinal:
        var run = 0
        while run < 2 && pos + run < n && isASCIIDigit(p[pos + run]) { run += 1 }
        var length = run
        while length >= 1 {
          for suffix in ParsePattern.suffixes where matches(suffix, at: pos + length) {
            spans[e] = pos..<(pos + length + 2)
            if step(e + 1, pos + length + 2) { return true }
          }
          length -= 1
        }
      }
      failed.insert(e * width + pos)
      return false
    }
    return step(0, 0) ? spans : nil
  }
}
