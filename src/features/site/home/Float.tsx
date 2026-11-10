/**
 * Floating preview cards: no backdrop box, each card springs in, then drifts
 * gently and shifts with the pointer by its own depth. The cluster is laid out
 * at a fixed design size and scaled down to fit narrow screens. Everything is
 * still under prefers-reduced-motion.
 */
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from 'framer-motion';
import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const Pointer = createContext<{ x: MotionValue<number>; y: MotionValue<number> } | null>(null);

export function FloatCluster({ width, height, className, children }: { width: number; height: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const reduce = useReducedMotion();
  const px = useMotionValue(0);
  const py = useMotionValue(0);
  const x = useSpring(px, { stiffness: 60, damping: 18 });
  const y = useSpring(py, { stiffness: 60, damping: 18 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / width));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (reduce || e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    px.set(((e.clientX - r.left) / r.width - 0.5) * 2);
    py.set(((e.clientY - r.top) / r.height - 0.5) * 2);
  };
  const leave = () => {
    px.set(0);
    py.set(0);
  };

  return (
    <div ref={ref} className={cn('relative mx-auto w-full select-none', className)} style={{ maxWidth: width, height: height * scale }} onPointerMove={move} onPointerLeave={leave} aria-hidden="true">
      <div className="absolute top-0 left-0 origin-top-left" style={{ width, height, transform: `scale(${scale})` }}>
        <Pointer.Provider value={{ x, y }}>{children}</Pointer.Provider>
      </div>
    </div>
  );
}

/**
 * One card in a cluster. `style` positions it (top/left/right/bottom),
 * `rotate` is its resting tilt, `depth` how far it follows the pointer.
 */
export function FloatCard({
  children,
  style,
  rotate = 0,
  depth = 10,
  delay = 0,
  drift = 7,
  from = { x: 0, y: 36 },
  className,
}: {
  children: ReactNode;
  style: CSSProperties;
  rotate?: number;
  depth?: number;
  delay?: number;
  /** seconds per float cycle */
  drift?: number;
  from?: { x: number; y: number };
  className?: string;
}) {
  const reduce = useReducedMotion();
  const p = useContext(Pointer);
  const zero = useMotionValue(0);
  const tx = useTransform(p?.x ?? zero, (v) => v * depth);
  const ty = useTransform(p?.y ?? zero, (v) => v * depth);
  return (
    <motion.div
      className={cn('absolute', className)}
      style={{ ...style, x: tx, y: ty }}
      initial={reduce ? false : { opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.5, delay }}
    >
      <div style={{ transform: `rotate(${rotate}deg)` }}>
        <motion.div
          initial={reduce ? false : { x: from.x, y: from.y, rotate: -6, scale: 0.92 }}
          whileInView={{ x: 0, y: 0, rotate: 0, scale: 1 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ type: 'spring', stiffness: 70, damping: 14, delay }}
          whileHover={reduce ? undefined : { scale: 1.035, rotate: -rotate * 0.6, transition: { type: 'spring', stiffness: 200, damping: 18 } }}
        >
          <div className="float-card" style={{ animationDuration: `${drift}s`, animationDelay: `${-delay * 3}s` }}>
            {children}
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
