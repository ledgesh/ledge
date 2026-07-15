import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// The shadcn class-merge helper: compose conditional classes, then let
// tailwind-merge resolve conflicts so the last utility wins.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
