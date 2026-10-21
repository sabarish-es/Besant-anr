import { ExternalLink, Star } from 'lucide-react';
import type { HubData } from '@/lib/hub-types';
export function StudentReviewCard({ review }: { review: HubData['googleReview'] }) {
  return <section className="student-review-card" aria-labelledby="google-review-heading">
    <div className="student-review-icon"><Star size={26} /></div>
    <div className="student-review-copy"><span className="eyebrow">YOUR EXPERIENCE MATTERS</span><h2 id="google-review-heading">Review your learning experience</h2>
      <p>{review ? `Share your experience at ${review.branchName}. Your feedback helps future students.` : 'Share your learning experience with future students.'}</p>
      <small>Reviews are optional. Attendance and course access stay available to every student.</small></div>
    {review?.url ? <a className="review-google-button" href={review.url} target="_blank" rel="noopener noreferrer">Open review link <ExternalLink size={16} /></a>
      : <span className="review-link-pending">Your branch review link will appear here once configured.</span>}
  </section>;
}
