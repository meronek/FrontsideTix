export function extractTicketIdFromQrData(rawValue: string) {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  if (/^TKT_[A-Za-z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const ticketIdFromQuery = url.searchParams.get("ticketId")?.trim();
    if (ticketIdFromQuery) {
      return ticketIdFromQuery;
    }

    const match = url.pathname.match(/\/ticket\/([^/]+)/);
    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  } catch {
    return null;
  }

  return null;
}
