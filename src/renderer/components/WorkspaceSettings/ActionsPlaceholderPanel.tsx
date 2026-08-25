/**
 * Where the Actions editor will stand. The nav entry ships now so the
 * modal's shape is final before the editor lands; Phase C swaps this one
 * component for ActionsPanel and deletes this file.
 */
export function ActionsPlaceholderPanel() {
  return (
    <section className="ws-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Actions</h3>
      </div>
      <p className="ws-panel-hint">Actions are configured in the next release.</p>
    </section>
  );
}
