/** Format human-readable messages without modifying the stored report or its identifiers. */
export function uiText(value: string): string {
  return value.replace(/\s*\u00b7\s*/gu, " - ").replace(/\p{Dash}/gu, "-");
}
