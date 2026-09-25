import DailyDoListClient
import DailyDoListModels
import Testing

/// The daemon's validation reports, as its zod schemas print them (the integration tests check
/// the same parsing against the real daemon's bodies).
struct ValidationProblemsTests {
  @Test func eachProblemKeepsItsPath() {
    let body = ApiErrorBody(
      error: .invalidRequest,
      message:
        "✖ Too small: expected string to have >=1 characters\n  → at name\n✖ must be a DNS name with an optional :port (no scheme, path, IP address or loopback name)\n  → at remoteHosts[0]"
    )
    #expect(
      body.problems == [
        ValidationProblem(
          path: "name", message: "Too small: expected string to have >=1 characters"),
        ValidationProblem(
          path: "remoteHosts[0]",
          message:
            "must be a DNS name with an optional :port (no scheme, path, IP address or loopback name)"
        ),
      ])
    #expect(body.problems.first?.description.hasPrefix("name: Too small") == true)
  }

  @Test func otherMessagesAreOneProblemWithoutAPath() {
    let body = ApiErrorBody(
      error: .invalidRequest, message: "No vault token is saved yet: include `token`")
    #expect(
      body.problems == [
        ValidationProblem(path: nil, message: "No vault token is saved yet: include `token`")
      ])
    #expect(ApiErrorBody(error: .invalidRequest).problems.isEmpty)
    #expect(
      ApiErrorBody(error: .invalidRequest, message: "✖ Invalid input\n  → at a\n  → at b").problems
        == [
          ValidationProblem(path: "a", message: "Invalid input"),
          ValidationProblem(path: nil, message: "→ at b"),
        ])
  }
}
