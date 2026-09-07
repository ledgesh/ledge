import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// The shadcn class-merge helper: `clsx` joins the class names and drops the
// falsy ones, then `twMerge` resolves conflicting Tailwind utilities so the
// last one wins.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
