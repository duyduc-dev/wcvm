/** A name typed into the inline create/rename input — `null` means it's fine to submit. */
export function validateEntryName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name can't be empty";
  if (trimmed.includes("/")) return 'Name can\'t contain "/"';
  if (trimmed === "." || trimmed === "..") return "Invalid name";
  return null;
}
