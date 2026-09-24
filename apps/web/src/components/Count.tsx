import { type HTMLAttributes, useEffect, useRef } from "react";
import { cx } from "../lib/cx";

let armed = false;

/** Lets counts pop from now on: the startup data arriving isn't news. */
export function armCounts(): void {
  armed = true;
}

interface CountProps extends HTMLAttributes<HTMLSpanElement> {
  value: number | string;
  className: string;
}

/**
 * A count that pops when it changes (or appears, if kept mounted while hidden), but not when its
 * view first renders.
 */
export function Count({ value, className, ...rest }: CountProps) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return (
    <span key={value} className={cx(className, armed && mounted.current && "is-popping")} {...rest}>
      {value}
    </span>
  );
}
