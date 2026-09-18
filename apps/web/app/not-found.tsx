import Link from 'next/link';

export default function NotFoundPage() {
  return (
    <div>
      <h1 className="text-[28px] font-bold leading-tight tracking-tight">No such page</h1>
      <p className="mt-2 text-ink-2">
        The review may have been deleted, or the link is wrong. <Link href="/reviews">See all reviews</Link>.
      </p>
    </div>
  );
}
