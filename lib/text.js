/** Lowercase and split into alphanumeric tokens longer than 2 chars. */
export function tokenize(term) {
  return (term || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}
