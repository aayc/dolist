import Foundation

extension DrawingEditor {
  /// Builds an import on a disposable editor, validates its exact resulting scene, then publishes
  /// it as one undo step. A refusal leaks no files, selection, tombstones, history or saves. An
  /// interaction in progress is refused rather than ended: the import may complete long after the
  /// user asked for it.
  @discardableResult
  public func validatedImport<Result>(
    validate: (ExcalidrawScene) throws -> Void,
    operation: (DrawingEditor) throws -> Result
  ) throws -> Result {
    guard !hasActiveInteraction else { throw DrawingTransferError.interactionInProgress }
    let candidate = DrawingEditor(scene: scene, environment: environment)
    candidate.tool = tool
    candidate.style = style
    candidate.selectedIds = selectedIds
    let result = try operation(candidate)
    try validate(candidate.scene)
    scene = candidate.scene
    rebuildIndex()
    tool = candidate.tool
    select(candidate.selectedIds)
    style = candidate.style
    commit()
    return result
  }
}
