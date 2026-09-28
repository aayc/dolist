import Foundation

extension DrawingEditor {
  /// Build an import on a disposable editor, validate its exact resulting scene, then publish one
  /// undo step. Refusal cannot leak files, selection changes, tombstones or history into the editor.
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
    commit()
    return result
  }
}
