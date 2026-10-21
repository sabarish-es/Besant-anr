import type { Member, Row } from './hub-types';
// Review links are administrator-controlled external URLs, never fetched by our backend.
// Permit standard Google Maps, shortened review links, and other HTTPS public review pages.
export function safeGoogleReviewUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !host.includes('.') ||
        host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        host.endsWith('.internal') || host.endsWith('.test') || host.endsWith('.example') ||
        /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':') ||
        url.href.length > 2048) return '';
    return url.href;
  } catch { return ''; }
}
export function studentBranchReview(member: Member, records: Row[]) {
  if (member.role !== 'student') return null;
  const batch = records.find(row => row.kind === 'batches' && row.id === member.data.batchId);
  const branch = records.find(row => row.kind === 'branches' && row.id === batch?.data.branchId);
  if (!branch) return null;
  return { branchId: branch.id, branchName: String(branch.data.name), url: safeGoogleReviewUrl(branch.data.googleReviewUrl) };
}
