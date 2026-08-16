import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Standard shadcn/ui Button. Added by hand rather than via the shadcn CLI because
// Electrobun's non-standard view layout confuses the CLI's framework detection.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        // `-fill`, and the only place in the app that wants it: this is the one
        // control that PAINTS the colour rather than writing in it, so it takes
        // the dark fill that near-white text reads on (index.css). Unchanged
        // from what shadcn ships — the token split moved the value, not this.
        destructive:
          "bg-destructive-fill text-destructive-foreground shadow-sm hover:bg-destructive-fill/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Every size is 44 points on a client with no pointer (interactions.md
      // §1a), written here rather than at the dialogs, the same move MenuItem
      // makes: `sm` is what every dialog's action pair uses — Cancel beside
      // Unlock, beside Change Passphrase, beside Save — and at 28 points those
      // are adjacent alternatives one of which discards what you typed. Fixing
      // it at the control covers the next dialog too, which is the failure mode
      // a list of remembered call sites has.
      //
      // Pixels, not `h-11`: this document's root is `font: 14px`, so a
      // rem-based utility would quietly mean 38.5 (§1a, "write it in pixels").
      // A caller that passes its own size in `className` still wins — twMerge
      // resolves in the caller's favour — which is how the header's buttons
      // stay square.
      size: {
        default: "h-9 px-4 py-2 touch:h-[44px]",
        sm: "h-8 rounded-md px-3 text-xs touch:h-[44px] touch:px-4",
        lg: "h-10 rounded-md px-8 touch:h-[44px]",
        icon: "h-9 w-9 touch:size-[44px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
