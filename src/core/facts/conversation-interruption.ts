/** Exact transport status emitted when Hermes is interrupted before a reply. */
export function isHarnessInterruptionStatus(text: string): boolean {
  // Keep this anchored: broad "interrupted" matching could erase legitimate
  // discussion. The optional footer is structural text folded by the parser.
  return /^Operation interrupted:\s*waiting for model response(?:\s*\([^\n)]* elapsed\))?\.?(?:\n+## Segments(?:\n- \[\[[^\]\n]+\]\])*)?$/i
    .test(text.trim());
}
