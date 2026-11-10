/**
 * "Atlas AI at work": a horizontal photo carousel of real blog posts and
 * guides. Scroll-snap track, previous/next buttons, keyboard and touch friendly.
 */
import { ArrowLeft, ArrowRight, ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { POSTS } from '../content/blog';
import { PHOTOS, type Photo } from '../content/photos';
import { Container, Reveal, SectionHeading, SitePhoto } from '../layout/ui';

type Slide = { href: string; label: string; title: string; photo: Photo };

const SLIDES: Slide[] = [
  ...POSTS.map((p) => ({ href: `/blog/${p.slug}`, label: `Blog · ${p.category}`, title: p.title, photo: p.image })),
  { href: '/docs/deep-research', label: 'Guide', title: 'Deep Research: a cited report from many sources', photo: PHOTOS.research },
  { href: '/docs/documents', label: 'Guide', title: 'Ask questions about a PDF, Word or Excel file', photo: PHOTOS.documents },
  { href: '/docs/images', label: 'Guide', title: 'Create and edit images from a description', photo: PHOTOS.images },
  { href: '/docs/voice-mode', label: 'Guide', title: 'Voice Mode: talk it through, hands free', photo: PHOTOS.voice },
  { href: '/docs/voice', label: 'Guide', title: 'Dictate, listen back and translate', photo: PHOTOS.translate },
];

export function InAction() {
  const track = useRef<HTMLUListElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const update = () => setEdge({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8 });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  const go = (dir: 1 | -1) => {
    const el = track.current;
    const card = el?.querySelector('li');
    if (!el || !card) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * (card.clientWidth + 16), behavior: reduce ? 'auto' : 'smooth' });
  };

  const arrow = 'grid size-11 place-items-center rounded-full border border-border bg-elevated text-fg transition-[background-color,opacity,transform] hover:bg-fg hover:text-bg active:scale-95 disabled:pointer-events-none disabled:opacity-35';

  return (
    <section className="overflow-hidden py-20 sm:py-28" aria-labelledby="in-action-title" aria-roledescription="carousel">
      <Container>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <Reveal>
            <SectionHeading eyebrow="In action" title={<span id="in-action-title">See Atlas AI at work.</span>} lead="Stories from the blog and step-by-step guides for the things people use it for most." />
          </Reveal>
          <div className="flex shrink-0 gap-2">
            <button type="button" className={arrow} onClick={() => go(-1)} disabled={edge.start} aria-label="Previous" aria-controls="in-action-track">
              <ArrowLeft className="size-4.5" aria-hidden="true" />
            </button>
            <button type="button" className={arrow} onClick={() => go(1)} disabled={edge.end} aria-label="Next" aria-controls="in-action-track">
              <ArrowRight className="size-4.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </Container>
      <Container>
        <ul ref={track} id="in-action-track" className="no-scrollbar -mx-4 mt-12 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:scroll-px-6 sm:px-6 lg:-mx-8 lg:scroll-px-8 lg:px-8">
          {SLIDES.map((s, i) => (
            <li key={s.href} className="w-[72%] shrink-0 snap-start sm:w-[300px] lg:w-[320px]" aria-roledescription="slide" aria-label={`${i + 1} of ${SLIDES.length}`}>
              <Link to={s.href} className="group block rounded-[22px] focus-visible:outline-offset-4">
                <div className="relative aspect-[4/5] overflow-hidden rounded-[22px] bg-surface">
                  <SitePhoto photo={s.photo} sizes="(min-width: 640px) 320px, 72vw" className="transition-transform duration-[900ms] ease-out group-hover:scale-[1.06] motion-reduce:transition-none" />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" aria-hidden="true" />
                  <span className="absolute top-4 left-4 rounded-full bg-white/90 px-3 py-1 text-[12px] font-medium text-[#0b0907] backdrop-blur">{s.label}</span>
                  <span className="absolute top-4 right-4 grid size-9 place-items-center rounded-full bg-white/90 text-[#0b0907] opacity-0 transition-[opacity,transform] duration-300 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:opacity-100 -translate-x-1" aria-hidden="true">
                    <ArrowUpRight className="size-4" />
                  </span>
                  <h3 className="absolute inset-x-5 bottom-5 text-[17px] leading-snug font-semibold tracking-tight text-balance text-white sm:text-[19px]">{s.title}</h3>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
