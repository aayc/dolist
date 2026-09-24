import Testing

/// Every suite of the package nests in here and runs serially: the performance budgets are
/// wall-clock medians, and the vector suites would otherwise compete with them for the CPU.
@Suite(.serialized) struct DomainTests {}
