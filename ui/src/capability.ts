export function parseCapabilityFragment(fragment: string): {
  capability: string | null;
  sanitizedFragment: string;
} {
  const parameters = new URLSearchParams(fragment.replace(/^#/, ""));
  const capability = parameters.get("cap")?.trim() || null;
  parameters.delete("cap");
  const rest = parameters.toString();
  return { capability, sanitizedFragment: rest ? `#${rest}` : "" };
}
